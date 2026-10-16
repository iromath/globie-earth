-- Globie Earth :: 252 :: the events are actually written down
--
-- 251_notifications.sql built the table a steward can be shown and the read
-- functions that surface it, but nothing wrote to it: the alerts existed and no
-- event ever became one. This migration is the writer, and it is deliberately a
-- single writer - private.emit_notification() - so the row's shape cannot drift
-- between the five things that raise an alert:
--
--   * a stranger comments on a photograph       -> discussion_message
--   * a work is credited with eco-tokens        -> points_awarded
--   * a submission enters the queue             -> media_pending
--   * a submission is approved                  -> media_approved
--   * a submission is rejected                  -> media_rejected
--
-- The last three all observe the same fact - a row of api.species_contributions
-- changing - so they share one AFTER trigger rather than three call sites. That
-- is a deliberate departure from the plan, which named POST /moderate/decision
-- (moderate.ts) and POST /contribute as two of the emitters. The MCP server
-- talks to PostgREST as `anon` and has no direct Postgres connection
-- (infra/mcp/src/postgrest.ts), so those routes cannot write this closed table
-- at all; the only ways to let them emit would be an anon-callable "notify any
-- device of anything" RPC - a hole, since any caller could then spoof an alert -
-- or a trigger. A trigger is atomic with the write it describes, cannot be
-- skipped by a route that forgets to call it, and covers api.cast_contribution_vote
-- (232)'s own pending -> approved|rejected transition with no third call site.
--
-- Three more decisions worth naming:
--
--   * The opening grant is NOT an alert. private.credit_eco_tokens (232) writes
--     two ledger rows when a balance is first created - the welcome figure and
--     the credit itself. Only the credit is announced; "you have been credited
--     1010 for joining" is not something that happened to a steward's work, and
--     it would fire on the very first credit of every device.
--   * Preferences live at delivery, not here. This writer records one row per
--     event unconditionally; api.notification_preferences - which channels, how
--     often, which kinds - is applied by the stream (2c) and the sender (2d)
--     when they decide whether to pop or push. Recording first is what makes an
--     alert missed while offline still there on the next open (R2.4); a writer
--     that honoured `frequency = 'off'` would silently lose the event.
--   * 'question' vs 'discussion_message' is 250's to decide.
--     250_contribution_comment_threads.sql (Feature 1a) raises
--     api.post_contribution_comment to four arguments, adding p_kind; this file
--     is aligned to that same signature in the same change. The emitted kind now
--     follows p_kind - a 'question' alerts as 'question', every other comment as
--     'discussion_message'. 251 already allows both kinds, so nothing else moves.
--
-- The points case is the one the unique index was built for:
-- notifications_points_once (recipient_device_id, kind, ledger_id). The writer
-- inserts `on conflict ... do nothing`, so a replayed credit - the same ledger
-- row paid twice by a retried RPC - collides and is dropped rather than doubling
-- the alert (R2.3). Every other kind carries a null ledger_id, and Postgres
-- treats nulls as distinct, so they never collide on it.
--
-- Depends on 251 (api.notifications), 232 (private.credit_eco_tokens,
-- api.species_contributions review columns), 238 (api.contribution_comments) and
-- 230 (the moderator transition). Apply those first.

-- ------------------------------------------------------ the one writer ------

/*
 * Records one alert for one recipient device. Every emitter in this file, and
 * any later one, goes through this function so the row's shape is decided in a
 * single place.
 *
 * SECURITY DEFINER: api.notifications is closed (251 revokes all from anon and
 * creates no policy), so only a function running as the owner can write it. It
 * never raises for a missing recipient - an emit is a side effect of a real
 * write, and it must never be the thing that fails it - but a live recipient is
 * always supplied by the callers below.
 *
 * The account column is filled when the caller knows it (the points path does)
 * and otherwise looked up from the device's balance row, the one place a device
 * is tied to a signed-in account. That is what lets a web reader find, through
 * api.my_notifications(), the alerts earned on any device it has signed in on.
 */
create or replace function private.emit_notification(
  p_recipient_device  uuid,
  p_recipient_account uuid    default null,
  p_kind              text    default null,
  p_contribution      uuid    default null,
  p_frame_key         text    default null,
  p_comment_id        uuid    default null,
  p_ledger_id         bigint  default null,
  p_title_key         text    default null,
  p_body_params       jsonb   default '{}'::jsonb,
  p_payload           jsonb   default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_account uuid;
  v_id      uuid;
begin
  -- No recipient, no alert. A caller that could not resolve one gets a no-op,
  -- not an error it would have to swallow.
  if p_recipient_device is null then
    return null;
  end if;

  -- p_account wins when known; otherwise the balance row's account, when the
  -- device has ever been credited while signed in.
  v_account := coalesce(
    p_recipient_account,
    (select b.user_id
       from api.eco_token_balance b
      where b.device_id = p_recipient_device)
  );

  insert into api.notifications (
    recipient_device_id, recipient_user_id, kind,
    contribution_id, frame_key, comment_id, ledger_id,
    title_key, body_params, payload
  ) values (
    p_recipient_device, v_account, p_kind,
    p_contribution, p_frame_key, p_comment_id, p_ledger_id,
    -- A title key names the message for the reader to render in its own
    -- language; 'notif.<kind>' is the convention, so a caller may omit it.
    coalesce(p_title_key, 'notif.' || p_kind),
    coalesce(p_body_params, '{}'::jsonb),
    coalesce(p_payload, '{}'::jsonb)
  )
  -- One ledger row, one points alert: a replay collides here instead of
  -- doubling. Nulls are distinct, so the other kinds never reach this arm.
  on conflict (recipient_device_id, kind, ledger_id) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

comment on function private.emit_notification(uuid, uuid, text, uuid, text, uuid, bigint, text, jsonb, jsonb) is
  'The single writer of api.notifications: one alert for one recipient device, account resolved from the balance row when not passed. Idempotent for the points case through notifications_points_once. Never raises for a missing recipient.';

-- ------------------------------------------- the submission and its verdict --

/*
 * Turns a change to a contributed photograph into an alert.
 *
 * Fires on the two facts the plan wanted three call sites for:
 *
 *   * a new pending row is a submission queued for review  -> media_pending
 *   * pending becoming approved | rejected is the verdict  -> media_approved /
 *     media_rejected
 *
 * The UPDATE arm fires from the moderator's PATCH (moderate.ts) and from
 * api.cast_contribution_vote (232) deciding the crowd's outcome; the guard
 * `old.status = 'pending'` means the intervening tally updates a vote makes -
 * which do not move status - raise nothing, and the decision itself raises
 * exactly one alert.
 */
create or replace function private.notify_species_contribution() returns trigger
language plpgsql
security definer
set search_path = api, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      perform private.emit_notification(
        new.device_id, null, 'media_pending',
        new.id, null, null, null,
        'notif.media_pending',
        jsonb_build_object('species_name', coalesce(new.species_name, '')),
        jsonb_build_object('status', new.status)
      );
    end if;
    return new;
  end if;

  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    perform private.emit_notification(
      new.device_id, null,
      case when new.status = 'approved' then 'media_approved' else 'media_rejected' end,
      new.id, null, null, null,
      case when new.status = 'approved' then 'notif.media_approved' else 'notif.media_rejected' end,
      jsonb_build_object('species_name', coalesce(new.species_name, '')),
      jsonb_build_object('status', new.status, 'review_source', new.review_source)
    );
  end if;

  return new;
end;
$$;

comment on function private.notify_species_contribution() is
  'AFTER INSERT/UPDATE trigger body on api.species_contributions: emits media_pending on submission and media_approved/media_rejected on a pending -> approved|rejected transition, once, whoever moved the row.';

drop trigger if exists species_contributions_notify on api.species_contributions;
create trigger species_contributions_notify
  after insert or update on api.species_contributions
  for each row execute function private.notify_species_contribution();

-- ------------------------------------------------------- the points credit ---
--
-- 232's body, unchanged but for one thing: the credit's ledger row is caught
-- (returning id) and announced. The opening grant above it is not - see the
-- header. Restated rather than wrapped so there is still exactly one function
-- that credits a balance; api.award_eco_tokens (232) keeps calling it.

create or replace function private.credit_eco_tokens(
  p_device      uuid,
  p_account     uuid,
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
  -- Must equal INITIAL_ECO_TOKENS in src/App.tsx, as in 090.
  v_grant   constant integer := 1010;
  v_created api.eco_token_balance;
  v_balance api.eco_token_balance;
  v_ledger  bigint;
begin
  if p_device is null then
    raise exception 'An eco-token credit needs a device' using errcode = '22004';
  end if;

  insert into api.devices (id) values (p_device) on conflict (id) do nothing;
  if p_account is not null then
    insert into api.users (id) values (p_account) on conflict (id) do nothing;
  end if;

  -- A new row opens on the grant, so a device whose first ever credit is a vote
  -- payout is not quietly denied the opening figure - the bug 090 fixed.
  insert into api.eco_token_balance (device_id, user_id, balance)
  values (p_device, p_account, v_grant)
  on conflict (device_id) do nothing
  returning * into v_created;

  if v_created.device_id is not null then
    insert into api.eco_token_ledger (
      device_id, user_id, delta, balance_after, reason, source_type, source_id
    ) values (
      p_device, p_account, v_grant, v_grant, 'welcome', 'welcome', null
    );
  end if;

  update api.eco_token_balance b
     set balance    = b.balance + p_delta,
         user_id    = coalesce(b.user_id, p_account),
         updated_at = now()
   where b.device_id = p_device
  returning * into v_balance;

  if v_balance.balance < 0 then
    raise exception 'Insufficient eco-token balance' using errcode = '23514';
  end if;

  insert into api.eco_token_ledger (
    device_id, user_id, delta, balance_after, reason, source_type, source_id
  ) values (
    p_device, coalesce(v_balance.user_id, p_account), p_delta, v_balance.balance,
    p_reason, p_source_type, p_source_id
  )
  returning id into v_ledger;

  -- Tell the payee their work was credited. ledger_id is the idempotency key:
  -- the same credit replayed collides on notifications_points_once and is
  -- dropped, so a retried RPC never pays the alert twice.
  perform private.emit_notification(
    p_device,
    coalesce(v_balance.user_id, p_account),
    'points_awarded',
    null, null, null, v_ledger,
    'notif.points_awarded',
    jsonb_build_object('delta', p_delta, 'reason', p_reason, 'balance', v_balance.balance),
    jsonb_build_object('reason', p_reason, 'source_type', p_source_type, 'source_id', p_source_id)
  );

  return v_balance;
end;
$$;

-- ------------------------------------------------------- the thread message --
--
-- 238's body, restated with the account stamp 250 adds and one further addition:
-- after a comment is stored, the upload's owner is told, unless the commenter is
-- the owner (you are not notified of your own words). The owner's device id is
-- read from the row the body already proves exists. The emitted kind follows
-- p_kind - a 'question' alerts as 'question', every other comment as
-- 'discussion_message' (see the header). This signature and body must stay in
-- step with the four-argument function 250 creates; the three-argument form is
-- gone, so a stale three-argument copy here would resurrect the overload 250
-- dropped.

create or replace function api.post_contribution_comment(
  p_contribution uuid,
  p_frame_key    text,
  p_body         text,
  p_kind         text default 'comment'
) returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  -- The one engagement reward this migration sets: a steward's first word on an
  -- upload. Small, one-off and guarded below, so a thread cannot be farmed.
  c_reward     constant integer := 5;
  c_max_length constant integer := 500;
  v_device uuid := private.device_id();
  v_user   uuid := private.user_id();
  v_kind   text := coalesce(nullif(btrim(p_kind), ''), 'comment');
  v_body   text := btrim(coalesce(p_body, ''));
  v_row    api.contribution_comments;
  v_seen   boolean;
  v_awarded integer := 0;
  v_author text;
  v_owner  uuid;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;
  if p_frame_key is null or length(p_frame_key) = 0 then
    raise exception 'A frame key is required' using errcode = '22004';
  end if;
  if length(v_body) = 0 then
    raise exception 'A comment cannot be empty' using errcode = '22023';
  end if;
  if v_kind not in ('comment', 'question') then
    raise exception 'Unknown comment kind %', p_kind using errcode = '22023';
  end if;
  if length(v_body) > c_max_length then
    v_body := left(v_body, c_max_length);
  end if;

  -- The contribution must exist and must actually carry this frame. A comment
  -- on a photograph that is not there would be a thread with nothing above it.
  -- The owner's device is read here too, so the alert below needs no second
  -- lookup and cannot name a row that does not exist.
  select c.device_id into v_owner
    from api.species_contributions c
   where c.id = p_contribution
     and exists (
       select 1
         from jsonb_array_elements(
                coalesce(
                  nullif(c.photos, '[]'::jsonb),
                  jsonb_build_array(jsonb_build_object('key', c.photo_key))
                )
              ) f
        where f->>'key' = p_frame_key
     );
  if not found then
    raise exception 'No such photograph in this contribution' using errcode = 'P0002';
  end if;

  -- The commenting device must exist before the row can reference it, and the
  -- account stub before the stamped user_id can - exactly as 080 does, so a
  -- first-ever account can still be an author.
  insert into api.devices (id) values (v_device) on conflict (id) do nothing;
  if v_user is not null then
    insert into api.users (id) values (v_user) on conflict (id) do nothing;
  end if;

  -- Has this steward already spoken on this upload? If so the comment is
  -- conversation and pays nothing; the first word is the one that counts.
  select exists (
    select 1
      from api.contribution_comments x
     where x.contribution_id = p_contribution
       and x.device_id = v_device
  ) into v_seen;

  insert into api.contribution_comments
    (contribution_id, frame_key, device_id, user_id, body, kind)
  values (p_contribution, p_frame_key, v_device, v_user, v_body, v_kind)
  returning * into v_row;

  if not v_seen then
    perform private.credit_eco_tokens(
      v_device, v_user, c_reward,
      'comment_posted', 'contribution', p_contribution::text
    );
    v_awarded := c_reward;
  end if;

  v_author := coalesce(
    (
      select sp.display_name from api.sponsors sp
       where sp.device_id = v_device
         and sp.is_public
         and sp.display_name <> ''
       order by sp.created_at
       limit 1
    ),
    'Steward ' || upper(right(replace(v_device::text, '-', ''), 4))
  );

  -- The upload's owner hears about a stranger's word on their photograph. The
  -- commenter's own comments raise nothing - they were there when they wrote it.
  -- A question is the same event with a different alert: 'question' for the
  -- question, 'discussion_message' for every other comment (251 allows both).
  if v_owner is not null and v_owner <> v_device then
    perform private.emit_notification(
      v_owner, null,
      case when v_kind = 'question' then 'question' else 'discussion_message' end,
      p_contribution, p_frame_key, v_row.id, null,
      case when v_kind = 'question' then 'notif.question' else 'notif.discussion_message' end,
      jsonb_build_object('author', v_author),
      jsonb_build_object('frame_key', p_frame_key)
    );
  end if;

  return jsonb_build_object(
    'id',             v_row.id,
    'body',           v_row.body,
    'author',         v_author,
    'is_mine',        true,
    'kind',           v_row.kind,
    'created_at',     v_row.created_at,
    -- 5 the first time this device speaks on this upload, 0 afterwards. The
    -- client pops exactly this, so the celebration never claims more than the
    -- ledger hold.
    'awarded_tokens', v_awarded
  );
end;
$$;

-- A new function, a trigger and two restated functions are invisible to
-- PostgREST until it is told to re-read the schema.
notify pgrst, 'reload schema';
