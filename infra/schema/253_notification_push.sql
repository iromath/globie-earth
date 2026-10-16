-- Globie Earth :: 253 :: the queue a closed app is woken from
--
-- 251 built the alert table and its reader; 252 made events become rows. Both
-- only reach an app that already has the screen open - the stream (2c) holds
-- one connection per caller and can only ever read that caller's own feed. A
-- push has to wake an app that is *closed*, so something has to notice new rows
-- for *every* device and hand them to the sender (pushSender.ts, 2d.1). This
-- migration is the half of that which belongs in the database: a marker saying
-- a row has been delivered, and the one function that claims a batch of
-- un-delivered rows across devices.
--
-- Why a claim, and not a NOTIFY. The plan's 2c.1 offered "a Postgres
-- LISTEN/NOTIFY payload, or an in-process event emitter", but the MCP server
-- has no direct Postgres connection at all - it speaks HTTP to PostgREST as
-- `anon` (infra/mcp/src/postgrest.ts) - so it cannot LISTEN, and 252 moved every
-- emit into database triggers, so nothing happens inside that process to emit
-- from. The dispatcher (infra/mcp/src/pushDispatcher.ts) therefore polls a
-- SECURITY DEFINER function that returns the next un-delivered rows and stamps
-- them delivered in the same statement, exactly the shape the reminder queue
-- uses. `for update skip locked` makes two dispatcher instances safe: each
-- claims a disjoint batch rather than both sending the same alert.
--
-- Why a credential. api.notifications is closed (251 revokes all from anon and
-- creates no policy), so any function that reads it across devices is a hole if
-- the whole world can call it - the same reasoning 252's header gives for
-- refusing an "anon-callable notify-any-device RPC". The claim function is
-- therefore gated on a dispatch credential: a JWT signed with the stack's own
-- PGRST_JWT_SECRET that carries the custom claim `notification_dispatch: true`.
-- PostgREST verifies the signature before the call, the function checks the
-- claim, and an ordinary anon caller - no token, or a token without the claim -
-- is refused with 28000. The token stays a low-privilege `anon` token (its role
-- claim is `anon` and it carries no account `sub`), so leaking it exposes the
-- push queue and nothing else. infra/mcp/scripts/make-dispatch-token.mjs mints
-- one; the MCP reads it as NOTIFICATIONS_DISPATCH_TOKEN.
--
-- Why a marker, and not a second table. `pushed_at` is a timestamp on the row
-- itself, so "has this been delivered?" cannot drift from the row it describes
-- and there is no queue table to keep in step with api.notifications. It is
-- stamped at *claim* time, not after the send, so a row is never sent twice by
-- a retry; a send that then fails is logged by the sender and not retried,
-- which is the plan's "a push is a best-effort extra" (2d.1). Preferences are
-- joined here rather than in the sender because the sender holds no credential
-- (2d.2) - this function, running as the owner, is the one place that can read
-- another device's api.notification_preferences.
--
-- Depends on 251 (api.notifications, api.notification_preferences). Apply it
-- first. The one-time backfill marks everything already stored as delivered so
-- the first dispatcher run does not wake a heap of stale alerts.

-- ------------------------------------------------ has it been delivered? ----

alter table api.notifications
  add column if not exists pushed_at timestamptz;

comment on column api.notifications.pushed_at is
  'When the push dispatcher claimed this row for delivery (2d.1), or null while it is still waiting. Stamped at claim time, not after the send, so a row is never sent twice.';

-- The dispatch queue: the oldest rows still waiting, which is exactly the read
-- the claim function makes on every tick.
create index if not exists notifications_unpushed_idx
  on api.notifications (created_at)
  where pushed_at is null;

-- Rows that predate push are delivered by definition - nothing was going to
-- send them - so mark them now. A row created after this backfill is a real
-- event and is left for the dispatcher to claim.
update api.notifications set pushed_at = now() where pushed_at is null;

-- ------------------------------------------------------ claiming a batch ----

/*
 * Claims up to p_limit un-delivered alerts for *all* devices and returns them
 * with the recipient's resolved delivery preferences, so the dispatcher can
 * send without a second round trip. Claiming stamps pushed_at, so a row is
 * returned exactly once even across restarts and multiple dispatchers.
 *
 * SECURITY DEFINER: api.notifications and api.notification_preferences are
 * both closed, so only a function running as the owner can read them across
 * devices. It is gated on the dispatch claim (see the file header): a caller
 * without a `notification_dispatch: true` token is refused, so this is not the
 * hole 252 warns about.
 *
 * `for update skip locked` in the picking CTE is what makes concurrency safe -
 * a second dispatcher takes the rows this one did not lock rather than blocking
 * or double-sending. p_limit is clamped to the same ceiling as the reader RPCs.
 */
create or replace function api.claim_notification_pushes(
  p_limit integer default 50
) returns table (
  id                  uuid,
  recipient_device_id uuid,
  kind                text,
  contribution_id     uuid,
  frame_key           text,
  title_key           text,
  body_params         jsonb,
  lang                text,
  frequency           text,
  kinds               jsonb,
  web_push            boolean,
  mobile_push         boolean
)
language plpgsql
volatile
security definer
set search_path = api, public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_claims json;
begin
  -- The dispatch credential. PostgREST has already verified the token's
  -- signature; the claim is what marks it as the dispatcher rather than an
  -- ordinary anon caller. nullif guards the empty-string case, which would
  -- otherwise make the ::json cast raise before the check could run.
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::json;
  if coalesce(v_claims ->> 'notification_dispatch', '') <> 'true' then
    raise exception 'notification push dispatch requires a dispatch token'
      using errcode = '28000';
  end if;

  return query
  with picked as (
    select n.id
      from api.notifications n
     where n.pushed_at is null
     order by n.created_at asc
     limit v_limit
     for update skip locked
  ),
  claimed as (
    update api.notifications n
       set pushed_at = now()
      from picked
     where n.id = picked.id
    returning
      n.id, n.recipient_device_id, n.kind, n.contribution_id,
      n.frame_key, n.title_key, n.body_params
  )
  select
    c.id,
    c.recipient_device_id,
    c.kind,
    c.contribution_id,
    c.frame_key,
    c.title_key,
    c.body_params,
    p.lang,
    coalesce(p.frequency, 'instant') as frequency,
    coalesce(
      p.kinds,
      '{"discussion_message":true,"question":true,"points_awarded":true,"media_approved":true,"media_rejected":true,"media_pending":true}'::jsonb
    ) as kinds,
    coalesce(p.web_push, true)    as web_push,
    coalesce(p.mobile_push, true) as mobile_push
  from claimed c
  left join api.notification_preferences p
    on p.device_id = c.recipient_device_id;
end;
$$;

comment on function api.claim_notification_pushes(integer) is
  'Claims up to p_limit un-pushed alerts for every device (stamping pushed_at) and returns them with the recipient''s resolved preferences. SECURITY DEFINER, gated on the notification_dispatch JWT claim; a caller without it is refused with 28000. for update skip locked makes concurrent dispatchers safe.';

grant execute on function api.claim_notification_pushes(integer) to anon;

-- A new column and a new function are invisible to PostgREST until it is told
-- to re-read the schema.
notify pgrst, 'reload schema';
