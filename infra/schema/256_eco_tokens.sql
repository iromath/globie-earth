-- Globie Earth :: 256 :: Eco tokens, the durable reward wallet
--
-- A game can award tokens, and the total has to survive a restart. Keeping the
-- balance on the television (AsyncStorage) was the first sketch, but the same
-- viewer plays on the Echo and on a second TV, so a per-device counter would
-- report a different number on every screen. The balance therefore lives here,
-- keyed by the caller's X-Device-Id, which is the identity every route in
-- infra/mcp already resolves (identity.ts).
--
-- Awarding is a ledger, not an increment. Each award carries a key the game
-- derives from what happened ("memory:<session>:<pair>", "quiz:<deckId>"), and
-- (device_id, award_key) is the primary key. A retried POST, a re-render, or a
-- rematch that replays the same key credits the viewer once. An increment on a
-- single balance column cannot express that: it is not idempotent, so a flaky
-- network silently mints tokens.
--
-- The ledger is read-only through PostgREST for its own device, and written
-- only by api.eco_award, which is SECURITY DEFINER - the same shape as the
-- pairing functions in 255_tv_pairing.sql, and for the same reason: an anon
-- caller may not insert a row (and therefore a balance) of its own choosing.

create table if not exists api.eco_ledger (
  -- The owner: the Vega app's X-Device-Id, or the Skill's derived device id.
  device_id  uuid not null,
  -- What was rewarded. Chosen by the game, unique per device, bounded so it
  -- stays an identifier rather than a payload.
  award_key  text not null check (length(award_key) between 1 and 120),
  -- Positive only: corrections, if ever needed, are a separate award.
  amount     integer not null check (amount between 1 and 500),
  created_at timestamptz not null default now(),
  primary key (device_id, award_key)
);

comment on table api.eco_ledger is
  'Append-only eco-token awards. (device_id, award_key) makes api.eco_award idempotent, so a retried match cannot mint tokens. Readable by its own device through PostgREST; written only by api.eco_award.';

create index if not exists eco_ledger_device_created_idx
  on api.eco_ledger (device_id, created_at desc);

-- ------------------------------------------------------------------- RLS ----

-- A wallet is private to the device that earned it. There is deliberately no
-- insert/update/delete policy: a balance a caller can write is not a reward.
alter table api.eco_ledger enable row level security;

drop policy if exists eco_ledger_read on api.eco_ledger;
create policy eco_ledger_read on api.eco_ledger
  for select to anon
  using (device_id = private.device_id());

revoke insert, update, delete on api.eco_ledger from anon;
grant select on api.eco_ledger to anon;

-- Some deployments are plain Postgres + PostgREST and have no `authenticated`
-- role; revoking from a missing role aborts the migration.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on api.eco_ledger from authenticated';
  end if;
end;
$$;

-- --------------------------------------------------------------- balance ----

-- The number the reward popup prints. `coalesce` because a new device has no
-- rows yet, and the app should read 0 rather than null on its first match.
create or replace function api.eco_balance()
returns integer
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_balance integer;
begin
  if v_device is null then
    raise exception 'the eco wallet needs an X-Device-Id header' using errcode = '28000';
  end if;

  select coalesce(sum(l.amount), 0)::integer
    into v_balance
    from api.eco_ledger l
   where l.device_id = v_device;

  return v_balance;
end;
$$;

grant execute on function api.eco_balance() to anon;

-- ---------------------------------------------------------------- award ----

-- Credits one award and returns the resulting balance, plus how much this call
-- actually added.
--
-- `awarded` is the part the popup must not lie about: on a duplicate key it is
-- 0 and the balance is unchanged, so a replayed match shows "+0" (or nothing)
-- instead of pretending to pay twice. `on conflict do nothing ... returning`
-- is a single statement, so two simultaneous retries cannot both credit.
create or replace function api.eco_award(p_key text, p_amount integer)
returns table (balance integer, awarded integer)
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_awarded integer := 0;
  v_balance integer;
begin
  if v_device is null then
    raise exception 'the eco wallet needs an X-Device-Id header' using errcode = '28000';
  end if;

  insert into api.eco_ledger (device_id, award_key, amount)
  values (v_device, p_key, p_amount)
  on conflict (device_id, award_key) do nothing
  returning amount into v_awarded;

  v_awarded := coalesce(v_awarded, 0);

  select coalesce(sum(l.amount), 0)::integer
    into v_balance
    from api.eco_ledger l
   where l.device_id = v_device;

  return query select v_balance, v_awarded;
end;
$$;

grant execute on function api.eco_award(text, integer) to anon;

-- PostgREST caches the schema and this file is applied by hand, so ask it to
-- re-read or the first call answers PGRST202 ("Could not find the function
-- api.eco_award(...) in the schema cache").
notify pgrst, 'reload schema';
