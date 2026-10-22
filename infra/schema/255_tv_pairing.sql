-- Globie Earth :: 255 :: Alexa <-> TV pairing, durable
--
-- The Alexa Skill cannot navigate another process on the television: its only
-- directives speak or play audio. So the Skill queues a command and the Vega
-- app long-polls for it (infra/mcp/src/tvCommands.ts). The gate on that relay is
-- a pairing: the TV shows six digits, the listener says them to Alexa, and the
-- binding decides which television an account may drive.
--
-- That binding used to be two Maps in the MCP process. Every redeploy rebuilt
-- the container and silently unpaired every television, which turned a working
-- demo into "open the TV and pair again" after each deploy. This file is the
-- durable copy.
--
-- Two tables, because the two lifetimes differ:
--
--   api.tv_pairing_codes  a short-lived claim ticket (5 minutes), one per TV,
--                         single use. Never read through PostgREST.
--   api.tv_pairings       the binding itself, one row per TV and one per Alexa
--                         account (both unique), so re-pairing moves the
--                         binding instead of leaving two accounts on one TV.
--
-- A pairing row is visible to *two* device ids, which is why the policy below
-- is not the usual owner-only `device_id = private.device_id()`: either side
-- may read the row, neither may write it. Writes happen only through the two
-- SECURITY DEFINER functions, where the claim is a single atomic DELETE ...
-- RETURNING on the code - that is what keeps the ticket single use even if two
-- utterances arrive at once.

create table if not exists api.tv_pairings (
  -- One television: the Vega app's X-Device-Id.
  tv_device_id    uuid primary key,
  -- One Alexa account: the Skill's derived device id (alexa.ts: deviceIdFor).
  alexa_device_id uuid not null unique,
  paired_at       timestamptz not null default now()
);

comment on table api.tv_pairings is
  'Durable Alexa <-> TV binding for the Vega command relay. Either device id may read the row; only the SECURITY DEFINER functions in 255_tv_pairing.sql write it. Replaces the in-memory maps that a redeploy wiped.';

create table if not exists api.tv_pairing_codes (
  code         text primary key,             -- six digits, leading zero allowed (it is spoken)
  tv_device_id uuid not null unique,         -- one live code per television
  expires_at   timestamptz not null
);

comment on table api.tv_pairing_codes is
  'Single-use six-digit pairing ticket shown on a Globie Earth TV. Claimed atomically by api.tv_claim_pairing(text); never readable through PostgREST.';

create index if not exists tv_pairing_codes_expires_at_idx
  on api.tv_pairing_codes (expires_at);

-- ------------------------------------------------------------------- RLS ----

-- A pairing belongs to both ends of the relay, so either may read it: the TV
-- needs to know it is paired (the poll route's `paired` flag) and the Skill
-- needs to resolve its television. Neither may insert, update or delete - a
-- direct write would let a caller bind itself to a TV it never showed a code
-- on. The functions below run as the migration role and are the only writers.
alter table api.tv_pairings enable row level security;

drop policy if exists tv_pairings_read on api.tv_pairings;
create policy tv_pairings_read on api.tv_pairings
  for select to anon
  using (
    tv_device_id = private.device_id()
    or alexa_device_id = private.device_id()
  );

revoke insert, update, delete on api.tv_pairings from anon;
grant select on api.tv_pairings to anon;

-- Codes are claim tickets, not data: nothing but the claim function may touch
-- them, so RLS is left enabled with no policy at all and every privilege is
-- revoked from the API roles.
alter table api.tv_pairing_codes enable row level security;
revoke all on api.tv_pairing_codes from anon;

-- Some deployments are plain Postgres + PostgREST and have no `authenticated`
-- role; revoking from a missing role aborts the migration.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on api.tv_pairing_codes from authenticated';
  end if;
end;
$$;

-- ------------------------------------------------------- issue a TV code ----

-- Called by the TV's pairing screen. Returns the six digits and their expiry.
-- Re-requesting replaces the caller's previous code: a code the screen no
-- longer shows must not stay claimable.
create or replace function api.tv_issue_pairing_code()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_tv      uuid := private.device_id();
  v_code    text;
  v_expires timestamptz := now() + interval '5 minutes';
begin
  if v_tv is null then
    raise exception 'pairing needs an X-Device-Id header' using errcode = '28000';
  end if;

  -- Alias, not a bare `expires_at`: the RETURNS TABLE column has the same
  -- name, and PL/pgSQL would call the reference ambiguous.
  delete from api.tv_pairing_codes c
   where c.expires_at <= now()
      or c.tv_device_id = v_tv;

  -- A million codes and a handful live at once, so a collision is rare - but
  -- "rare" is not "never", and the primary key is what makes the ticket unique.
  for attempt in 1..20 loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into api.tv_pairing_codes (code, tv_device_id, expires_at)
      values (v_code, v_tv, v_expires);
      return query select v_code, v_expires;
      return;
    exception when unique_violation then
      null; -- another television holds that code; draw again
    end;
  end loop;

  raise exception 'no pairing code is available right now'
    using errcode = 'P0001';
end;
$$;

grant execute on function api.tv_issue_pairing_code() to anon;

-- ------------------------------------------------------- claim a TV code ----

-- Called by the Skill for PairTvIntent. The DELETE ... RETURNING is the claim:
-- one statement, so exactly one caller can consume a code even if two arrive
-- together. Returns the television that was bound, or null for an unknown or
-- expired code.
--
-- Both directions of the old binding are removed first, mirroring the maps this
-- replaced: repairing an Alexa account moves it off its previous TV, and
-- repairing a TV evicts the account that held it, so there is never more than
-- one account able to drive a television.
create or replace function api.tv_claim_pairing(p_code text)
returns uuid
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_alexa uuid := private.device_id();
  v_tv    uuid;
begin
  if v_alexa is null then
    raise exception 'pairing needs an X-Device-Id header' using errcode = '28000';
  end if;

  delete from api.tv_pairing_codes
   where code = p_code
     and expires_at > now()
  returning tv_device_id into v_tv;

  if v_tv is null then
    return null;
  end if;

  delete from api.tv_pairings
   where alexa_device_id = v_alexa
      or tv_device_id = v_tv;

  insert into api.tv_pairings (tv_device_id, alexa_device_id)
  values (v_tv, v_alexa);

  return v_tv;
end;
$$;

grant execute on function api.tv_claim_pairing(text) to anon;

-- PostgREST caches the schema and this file is applied by hand, so ask it to
-- re-read or the first call answers PGRST205 ("Could not find the table
-- 'api.tv_pairings' in the schema cache").
notify pgrst, 'reload schema';
