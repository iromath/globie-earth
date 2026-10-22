-- Globie Earth :: 257 :: Challenge rooms, durable
--
-- A family quiz lasts one evening, so Phase A kept its room in a Map beside the
-- game session (infra/mcp/src/challenge.ts). An invitation does not: household
-- one plays tonight, household two enters the code tomorrow, and a redeploy in
-- between must lose nothing. This file is the durable copy, and
-- infra/mcp/src/challengeStore.ts is the only module that reads or writes it.
--
-- Two tables, the same split as 255:
--
--   api.challenge_rooms    the room, its frozen deck (answer keys included -
--                          the deck is frozen precisely so both households see
--                          the identical questions, and only the relay reads
--                          the keys, never a television).
--   api.challenge_members  slot 1..8, name, team and the running score.
--
-- Round state - index, clock, this round's answers, whether the award has run -
-- lives on the room row because Phase A advances a whole room at a time and a
-- room is written by exactly one host device. The per-answer uniqueness Phase C
-- needs is a different table, and is added with that phase's routes.
--
-- Writes are SECURITY DEFINER functions only, exactly like 255 and 256: an anon
-- caller may not insert a room, a member row or a score of its own choosing.
-- Reads are scoped by RLS to the host and the members.

create table if not exists api.challenge_rooms (
  room_id          uuid primary key,
  -- Six digits, the only thing a player has to type. Unique while the room
  -- exists - see the index note below.
  code             text not null check (code ~ '^[0-9]{6}$'),
  -- The television that opened the room and is paid for it.
  host_device_id   uuid not null,
  -- Content hash of the rounds, so Phase B can prove two households played the
  -- same deck (challenge.ts derives it with sha256).
  deck_id          text not null,
  deck             jsonb not null,
  phase            text not null check (phase in ('lobby', 'playing', 'standings', 'finished')),
  round_index      smallint not null default 0 check (round_index >= 0),
  -- The scoring clock. Null until the first question is pushed.
  round_started_at timestamptz,
  -- slot -> choice key, for the current round only.
  round_answers    jsonb not null default '{}'::jsonb,
  -- The payout flag, kept beside the room so a replayed finish still answers
  -- the same award. The ledger's (device_id, award_key) is the real guard.
  awarded          boolean not null default false,
  last_award       jsonb,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null
);

comment on table api.challenge_rooms is
  'Durable challenge rooms: the frozen deck, the round clock and the payout flag. Written only by api.challenge_save; readable by the host and the members through RLS.';

create table if not exists api.challenge_members (
  room_id   uuid not null references api.challenge_rooms (room_id) on delete cascade,
  slot      smallint not null check (slot between 1 and 8),
  -- Null in Phase A, where every slot shares the host television.
  device_id uuid,
  name      text not null check (char_length(name) between 1 and 16),
  team      smallint not null default 0 check (team in (0, 1)),
  score     int not null default 0,
  streak    int not null default 0,
  correct   int not null default 0,
  -- roundId -> choice, for the rounds this slot has answered. Phase A's live
  -- party is ordered by the room clock and clears it per round; a Phase B
  -- household plays the frozen deck on its own time, so the history is what
  -- stops a second press on the same question from scoring twice.
  answered  jsonb not null default '{}'::jsonb,
  joined_at timestamptz not null default now(),
  primary key (room_id, slot)
);

-- The file is applied by hand against a live table, so the column is also
-- added here for the database that already ran the first version.
alter table api.challenge_members
  add column if not exists answered jsonb not null default '{}'::jsonb;

-- Phase C: a phone joins with six digits and leaves with a token. The token is
-- the credential every later answer presents, so it is the row's secret - the
-- room compositor deliberately never returns it, and challenge_deck_by_code
-- (which has no membership rule) cannot read it at all.
alter table api.challenge_members
  add column if not exists player_token uuid;

-- A late answer still scores for accuracy, so the podium has to be able to say
-- why a seat's total is low. The relay counts it (challenge.ts) and the count
-- is kept here so a restart does not turn a slow uplink into a wrong answer.
alter table api.challenge_members
  add column if not exists late_answers int not null default 0;

create unique index if not exists challenge_members_token_key
  on api.challenge_members (player_token)
  where player_token is not null;

comment on table api.challenge_members is
  'One row per player slot in a challenge room. device_id is null in Phase A; Phase B/C fill it so a household can be paid on its own device. player_token authorises a phone that joined with the six digits.';

-- Phase C's per-round uniqueness: (room, round, slot) is claimed before the
-- relay scores an answer, so a retry, a double tap or two concurrent requests
-- cannot score twice. A check-then-write in the route would lose that race.
create table if not exists api.challenge_answers (
  room_id    uuid not null references api.challenge_rooms (room_id) on delete cascade,
  round_id   text not null,
  slot       smallint not null check (slot between 1 and 8),
  choice     text not null,
  created_at timestamptz not null default now(),
  primary key (room_id, round_id, slot)
);

alter table api.challenge_answers enable row level security;
revoke insert, update, delete on api.challenge_answers from anon;
grant select on api.challenge_answers to anon;

create index if not exists challenge_rooms_expires_at_idx
  on api.challenge_rooms (expires_at);

-- The plan wanted `unique (code) where expires_at > now()`. Postgres refuses
-- that: a partial index predicate must be IMMUTABLE and now() is STABLE, so the
-- index would never be created. Uniqueness is therefore plain, and expiry is
-- enforced by deleting dead rooms inside api.challenge_save before it inserts
-- one - the same moment a code could otherwise be reused. With one writer
-- (the relay) the digits are recycled exactly when their room stops existing.
create unique index if not exists challenge_rooms_code_key
  on api.challenge_rooms (code);

-- ------------------------------------------------------------------- RLS ----

-- A room is visible to its host and to the devices that joined it. There is
-- deliberately no insert/update/delete policy: a caller that can write a score
-- can award itself tokens, which is what 256 exists to prevent.
alter table api.challenge_rooms enable row level security;

drop policy if exists challenge_rooms_read on api.challenge_rooms;
create policy challenge_rooms_read on api.challenge_rooms
  for select to anon
  using (
    host_device_id = private.device_id()
    or exists (
      select 1
        from api.challenge_members m
       where m.room_id = challenge_rooms.room_id
         and m.device_id = private.device_id()
    )
  );

revoke insert, update, delete on api.challenge_rooms from anon;
grant select on api.challenge_rooms to anon;

-- Member rows are private to the device that holds the slot. The host reads
-- the whole room through api.challenge_state() instead, which avoids a policy
-- that would query api.challenge_rooms from inside api.challenge_rooms' policy.
alter table api.challenge_members enable row level security;

drop policy if exists challenge_members_read on api.challenge_members;
create policy challenge_members_read on api.challenge_members
  for select to anon
  using (device_id = private.device_id());

revoke insert, update, delete on api.challenge_members from anon;
grant select on api.challenge_members to anon;

-- Some deployments are plain Postgres + PostgREST and have no `authenticated`
-- role; revoking from a missing role aborts the migration.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on api.challenge_rooms from authenticated';
    execute 'revoke insert, update, delete on api.challenge_members from authenticated';
  end if;
end;
$$;

-- --------------------------------------------------- the room as one value ----

-- Composes the whole room, exactly the shape challengeStore.ts hydrates. The
-- filter is the access rule: a live room, and only for its host or a member.
--
-- Internal: revoked from the API roles below. The readers call it, so an
-- anon caller cannot ask for an arbitrary room by id.
--
-- p_token is Phase C's second membership proof: a phone that joined with the
-- six digits presents the token it was given, and the row it names is its
-- seat. It is never echoed back - only the membership test reads it.
--
-- p_open is for api.challenge_by_code only: the six digits on the television
-- are the invitation, and the caller reading a room by them is precisely the
-- caller that has no seat yet. It is not reachable from the API - this
-- function is revoked from anon below.
drop function if exists api.challenge_by_code(text);
drop function if exists api.challenge_by_token(uuid);
drop function if exists api.challenge_state(uuid, uuid);
drop function if exists api.challenge_state(uuid);

create or replace function api.challenge_state(
  p_room_id uuid,
  p_token   uuid    default null,
  p_open    boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path = api, public
as $$
  select jsonb_build_object(
    'roomId',         r.room_id,
    'code',           r.code,
    'phase',          r.phase,
    'deckId',         r.deck_id,
    'deck',           r.deck,
    'hostDeviceId',   r.host_device_id,
    'players',        coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'slot',     m.slot,
                 'name',     m.name,
                 'team',     m.team,
                 'score',    m.score,
                 'streak',   m.streak,
                 'correct',  m.correct,
                 'lateAnswers', m.late_answers,
                 'deviceId', m.device_id,
                 'answered', coalesce(m.answered, '{}'::jsonb)
               )
               order by m.slot
             )
        from api.challenge_members m
       where m.room_id = r.room_id
      ), '[]'::jsonb),
    'roundIndex',     r.round_index,
    'roundStartedAt', coalesce((extract(epoch from r.round_started_at) * 1000)::bigint, 0),
    'roundAnswers',   r.round_answers,
    'expiresAt',      (extract(epoch from r.expires_at) * 1000)::bigint,
    'awarded',        r.awarded,
    'lastAward',      r.last_award
  )
    from api.challenge_rooms r
   where r.room_id = p_room_id
     and r.expires_at > now()
     and (
       p_open
       or r.host_device_id = private.device_id()
       or exists (
         select 1
           from api.challenge_members m
          where m.room_id = r.room_id
            and (m.device_id = private.device_id() or m.player_token = p_token)
       )
     );
$$;

revoke execute on function api.challenge_state(uuid, uuid, boolean) from public;
revoke execute on function api.challenge_state(uuid, uuid, boolean) from anon;

-- ------------------------------------------------------------ write a room ----

-- The one write path: the host television sends the whole room, and this
-- function upserts the row and reconciles its members. Whole-state writes match
-- the pushes the television already receives, so a retry cannot half-apply.
--
-- The caller must be the host named in the payload. Phase A has a single
-- writer per room; Phase B's cross-household join and answer get their own
-- atomic functions with those routes, rather than a second meaning for this
-- one.
create or replace function api.challenge_save(p_room jsonb)
returns void
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_room    uuid := (p_room->>'roomId')::uuid;
  v_host    uuid := (p_room->>'hostDeviceId')::uuid;
  v_players jsonb := coalesce(p_room->'players', '[]'::jsonb);
  v_rows    integer;
begin
  if v_device is null then
    raise exception 'a challenge needs an X-Device-Id header' using errcode = '28000';
  end if;

  if v_host <> v_device then
    raise exception 'only the host device may write a challenge room' using errcode = '42501';
  end if;

  -- Expired rooms release their six digits here, because the code index is
  -- plain-unique (see the note above the index). This is also the table's only
  -- cleanup: a room nobody touches again simply disappears on the next write.
  delete from api.challenge_rooms r where r.expires_at <= now();

  insert into api.challenge_rooms (
    room_id, code, host_device_id, deck_id, deck, phase,
    round_index, round_started_at, round_answers, awarded, last_award, expires_at
  )
  values (
    v_room,
    p_room->>'code',
    v_host,
    p_room->>'deckId',
    p_room->'deck',
    p_room->>'phase',
    coalesce((p_room->>'roundIndex')::smallint, 0),
    case
      when coalesce((p_room->>'roundStartedAt')::bigint, 0) > 0
        then to_timestamp((p_room->>'roundStartedAt')::double precision / 1000.0)
    end,
    coalesce(p_room->'roundAnswers', '{}'::jsonb),
    coalesce((p_room->>'awarded')::boolean, false),
    p_room->'lastAward',
    to_timestamp((p_room->>'expiresAt')::double precision / 1000.0)
  )
  on conflict (room_id) do update set
    phase            = excluded.phase,
    deck             = excluded.deck,
    round_index      = excluded.round_index,
    round_started_at = excluded.round_started_at,
    round_answers    = excluded.round_answers,
    awarded          = excluded.awarded,
    last_award       = excluded.last_award,
    expires_at       = excluded.expires_at
  where api.challenge_rooms.host_device_id = v_device;

  -- A room id that belongs to another device conflicts, fails the WHERE, and
  -- changes no rows. Silence there would be a write that looks successful and
  -- is not, so say it.
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'room % belongs to another device', v_room using errcode = '42501';
  end if;

  -- A slot removed in the payload is removed here; a slot that is present is
  -- updated in place, so its (room_id, slot) identity never flickers.
  delete from api.challenge_members m
   where m.room_id = v_room
     and not exists (
       select 1
         from jsonb_array_elements(v_players) p
        where (p->>'slot')::smallint = m.slot
     );

  insert into api.challenge_members as m
    (room_id, slot, device_id, name, team, score, streak, correct, late_answers, answered, player_token)
  select
    v_room,
    (p->>'slot')::smallint,
    nullif(p->>'deviceId', '')::uuid,
    p->>'name',
    coalesce((p->>'team')::smallint, 0),
    coalesce((p->>'score')::int, 0),
    coalesce((p->>'streak')::int, 0),
    coalesce((p->>'correct')::int, 0),
    coalesce((p->>'lateAnswers')::int, 0),
    coalesce(p->'answered', '{}'::jsonb),
    nullif(p->>'playerToken', '')::uuid
    from jsonb_array_elements(v_players) p
  on conflict (room_id, slot) do update set
    device_id = excluded.device_id,
    name      = excluded.name,
    team      = excluded.team,
    score     = excluded.score,
    streak    = excluded.streak,
    correct   = excluded.correct,
    late_answers = excluded.late_answers,
    answered  = excluded.answered,
    -- The host television writes the room and never holds a phone's token, so
    -- a payload without one must not clear the seat's credential.
    player_token = coalesce(excluded.player_token, m.player_token);
end;
$$;

grant execute on function api.challenge_save(jsonb) to anon;

-- ------------------------------------------------------------ read a room ----

-- By id: the television re-reading the room it is hosting (a remount, or the
-- first request after a redeploy).
create or replace function api.challenge_load(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
begin
  if v_device is null then
    raise exception 'reading a challenge needs an X-Device-Id header' using errcode = '28000';
  end if;

  return api.challenge_state(p_room_id);
end;
$$;

grant execute on function api.challenge_load(uuid) to anon;

-- By code: the host television resolving the six digits it shows. Membership is
-- re-checked inside api.challenge_state, so a wrong code and a stranger's code
-- answer the same nothing.
--
-- The third argument is what lets a phone join a room this process has never
-- held - after a redeploy, or on a second instance. The caller of a join is by
-- definition not a member yet, and the six digits on screen are the invitation
-- it presents; the membership gate would answer `null` and the seat could never
-- be taken. Every other field is the one challenge_state already exposes to a
-- member, and nothing here returns a seat's player_token.
create or replace function api.challenge_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
  v_room   uuid;
begin
  if v_device is null then
    raise exception 'reading a challenge needs an X-Device-Id header' using errcode = '28000';
  end if;

  select r.room_id
    into v_room
    from api.challenge_rooms r
   where r.code = p_code
     and r.expires_at > now();

  if v_room is null then
    return null;
  end if;

  return api.challenge_state(v_room, null, true);
end;
$$;

grant execute on function api.challenge_by_code(text) to anon;

-- ------------------------------------------------------- read an invitation ----

-- By code, for a household that has not joined yet: the frozen deck, the room's
-- identity and the running standings. This is the one read with no membership
-- rule, because an invitation is exactly the state of not being a member.
--
-- What it does not return is the host's device id. Both households are paid on
-- their own device (Phase B), and neither needs to know the other's.
--
-- The deck carries answer keys: the joining television judges nothing, but it
-- needs the same key the host saw to render the same options in the same order.
-- Preparing the deck is the trust boundary - a client holding a deck could
-- read an answer early - and it is documented in challenge.ts' GET route.
create or replace function api.challenge_deck_by_code(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = api, public
as $$
  select jsonb_build_object(
    'roomId',    r.room_id,
    'code',      r.code,
    'deckId',    r.deck_id,
    'deck',      r.deck,
    'phase',     r.phase,
    'players',   coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'slot',    m.slot,
                 'name',    m.name,
                 'team',    m.team,
                 'score',   m.score,
                 'streak',  m.streak,
                 'correct', m.correct,
                 'lateAnswers', m.late_answers,
                 'answered', coalesce(m.answered, '{}'::jsonb)
               )
               order by m.slot
             )
        from api.challenge_members m
       where m.room_id = r.room_id
      ), '[]'::jsonb),
    'expiresAt', (extract(epoch from r.expires_at) * 1000)::bigint
  )
    from api.challenge_rooms r
   where r.code = p_code
     and r.expires_at > now();
$$;

grant execute on function api.challenge_deck_by_code(text) to anon;

-- --------------------------------------------------------- record an answer ----

-- Phase B's write: one slot's answer, applied by the device that owns it (or by
-- the host television, which reports for its own seats). The points are computed
-- by the relay's one judge, not here, and only the member's own row changes, so
-- two households answering at different times cannot overwrite each other.
--
-- p_token is Phase C's proof for a phone, which has no device identity of its
-- own: the seat's player_token is the whole credential. Without it a phone that
-- answers from a browser other than the one that joined has its claim accepted
-- by challenge_claim and then this update refused, which left an answer row
-- with no score behind it.
drop function if exists api.challenge_record(uuid, smallint, int, int, int, jsonb);
drop function if exists api.challenge_record(uuid, smallint, int, int, int, jsonb, uuid);

create or replace function api.challenge_record(
  p_room_id      uuid,
  p_slot         smallint,
  p_score        int,
  p_streak       int,
  p_correct      int,
  p_answered     jsonb,
  p_token        uuid default null,
  -- Null keeps the stored count, so a caller that predates the column cannot
  -- zero a count another request already wrote.
  p_late_answers int default null
)
returns void
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
  v_rows   integer;
begin
  if v_device is null then
    raise exception 'recording an answer needs an X-Device-Id header' using errcode = '28000';
  end if;

  update api.challenge_members m
     set score    = p_score,
         streak   = p_streak,
         correct  = p_correct,
         late_answers = coalesce(p_late_answers, m.late_answers),
         answered = coalesce(p_answered, '{}'::jsonb)
   where m.room_id = p_room_id
     and m.slot = p_slot
     and (
       m.device_id = v_device
       or (p_token is not null and m.player_token = p_token)
       or exists (
         select 1
           from api.challenge_rooms r
          where r.room_id = p_room_id
            and r.host_device_id = v_device
       )
     );

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'slot % of room % is not this device''s', p_slot, p_room_id
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function api.challenge_record(uuid, smallint, int, int, int, jsonb, uuid, int) to anon;

-- ------------------------------------------------------------- leave a room ----

-- A member leaving frees a seat; the host leaving ends the room and releases the
-- six digits. p_slot null means "the whole room", which only the host may ask
-- for. Rows cascade, so deleting the room deletes its members.
create or replace function api.challenge_leave(p_room_id uuid, p_slot smallint default null)
returns void
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
  v_host   uuid;
  v_owner  uuid;
begin
  if v_device is null then
    raise exception 'leaving a challenge needs an X-Device-Id header' using errcode = '28000';
  end if;

  select r.host_device_id into v_host
    from api.challenge_rooms r
   where r.room_id = p_room_id;

  if v_host is null then
    return;
  end if;

  if p_slot is null then
    if v_host <> v_device then
      raise exception 'only the host device may close a challenge room' using errcode = '42501';
    end if;
    delete from api.challenge_rooms r where r.room_id = p_room_id;
    return;
  end if;

  select m.device_id into v_owner
    from api.challenge_members m
   where m.room_id = p_room_id
     and m.slot = p_slot;

  if v_owner is null then
    return;
  end if;

  if v_host <> v_device and v_owner <> v_device then
    raise exception 'slot % of room % belongs to another device', p_slot, p_room_id
      using errcode = '42501';
  end if;

  delete from api.challenge_members m
   where m.room_id = p_room_id
     and m.slot = p_slot;
end;
$$;

grant execute on function api.challenge_leave(uuid, smallint) to anon;

-- ------------------------------------------------------------- join a room ----

-- Phase B's join: a household that read an invitation by code takes its own
-- seat. The room id came from that read, and the caller's own device id is the
-- only identity written - a joiner never learns or claims the host's.
--
-- Phase C adds the token: a phone gets a UUID back and presents it on every
-- answer. Rejoining with the same device replaces the seat's token, which is
-- the "rotated on rejoin" rule - an old phone cannot answer for a new one.
drop function if exists api.challenge_join(uuid, smallint, text, smallint);

create or replace function api.challenge_join(
  p_room_id uuid,
  p_slot    smallint,
  p_name    text,
  p_team    smallint,
  p_token   uuid default null
)
returns void
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
begin
  if v_device is null then
    raise exception 'joining a challenge needs an X-Device-Id header' using errcode = '28000';
  end if;

  if not exists (
    select 1
      from api.challenge_rooms r
     where r.room_id = p_room_id
       and r.expires_at > now()
  ) then
    raise exception 'room % is not open', p_room_id using errcode = 'P0002';
  end if;

  insert into api.challenge_members as m
    (room_id, slot, device_id, name, team, player_token)
  values (p_room_id, p_slot, v_device, coalesce(p_name, 'Player'), coalesce(p_team, 0), p_token)
  on conflict (room_id, slot) do update set
    device_id    = excluded.device_id,
    name         = excluded.name,
    team         = excluded.team,
    player_token = coalesce(excluded.player_token, m.player_token);
end;
$$;

grant execute on function api.challenge_join(uuid, smallint, text, smallint, uuid) to anon;

-- -------------------------------------------------------- read by token ----
--
-- Phase C's read: the phone holds a token rather than a device id, and the
-- token is the membership proof. Returns the room composed exactly as the
-- television sees it, plus the caller's own slot so the phone can label itself.
create or replace function api.challenge_by_token(p_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = api, public
as $$
declare
  v_room uuid;
  v_slot smallint;
begin
  select m.room_id, m.slot
    into v_room, v_slot
    from api.challenge_members m
   where m.player_token = p_token;

  if v_room is null then
    return null;
  end if;

  return api.challenge_state(v_room, p_token)
      || jsonb_build_object('slot', v_slot);
end;
$$;

grant execute on function api.challenge_by_token(uuid) to anon;

-- --------------------------------------------------------- claim an answer ----
--
-- Phase C's uniqueness: (room, round, slot) is inserted before the relay
-- scores, and a duplicate comes back as `claimed = false`. The token names the
-- seat, so a caller cannot burn another player's round. Points stay in the
-- relay's one judge; this table is only the tie-breaker.
create or replace function api.challenge_claim(
  p_token    uuid,
  p_round_id text,
  p_choice   text
)
returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_room   uuid;
  v_slot   smallint;
  v_rows   integer;
begin
  select m.room_id, m.slot
    into v_room, v_slot
    from api.challenge_members m
   where m.player_token = p_token;

  if v_room is null then
    return jsonb_build_object('claimed', false, 'reason', 'no_token');
  end if;

  if not exists (
    select 1
      from api.challenge_rooms r
     where r.room_id = v_room
       and r.expires_at > now()
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'room_closed');
  end if;

  insert into api.challenge_answers (room_id, round_id, slot, choice)
  values (v_room, p_round_id, v_slot, p_choice)
  on conflict (room_id, round_id, slot) do nothing;

  get diagnostics v_rows = row_count;

  return jsonb_build_object(
    'claimed', v_rows > 0,
    'roomId',  v_room,
    'slot',    v_slot
  );
end;
$$;

grant execute on function api.challenge_claim(uuid, text, text) to anon;

-- PostgREST caches the schema and this file is applied by hand, so ask it to
-- re-read or the first call answers PGRST202 ("Could not find the function
-- api.challenge_save(p_room) in the schema cache").
notify pgrst, 'reload schema';
