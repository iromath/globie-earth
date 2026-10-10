-- Globie Earth :: 080 :: row ownership for signed-in accounts
--
-- 070_accounts.sql added a user_id column and an _account policy to every
-- table that can belong to an account, but nothing ever wrote the column. The
-- reason is structural, not an oversight in one call site: every row-creating
-- path for those tables runs inside a SECURITY DEFINER function (or, for
-- guardian_pledges, is written by the client), and the functions derive the
-- owner from private.device_id() alone and bypass RLS entirely. A policy
-- cannot repair a row that no writer ever stamps, so the stamping has to
-- happen where the row is created.
--
-- This file does exactly that, and widens the one read that was hard
-- device-scoped:

--   * api.create_adoption      -> stamps user_id on adoptions and living_deeds
--   * api.award_eco_tokens     -> stamps user_id on the balance row and the
--                                 ledger append, and adopts an unowned
--                                 balance row the first time its device is
--                                 used by a signed-in caller
--   * api.token_history        -> union of the device's ledger and the
--                                 account's ledger, matching the union the
--                                 policies already give the table itself
--
-- The two writers also materialise the api.users row their stamp points at.
-- Every user_id column has a foreign key into that table, it is a client-side
-- mirror written at sign-in, and that write is not ordered against a purchase,
-- so without the stub a signed-in adoption could fail where a device-only one
-- succeeds.
--
-- Everything here is additive and idempotent, the same contract as 070: a
-- request carrying only X-Device-Id writes byte-for-byte the same rows it
-- writes today, and sees exactly the days it sees today. A request that also
-- carries a token gets its rows tagged, so the _account policies in
-- 070_accounts.sql finally match something.
--
-- Rows written before this file was applied keep user_id null and stay
-- visible to their device only. There is no way to attribute them to an
-- account after the fact: a device is not a user, and the ledger is
-- append-only by design, so this is a forward-only backfill. Signing in on a
-- device that adopted while signed out re-adopts nothing, and its existing
-- deeds appear in the passport once the same device reads them (the device
-- policy still matches) - they simply do not follow the account to a second
-- browser.

-- ------------------------------------------- create_adoption stamps account --

-- Body unchanged from 040_functions.sql apart from v_account and the two
-- inserts: the dedupe key stays device-scoped, because a replay is only ever
-- re-delivered to the device that made the purchase.
create or replace function api.create_adoption(
  p_species_id        text,
  p_rc_product_id     text default null,
  p_rc_transaction_id text default null,
  p_quantity          integer default 1
) returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device   uuid := private.device_id();
  v_account  uuid := private.user_id();
  v_qty      integer := greatest(1, least(coalesce(p_quantity, 1), 1000));
  v_species  api.species;
  v_adoption api.adoptions;
  v_deed     api.living_deeds;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;

  -- Every user_id column carries a foreign key into api.users, and that table
  -- is a mirror the client writes at sign-in (ensureAccount in src/lib/api.ts).
  -- That write is fire-and-forget, so a purchase can reach this function first,
  -- and a missing row would turn an adoption made while signed in into a hard
  -- failure where the very same call without a token succeeds. The stub is
  -- keyed by the verified sub claim alone; the client's upsert fills in the
  -- profile columns when it lands.
  if v_account is not null then
    insert into api.users (id) values (v_account) on conflict (id) do nothing;
  end if;

  select * into v_species from api.species s where s.id = p_species_id;
  if not found then
    raise exception 'Unknown species %', p_species_id using errcode = '23503';
  end if;

  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  -- A store transaction can be delivered again by the RevenueCat SDK (restore,
  -- retry, or a CustomerInfo refresh). Hand back the adoption that transaction
  -- already produced rather than minting a second deed and a second batch of
  -- eco-tokens; `replayed` tells the caller no new tokens are owed.
  --
  -- The key includes species_id because one transaction can legitimately cover
  -- several species: a supporter tier plants both kae-na and yang-na against a
  -- single payment, so a per-transaction key alone would dedupe the second
  -- species into a replay of the first.
  insert into api.adoptions (
    device_id, user_id, species_id, pledge_thb, pledge_usd, rc_product_id, rc_transaction_id
  ) values (
    v_device, v_account, v_species.id, v_species.pledge_thb * v_qty,
    v_species.pledge_usd * v_qty, p_rc_product_id, p_rc_transaction_id
  )
  on conflict (device_id, rc_transaction_id, species_id)
    where rc_transaction_id is not null
  do nothing
  returning * into v_adoption;

  if v_adoption.id is null then
    -- Either this is a replay, or a concurrent delivery won the insert race.
    select * into v_adoption
      from api.adoptions
     where device_id = v_device
       and species_id = v_species.id
       and rc_transaction_id = p_rc_transaction_id;

    select * into v_deed from api.living_deeds where adoption_id = v_adoption.id;

    return jsonb_build_object(
      'adoption', to_jsonb(v_adoption),
      'deed',     to_jsonb(v_deed),
      'replayed', true
    );
  end if;

  insert into api.living_deeds (
    adoption_id, device_id, user_id, stages, stage_index, trees_planted
  ) values (
    v_adoption.id, v_device, v_account, v_species.stages, 0, v_qty
  )
  returning * into v_deed;

  update api.species s
     set adopted_count = s.adopted_count + v_qty
   where s.id = v_species.id;

  return jsonb_build_object(
    'adoption', to_jsonb(v_adoption),
    'deed',     to_jsonb(v_deed),
    'replayed', false
  );
end;
$$;

-- ------------------------------------------------------- award_eco_tokens ----

-- Body unchanged from 040_functions.sql apart from v_account and the two
-- inserts. The balance row stays keyed by device_id: a device is what earns
-- and spends, and an account's figure is the sum of its devices' rows, which
-- the client reads as one number. Adding an account-keyed row instead would
-- need a second row per account and a second upsert path, for a figure that
-- is only ever read.
create or replace function api.award_eco_tokens(
  p_delta       integer,
  p_reason      text,
  p_source_type text default null,
  p_source_id   text default null
) returns api.eco_token_balance
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_account uuid := private.user_id();
  v_balance api.eco_token_balance;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;

  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  -- Same reason as in create_adoption: the balance and ledger rows below carry
  -- a foreign key into api.users, and the client's mirror write is not ordered
  -- against this call.
  if v_account is not null then
    insert into api.users (id) values (v_account) on conflict (id) do nothing;
  end if;

  insert into api.eco_token_balance (device_id, user_id, balance)
  values (v_device, v_account, 0)
  on conflict (device_id) do nothing;

  -- The coalesce adopts an unowned row the first time its device awards
  -- tokens for a signed-in caller. It never reassigns a row that already has
  -- an owner, so a device that two accounts have used stays with the first.
  update api.eco_token_balance b
     set balance = b.balance + p_delta,
         user_id = coalesce(b.user_id, v_account),
         updated_at = now()
   where b.device_id = v_device
  returning * into v_balance;

  if v_balance.balance < 0 then
    raise exception 'Insufficient eco-token balance' using errcode = '23514';
  end if;

  insert into api.eco_token_ledger (
    device_id, user_id, delta, balance_after, reason, source_type, source_id
  ) values (
    v_device, v_account, p_delta, v_balance.balance, p_reason, p_source_type, p_source_id
  );

  return v_balance;
end;
$$;

-- ------------------------------------------------------------ token_history --

-- 050_history.sql filtered on the device alone, so the passport on a second
-- browser showed no history at all even for an account that had earned tokens.
-- A row is counted once whichever branch matches it. For a device-only caller
-- private.user_id() is null, `l.user_id = null` is never true, and the
-- predicate collapses to exactly the clause it replaced.
create or replace function api.token_history(p_days integer default 30)
returns table (
  day        timestamptz,
  net_tokens integer,
  entries    bigint
)
language sql
stable
security definer
set search_path = api, private, public
as $$
  select date_trunc('day', l.created_at)        as day,
         sum(l.delta)::integer                  as net_tokens,
         count(*)                               as entries
  from api.eco_token_ledger l
  where (l.device_id = private.device_id() or l.user_id = private.user_id())
    and l.created_at >= now()
        - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
  group by 1
  order by 1 desc
$$;

grant execute on function api.create_adoption(text, text, text, integer) to anon;
grant execute on function api.award_eco_tokens(integer, text, text, text) to anon;
grant execute on function api.token_history(integer) to anon;

-- PostgREST caches function signatures; this file is applied by hand rather
-- than by a restart, so ask it to reload.
notify pgrst, 'reload schema';
