-- Globie Earth :: 090 :: the steward's starting grant
--
-- The client has always opened on a starting figure (INITIAL_ECO_TOKENS in
-- src/App.tsx), but it was only ever a placeholder shown before the first
-- ledger read. award_eco_tokens created the balance row at 0, so the first
-- real award replaced the figure instead of adding to it: a steward who
-- claimed 150 leaf tokens for the Father Tree watched their balance fall. The
-- opening figure was never money.
--
-- This file makes it real. The balance row is created holding the grant rather
-- than zero, and the grant itself is appended to the ledger under reason
-- 'welcome', so token_history shows where it came from. Every later award adds
-- to it in the ordinary way, which is what "keeps increasing as the steward
-- earns" requires.
--
-- The grant is per device, matching how the balance table is keyed. An account
-- reads the sum of its devices' rows, so a steward who signs in on two devices
-- holds two grants. That is consistent with the ledger being per device and is
-- left as is rather than inventing an account-keyed row for a figure that is
-- only ever read.
--
-- Two parts, both idempotent: the function below seeds each row as it is
-- created, and the backfill at the end pays the grant to rows created before
-- this file existed, testing the ledger so a second application adds nothing.

-- ------------------------------------------------------- award_eco_tokens ----

-- Body unchanged from 080_account_ownership.sql apart from v_grant and the
-- 'welcome' append: the ownership stamping and the api.users stub stay exactly
-- as they were.
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
  -- Must equal INITIAL_ECO_TOKENS in src/App.tsx. That constant is what the app
  -- shows before the ledger is read, so if the two ever diverge the balance
  -- visibly jumps on the first award.
  v_grant   constant integer := 1010;
  v_device  uuid := private.device_id();
  v_account uuid := private.user_id();
  v_created api.eco_token_balance;
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

  -- A new row opens on the grant. `returning` distinguishes the two outcomes
  -- without relying on FOUND: a device that already has a row re-delivers
  -- nothing, v_created stays null, and no second welcome entry is written.
  insert into api.eco_token_balance (device_id, user_id, balance)
  values (v_device, v_account, v_grant)
  on conflict (device_id) do nothing
  returning * into v_created;

  if v_created.device_id is not null then
    insert into api.eco_token_ledger (
      device_id, user_id, delta, balance_after, reason, source_type, source_id
    ) values (
      v_device, v_account, v_grant, v_grant, 'welcome', 'welcome', null
    );
  end if;

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

-- --------------------------------------- the grant for rows that predate it --

-- A device that already held a balance was created at 0 and so never received
-- the grant. The ledger is the test for "never received it": the welcome entry
-- is written only where no welcome entry exists for that device, so applying
-- this file a second time inserts no balance in the ledger and nothing moves.
with granted as (
  select b.device_id, b.user_id
    from api.eco_token_balance b
   where not exists (
     select 1
       from api.eco_token_ledger l
      where l.device_id = b.device_id
        and l.reason = 'welcome'
   )
),
bumped as (
  update api.eco_token_balance b
     set balance = b.balance + 1010,
         updated_at = now()
    from granted g
   where b.device_id = g.device_id
  returning b.device_id, b.user_id, b.balance
)
insert into api.eco_token_ledger (
  device_id, user_id, delta, balance_after, reason, source_type, source_id
)
select device_id, user_id, 1010, balance, 'welcome', 'welcome', null
  from bumped;

grant execute on function api.award_eco_tokens(integer, text, text, text) to anon;

-- PostgREST caches function signatures; this file is applied by hand rather
-- than by a restart, so ask it to reload.
notify pgrst, 'reload schema';
