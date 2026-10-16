-- Globie Earth :: 250 :: a steward can find the threads on their own work
--
-- 238 gave every photograph a thread and let anyone read one - but only if they
-- already knew which contribution and which frame to name. What it never gave is
-- the other direction: an uploader has no way to learn that a thread exists on
-- their own photograph, or to see all of them in one place. The words are there;
-- the door to them is not.
--
-- This migration opens that door, and stamps two facts 238 could not record:
--
--   * user_id on a comment. 238 stores the author as a device, and a device is
--     the credential (030_rls.sql) - but a signed-in steward reads their own work
--     on more than one device, and only an account id can join those. Every
--     comment is now stamped with private.user_id() at the moment the row is
--     created (080's rule: a policy cannot repair a row no writer stamped), so a
--     thread can be found from any device the author signs in on.
--   * kind on a comment. D4: a "question" is a comment wearing a different hat,
--     not a second table. The column defaults to 'comment'; the threading RPC may
--     raise a 'question', and only the notification's kind changes with it.
--
-- It adds the owner-scoped read 238 deliberately did not have:
--
--   * api.my_contribution_threads() lists a frame's thread - its message and
--     question counts, its last message and its unread count - for the caller
--     only. A thread is included when its parent contribution is the caller's by
--     device, OR when the caller's device, or account, has spoken in that thread.
--     This is the reading the plan settled (Feature 1, item 2): user_id is added
--     to api.contribution_comments and nowhere else, so the owner predicate reads
--     comments - the parent row carries only a device, never an account. Either
--     way no caller can enumerate another's list (D5).
--   * api.set_my_contribution_comment_status() lets an owner hide a thread on
--     their own media without deleting a single row, reusing the `hidden` status
--     238 already honours on the public read (R1.4).
--
-- unread_count has no store of its own. Neither 238 nor 251 keeps a per-thread
-- read cursor, so the count is derived from api.notifications: the visible
-- comments in the frame whose matching alert (contribution + frame + comment) is
-- still read_at is null for the caller. That is exact rather than approximate,
-- because an owner's own words never raise an alert (252), so a comment the
-- caller wrote can never be counted as unread.
--
-- The overload trap. 252_notification_emit.sql restates
-- api.post_contribution_comment at 238's three-argument signature. Postgres
-- treats a changed argument list as a NEW overload, not a replacement, so a
-- four-argument 250 (adding p_kind) would coexist with the three-argument
-- function and every existing three-named-arg PostgREST call would fail as
-- 'function is not unique'. This file therefore drops the three-argument form
-- before it creates the four-argument one, and the aligned 252 is raised to the
-- same four-argument signature in the same change, so exactly one definition
-- survives and it decides the kind.
--
-- Apply together with the aligned 252. 250 drops the emitting three-argument
-- function, so on an existing database 252 must be applied in the same step or
-- the comment path stops notifying until it is.
--
-- api.my_contribution_threads references api.notifications, which 251 creates
-- later in the same boot (this file sorts before it). That is safe: a plpgsql
-- body resolves table and function names at first call, by which time 251 and 252
-- have run.
--
-- Depends on 238 (the comments table), 231/233 (the `photos` frame list), 070
-- (api.users, private.user_id()) and 080 (the stamping rule). Apply those first.

-- ------------------------------------------------- the two new columns ------

alter table api.contribution_comments
  add column if not exists user_id uuid references api.users(id);

comment on column api.contribution_comments.user_id is
  'The signed-in account that left the comment, stamped at insert from private.user_id() (080''s rule). Null for a device-only author. It is what lets a thread be found from any device the author signs in on; device_id stays the credential and no read ever returns it.';

alter table api.contribution_comments
  add column if not exists kind text not null default 'comment'
    check (kind in ('comment', 'question'));

comment on column api.contribution_comments.kind is
  'comment | question. A question is a comment the notification announces differently (D4): one table, one thread, one stream; only the alert''s kind changes.';

-- The owner-scoped read groups by (contribution_id, user_id): the shape that
-- finds a caller's own comments on a contribution fast.
create index if not exists contribution_comments_owner_idx
  on api.contribution_comments (contribution_id, user_id);

-- --------------------------------------------------- the comment, restated ---
--
-- 238's body, restated with two changes and no others: the new row is stamped
-- with the caller's account (private.user_id()) when there is one, and the caller
-- may name a kind. Everything 238 guaranteed - the 28000/22004/22023 refusals,
-- the bounded body, the frame-existence check, the once-per-upload 5-token
-- reward - is unchanged. The owner notification is added by 252; this file is the
-- shape and the account stamp.

-- Dropped first: a four-argument function with a defaulted p_kind would otherwise
-- coexist with the three-argument form and make every existing PostgREST call
-- ambiguous (see the header).
drop function if exists api.post_contribution_comment(uuid, text, text);

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
  perform 1
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
  -- account stub before the new user_id column can - exactly as 080 does, so a
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

  return jsonb_build_object(
    'id',             v_row.id,
    'body',           v_row.body,
    'author',         v_author,
    'is_mine',        true,
    'kind',           v_row.kind,
    'created_at',     v_row.created_at,
    -- 5 the first time this device speaks on this upload, 0 afterwards.
    'awarded_tokens', v_awarded
  );
end;
$$;

comment on function api.post_contribution_comment(uuid, text, text, text) is
  'Records the caller''s comment (or question) on ONE frame and pays 5 eco-tokens the first time this device comments on this upload. Stamps the caller''s account, bounded body, checked frame, author is the caller''s own device. The owner notification is added by 252.';

grant execute on function api.post_contribution_comment(uuid, text, text, text) to anon;

-- -------------------------------------------------- the caller's threads -----

-- The one place a steward sees every thread on their own work at once: one row
-- per frame, with its counts, its last message and how much of it is unread. It
-- reads the closed table through SECURITY DEFINER and is scoped to the caller's
-- device and account, so no one can enumerate another's list (D5). The device id
-- itself never leaves - only the derived display name does.
create or replace function api.my_contribution_threads()
returns table (
  contribution_id uuid,
  frame_key       text,
  species_type    text,
  species_id      bigint,
  species_name    text,
  message_count   integer,
  question_count  integer,
  last_author     text,
  last_body       text,
  last_at         timestamptz,
  unread_count    integer
)
language plpgsql
stable
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
  v_user   uuid := private.user_id();
begin
  -- A caller with neither a device nor a verified account owns nothing to list.
  if v_device is null and v_user is null then
    return;
  end if;

  return query
  with threads as (
    -- Every frame of every contribution this device posted...
    select sc.id as contribution_id, f->>'key' as frame_key
      from api.species_contributions sc
      cross join lateral jsonb_array_elements(
             coalesce(
               nullif(sc.photos, '[]'::jsonb),
               jsonb_build_array(jsonb_build_object('key', sc.photo_key))
             )
           ) f
     where v_device is not null
       and sc.device_id = v_device
    union
    -- ...and every frame this device, or this account on any device, has spoken in.
    select cc.contribution_id, cc.frame_key
      from api.contribution_comments cc
     where (v_device is not null and cc.device_id = v_device)
        or (v_user is not null and cc.user_id = v_user)
  ),
  -- The visible comments on only the caller's own threads, each with the display
  -- name 238 derives (never the device id).
  visible as (
    select
      c.contribution_id,
      c.frame_key,
      c.id,
      c.body,
      c.kind,
      c.created_at,
      coalesce(
        (
          select sp.display_name from api.sponsors sp
           where sp.device_id = c.device_id
             and sp.is_public
             and sp.display_name <> ''
           order by sp.created_at
           limit 1
        ),
        'Steward ' || upper(right(replace(c.device_id::text, '-', ''), 4))
      ) as author
    from api.contribution_comments c
    join threads t
      on t.contribution_id = c.contribution_id
     and t.frame_key = c.frame_key
    where c.status = 'visible'
  )
  select
    t.contribution_id,
    t.frame_key,
    sc.species_type,
    sc.species_id,
    sc.species_name,
    coalesce(agg.message_count, 0)::integer  as message_count,
    coalesce(agg.question_count, 0)::integer as question_count,
    agg.last_author,
    agg.last_body,
    agg.last_at,
    coalesce(agg.unread_count, 0)::integer   as unread_count
  from threads t
  join api.species_contributions sc on sc.id = t.contribution_id
  left join lateral (
    select
      count(*)::integer                                          as message_count,
      count(*) filter (where v.kind = 'question')::integer       as question_count,
      (array_agg(v.author     order by v.created_at desc))[1]    as last_author,
      (array_agg(v.body       order by v.created_at desc))[1]    as last_body,
      (array_agg(v.created_at order by v.created_at desc))[1]    as last_at,
      -- An owner's own words never raise an alert (252), so a comment with no
      -- matching unread row is simply one already seen.
      (
        select count(*)::integer
          from visible uv
          join api.notifications n
            on n.comment_id = uv.id
           and n.contribution_id = uv.contribution_id
           and n.frame_key = uv.frame_key
         where uv.contribution_id = t.contribution_id
           and uv.frame_key = t.frame_key
           and n.read_at is null
           and (
             n.recipient_device_id = v_device
             or (v_user is not null and n.recipient_user_id = v_user)
           )
      ) as unread_count
    from visible v
    where v.contribution_id = t.contribution_id
      and v.frame_key = t.frame_key
  ) agg on true
  order by agg.last_at desc nulls last;
end;
$$;

comment on function api.my_contribution_threads() is
  'The caller''s own threads, one row per frame of their contributions (and any frame they have spoken in): message and question counts, the last visible message and its author, and how many of the frame''s alerts are still unread. Scoped to the caller''s device and account; never returns the device id or another steward''s thread.';

grant execute on function api.my_contribution_threads() to anon;

-- ------------------------------------------------ managing a thread ----------

-- R1.4: hide a thread on one's own media without deleting history. It reuses the
-- `hidden` status 238 already honours on the public read (contribution_comments_for
-- only shows `visible`), so the rows stay and the feed forgets them; `visible`
-- brings them back. The caller must own the parent contribution - the poster's
-- device, or, when signed in, an account that has spoken in this thread - and is
-- refused 42501 otherwise, so one steward cannot hide another's words.
create or replace function api.set_my_contribution_comment_status(
  p_contribution uuid,
  p_frame_key    text,
  p_status       text
) returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_user    uuid := private.user_id();
  v_status  text := btrim(coalesce(p_status, ''));
  v_updated integer;
begin
  if v_status not in ('visible', 'hidden') then
    raise exception 'A thread status must be visible or hidden' using errcode = '22023';
  end if;
  if p_frame_key is null or length(p_frame_key) = 0 then
    raise exception 'A frame key is required' using errcode = '22004';
  end if;

  if not exists (
        select 1 from api.species_contributions sc
         where sc.id = p_contribution
           and v_device is not null
           and sc.device_id = v_device
      )
     and not exists (
        select 1 from api.contribution_comments cc
         where cc.contribution_id = p_contribution
           and v_user is not null
           and cc.user_id = v_user
      ) then
    raise exception 'Not your contribution' using errcode = '42501';
  end if;

  update api.contribution_comments c
     set status = v_status
   where c.contribution_id = p_contribution
     and c.frame_key = p_frame_key;
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'contribution_id', p_contribution,
    'frame_key',       p_frame_key,
    'status',          v_status,
    'updated',         v_updated
  );
end;
$$;

comment on function api.set_my_contribution_comment_status(uuid, text, text) is
  'Sets visible|hidden on every comment of ONE frame of a contribution the caller owns (by device, or by a signed-in account that has spoken there), returning the affected count. Raises 42501 for a non-owner and 22023 for an unknown status. Rows are never deleted - the 238 public read already withholds `hidden`.';

grant execute on function api.set_my_contribution_comment_status(uuid, text, text) to anon;

-- Two new columns and three new/changed functions are invisible to PostgREST
-- until it is told to re-read the schema.
notify pgrst, 'reload schema';
