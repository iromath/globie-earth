-- Globie Earth :: 251 :: a steward is told when something happens to their work
--
-- Everything the app already records is silent. A device's photograph is voted
-- on, a comment lands in its thread, a credit is paid into its ledger, and the
-- only way to find any of it out is to reopen the right screen and look. This
-- migration adds the one table that turns those events into a record a person
-- can be shown - and the one table that says how and how often they want to be
-- told.
--
-- What this file is NOT. It records and reads; it delivers nothing. The MCP
-- stream that watches for new rows (2c) and the OneSignal sender that wakes a
-- closed app (2d) are separate, and neither is a concern of a migration. The
-- i18n too lives elsewhere: title_key names a message and body_params fills it
-- in, so a row stores what happened, not a rendered sentence in one language.
-- A daily digest is likewise not decided here - this file stores one row per
-- event, and the writer (2b) decides whether any of them coalesce.
--
-- Two deliberate choices worth naming:
--
--   * ledger_id is the ledger's OWN id, a bigint, not the uuid the plan
--     sketched. api.eco_token_ledger.id is a `bigserial`
--     (020_tables.sql), so a foreign key can only be bigint, and it is the
--     points case's idempotency key: unique (recipient_device_id, kind,
--     ledger_id) means one credit - one ledger row - can raise at most one
--     points_awarded alert, however many times the credit path is replayed.
--     Postgres treats NULLs as distinct in a unique constraint, so the other
--     five kinds - which carry no ledger id - are never collided by it.
--   * A notification names a recipient DEVICE, because the device UUID is this
--     app's identity (030_rls.sql). recipient_user_id is stamped alongside for
--     a signed-in caller, so a web account reads the alerts earned on every
--     device it signs in on, and it is the one column that survives that
--     device being forgotten.
--
-- Following 238 (the comments thread), both tables are closed: RLS is on, the
-- 010_bootstrap default grant is taken back, and NO anon policy is created, so
-- the tables are unreachable even to a header-less caller. Every read and write
-- is through a SECURITY DEFINER function scoped to private.device_id() and
-- private.user_id(), which is also what keeps one steward's alerts out of
-- another's payload.
--
-- Depends on 220 (api.species_contributions), 238 (api.contribution_comments),
-- 232 (api.eco_token_ledger) and 070 (api.users, private.user_id()). Apply
-- those first.

-- ------------------------------------------------------------ the alerts ----

create table if not exists api.notifications (
  id                  uuid primary key default gen_random_uuid(),
  -- The credential the whole app turns on: the device an alert belongs to.
  recipient_device_id uuid not null references api.devices(id) on delete cascade,
  -- The signed-in account, when there was one. Denormalised from the device so
  -- a web reader can find its alerts without having to know every device id.
  recipient_user_id   uuid references api.users(id) on delete set null,
  kind                text not null
                      check (kind in (
                        'discussion_message', 'question', 'points_awarded',
                        'media_approved', 'media_rejected', 'media_pending'
                      )),
  -- What the alert is about. Both are optional because kind varies: a points
  -- alert names a ledger row and nothing else, a thread alert names a
  -- contribution, a frame and the comment that caused it.
  contribution_id     uuid references api.species_contributions(id) on delete cascade,
  frame_key           text,
  comment_id          uuid references api.contribution_comments(id) on delete set null,
  -- The points case's idempotency key: the ledger row that paid. See the header
  -- - it is a bigint because api.eco_token_ledger.id is a bigserial.
  ledger_id           bigint references api.eco_token_ledger(id) on delete set null,
  -- What to say, not what was said: the message's name and the values that fill
  -- it, rendered in the reader's language at the edge.
  title_key           text not null,
  body_params         jsonb not null default '{}'::jsonb,
  -- Free-form extras a route may need to link back (a link, a species name).
  -- Kept apart from body_params so a change to copy never moves routing data.
  payload             jsonb not null default '{}'::jsonb,
  read_at             timestamptz,
  created_at          timestamptz not null default now(),
  -- One credit, one alert. A replay of the credit path that reuses the same
  -- ledger row collides here instead of doubling the alert (R2.3).
  constraint notifications_points_once unique (recipient_device_id, kind, ledger_id)
);

comment on table api.notifications is
  'One alert for one recipient device: an event that happened to that device''s work (a thread message, a points credit, an approval verdict). Written only by private.emit_notification (2b); read only through api.my_notifications(), which is scoped to the caller''s own device and account.';

-- The recipient's feed, newest first - the read api.my_notifications() is built
-- on.
create index if not exists notifications_recipient_idx
  on api.notifications (recipient_device_id, created_at desc);

-- The same feed for a signed-in account reading across its devices (070 adds
-- this partial shape for every account-scoped table).
create index if not exists notifications_recipient_user_idx
  on api.notifications (recipient_user_id, created_at desc)
  where recipient_user_id is not null;

alter table api.notifications enable row level security;

-- 010_bootstrap.sql granted anon insert, update and delete on every new api
-- table by default, and the default select too. All four are taken back: every
-- read and write here is through a SECURITY DEFINER function, so the table is
-- reached by nobody directly - which is also what keeps one steward's alerts
-- out of another's feed. No anon policy is created, so with RLS on and no grant
-- the table is closed even to a header-less caller (238's rule).
revoke all on api.notifications from anon;

-- --------------------------------------------------------- reading them -----

-- The caller's own alerts, newest first. SECURITY DEFINER, so it reads the
-- closed table, and it matches on the caller's device OR their account, so a
-- signed-in reader sees the alerts earned on every device they have used.
-- p_since is the SSE replay cursor (2c.1): a reconnecting client passes the
-- last id's timestamp and receives only what it missed.
create or replace function api.my_notifications(
  p_since timestamptz default null,
  p_limit integer     default 50
) returns table (
  id              uuid,
  kind            text,
  contribution_id uuid,
  frame_key       text,
  comment_id      uuid,
  title_key       text,
  body_params     jsonb,
  payload         jsonb,
  read_at         timestamptz,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = api, public
as $$
  select
    n.id,
    n.kind,
    n.contribution_id,
    n.frame_key,
    n.comment_id,
    n.title_key,
    n.body_params,
    n.payload,
    n.read_at,
    n.created_at
  from api.notifications n
  where (
      n.recipient_device_id = private.device_id()
      or (n.recipient_user_id is not null and n.recipient_user_id = private.user_id())
    )
    and (p_since is null or n.created_at > p_since)
  order by n.created_at desc
  -- Bounded so an unbounded client cannot ask for the whole table.
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function api.my_notifications(timestamptz, integer) is
  'The caller''s own alerts, newest first, optionally only those created after p_since (the SSE replay cursor) and capped at 200. Scoped to the caller''s device and account; never returns another steward''s alert.';

grant execute on function api.my_notifications(timestamptz, integer) to anon;

-- Marks the caller's own alerts read, and only the caller's own. Ids that name
-- someone else's row are silently ignored rather than refused, so a stale
-- client cannot learn which ids exist by watching the error.
create or replace function api.mark_notifications_read(
  p_ids uuid[]
) returns integer
language sql
security definer
set search_path = api, public
as $$
  with updated as (
    update api.notifications n
       set read_at = now()
     where n.id = any(p_ids)
       and n.read_at is null
       and (
         n.recipient_device_id = private.device_id()
         or (n.recipient_user_id is not null and n.recipient_user_id = private.user_id())
       )
    returning 1
  )
  select count(*)::integer from updated;
$$;

comment on function api.mark_notifications_read(uuid[]) is
  'Stamps read_at on the caller''s own unread alerts named in p_ids and returns how many were stamped. Alerts the caller does not own are ignored, never surfaced.';

grant execute on function api.mark_notifications_read(uuid[]) to anon;

-- ------------------------------------------------------- the preferences ----

create table if not exists api.notification_preferences (
  -- Keyed by device: the device is the identity this app signs in with, so its
  -- choices follow it. user_id is stamped for a signed-in caller but is not the
  -- key, matching the alerts table above.
  device_id   uuid primary key references api.devices(id) on delete cascade,
  user_id     uuid references api.users(id) on delete set null,
  in_app      boolean not null default true,
  web_push    boolean not null default true,
  mobile_push boolean not null default true,
  frequency   text not null default 'instant'
              check (frequency in ('instant', 'daily', 'off')),
  -- Per-kind switches, all on until a steward turns one off. The six keys are
  -- the six kinds api.notifications allows.
  kinds       jsonb not null default '{"discussion_message":true,"question":true,"points_awarded":true,"media_approved":true,"media_rejected":true,"media_pending":true}'::jsonb,
  -- The language copy is rendered in; null means "the app's own default".
  lang        text,
  updated_at  timestamptz not null default now()
);

comment on table api.notification_preferences is
  'One device''s delivery choices: which channels, how often, and which kinds. Keyed by device_id. Written only by api.set_notification_preferences() and read only by api.my_notification_preferences(), both scoped to the caller.';

create index if not exists notification_preferences_user_idx
  on api.notification_preferences (user_id)
  where user_id is not null;

alter table api.notification_preferences enable row level security;

-- Same rule as the alerts table: closed, reached only through the two
-- SECURITY DEFINER functions below, so no anon policy and the default grant
-- taken back.
revoke all on api.notification_preferences from anon;

-- The caller's resolved preferences. Always returns exactly one row: the stored
-- row when there is one, the column defaults when there is not, so the UI never
-- has to special-case a first visit.
create or replace function api.my_notification_preferences()
returns table (
  in_app      boolean,
  web_push    boolean,
  mobile_push boolean,
  frequency   text,
  kinds       jsonb,
  lang        text,
  updated_at  timestamptz
)
language sql
stable
security definer
set search_path = api, public
as $$
  select
    coalesce(p.in_app, true)                as in_app,
    coalesce(p.web_push, true)              as web_push,
    coalesce(p.mobile_push, true)           as mobile_push,
    coalesce(p.frequency, 'instant')        as frequency,
    coalesce(
      p.kinds,
      '{"discussion_message":true,"question":true,"points_awarded":true,"media_approved":true,"media_rejected":true,"media_pending":true}'::jsonb
    )                                       as kinds,
    p.lang                                  as lang,
    p.updated_at                            as updated_at
  from (select 1) as one
  left join api.notification_preferences p
    on p.device_id = private.device_id();
$$;

comment on function api.my_notification_preferences() is
  'The caller''s delivery preferences, resolved to one row: the stored choices, or the defaults when the caller has never set any.';

grant execute on function api.my_notification_preferences() to anon;

-- Writes the caller's preferences. A null argument means "leave this as it is",
-- so the UI can send one changed toggle without restating the rest. A first
-- call creates the row; every call after it updates in place.
create or replace function api.set_notification_preferences(
  p_in_app      boolean default null,
  p_web_push    boolean default null,
  p_mobile_push boolean default null,
  p_frequency   text    default null,
  p_kinds       jsonb   default null,
  p_lang        text    default null
) returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
  v_row    api.notification_preferences;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;
  if p_frequency is not null and p_frequency not in ('instant', 'daily', 'off') then
    raise exception 'Unknown notification frequency %', p_frequency using errcode = '23514';
  end if;
  if p_kinds is not null and jsonb_typeof(p_kinds) <> 'object' then
    raise exception 'kinds must be a json object' using errcode = '22023';
  end if;

  -- The device must exist before a preferences row can reference it.
  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  insert into api.notification_preferences
    (device_id, user_id, in_app, web_push, mobile_push, frequency, kinds, lang, updated_at)
  values (
    v_device, private.user_id(),
    coalesce(p_in_app, true),
    coalesce(p_web_push, true),
    coalesce(p_mobile_push, true),
    coalesce(p_frequency, 'instant'),
    coalesce(
      p_kinds,
      '{"discussion_message":true,"question":true,"points_awarded":true,"media_approved":true,"media_rejected":true,"media_pending":true}'::jsonb
    ),
    p_lang,
    now()
  )
  on conflict (device_id) do update set
    -- Only a signed-in call may fill the account column; a later device-only
    -- call must not blank it.
    user_id     = coalesce(excluded.user_id, api.notification_preferences.user_id),
    in_app      = coalesce(p_in_app,      api.notification_preferences.in_app),
    web_push    = coalesce(p_web_push,    api.notification_preferences.web_push),
    mobile_push = coalesce(p_mobile_push, api.notification_preferences.mobile_push),
    frequency   = coalesce(p_frequency,   api.notification_preferences.frequency),
    kinds       = coalesce(p_kinds,       api.notification_preferences.kinds),
    lang        = coalesce(p_lang,        api.notification_preferences.lang),
    updated_at  = now()
  returning * into v_row;

  return jsonb_build_object(
    'in_app',      v_row.in_app,
    'web_push',    v_row.web_push,
    'mobile_push', v_row.mobile_push,
    'frequency',   v_row.frequency,
    'kinds',       v_row.kinds,
    'lang',        v_row.lang,
    'updated_at',  v_row.updated_at
  );
end;
$$;

comment on function api.set_notification_preferences(boolean, boolean, boolean, text, jsonb, text) is
  'Sets the caller''s delivery preferences and returns the resolved row. A null argument leaves that field unchanged; a first call creates the row. Raises 28000 with no caller identity, 23514 on an unknown frequency, 22023 when kinds is not a json object.';

grant execute on function api.set_notification_preferences(boolean, boolean, boolean, text, jsonb, text) to anon;

-- Two new tables and four new functions are invisible to PostgREST until it is
-- told to re-read the schema.
notify pgrst, 'reload schema';
