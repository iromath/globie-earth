-- Globie Earth :: 238 :: the crowd talks about a photograph before it is judged
--
-- Community review (232/233/235) is a silent vote: a steward looks at a
-- contributed photograph and presses yes or no, and the only words anywhere in
-- the loop are the tally. The one thing the crowd most needs - *why* a photo is
-- wrong, which organ is off, what the species really is - has nowhere to live.
-- This migration gives every photograph its own short thread.
--
-- The shape mirrors the rest of community review, so nothing new has to be
-- learned to read it:
--
--   * A comment names ONE frame (the media file), exactly as a vote does
--     (233_contribution_frame_votes.sql). A thread is per-photo, not per-upload.
--   * Writes go through a SECURITY DEFINER RPC - api.post_contribution_comment -
--     never a direct table write, so the body is bounded, the frame is checked
--     to exist on its row, and the author is the caller's own device and none
--     other. Direct insert/update/delete are revoked outright.
--   * Reads go through api.contribution_comments_for, which returns a display
--     name and the body and never the device UUID - the credential rule 236 set
--     for the leaderboard. A comment is world-readable once visible; only the
--     `hidden` status a steward can set keeps one out of the feed.
--   * A steward's first word on an upload earns 5 eco-tokens, paid once per
--     device per contribution through private.credit_eco_tokens (232) - the one
--     place that credits a balance, so a first-ever credit still hands over the
--     opening grant 090 exists to protect. The guard is an existence test on the
--     device's own earlier comments, so a spammed thread cannot mint tokens.
--
-- Depends on 232 (private.credit_eco_tokens), 233 (the `photos` frame list) and
-- 236 (the display-name rule). Apply 232, 233, 236 first.

-- --------------------------------------------------------- the comments -----

create table if not exists api.contribution_comments (
  id              uuid primary key default gen_random_uuid(),
  contribution_id uuid not null
                  references api.species_contributions(id) on delete cascade,
  -- The `key` of the frame this comment is about, the same identity a vote
  -- names. A thread is attached to one media file, never to the whole upload.
  frame_key       text not null,
  device_id       uuid not null references api.devices(id) on delete cascade,
  body            text not null,
  -- A steward can take a comment out of the feed without deleting the row, so
  -- an abusive thread is hidden and its evidence is kept.
  status          text not null default 'visible'
                  check (status in ('visible', 'hidden')),
  created_at      timestamptz not null default now(),
  -- One device may leave many comments, but the length is bounded here as well
  -- as in the RPC, so a direct write could never store an unbounded body.
  constraint contribution_comments_body_length
    check (char_length(btrim(body)) between 1 and 500)
);

comment on table api.contribution_comments is
  'One short message from a device about ONE frame of a contribution: the crowd''s words beside its vote. Written only by api.post_contribution_comment(); read only through api.contribution_comments_for(), which never returns the device id.';

create index if not exists contribution_comments_frame_idx
  on api.contribution_comments (contribution_id, frame_key, created_at);

-- Each device's comments on a contribution, for the once-per-upload reward test.
create index if not exists contribution_comments_author_idx
  on api.contribution_comments (contribution_id, device_id);

alter table api.contribution_comments enable row level security;

-- 010_bootstrap.sql granted anon insert, update and delete on every new api
-- table by default, and the default select too. All four are taken back: every
-- read and write here is through a SECURITY DEFINER function, so the table is
-- reached by nobody directly - which is also what keeps the author's device id
-- out of every public payload. No anon policy is created, so with RLS on and no
-- grant the table is closed even to a header-less caller.
revoke all on api.contribution_comments from anon;

-- ------------------------------------------------------ reading a thread ----

-- The public read. SECURITY DEFINER, so it bypasses the closed table, and it
-- returns exactly what a visitor may see: the body, when it was left, and a
-- name derived the way the leaderboard derives one - the public sponsor name
-- when the steward chose to be public, a four-character handle otherwise. The
-- device UUID, which is the credential (030_rls.sql), never leaves the function.
create or replace function api.contribution_comments_for(
  p_contribution uuid,
  p_frame_key    text
) returns table (
  id         uuid,
  body       text,
  author     text,
  is_mine    boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = api, public
as $$
  select
    c.id,
    c.body,
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
    ) as author,
    (c.device_id = private.device_id()) as is_mine,
    c.created_at
  from api.contribution_comments c
  where c.contribution_id = p_contribution
    and c.frame_key = p_frame_key
    and c.status = 'visible'
  order by c.created_at asc
  limit 100;
$$;

comment on function api.contribution_comments_for(uuid, text) is
  'The visible comments on one frame of a contribution, oldest first, each with a derived display name and whether it is the caller''s own. Never returns the device id.';

grant execute on function api.contribution_comments_for(uuid, text) to anon;

-- ------------------------------------------------------ leaving a comment ---

create or replace function api.post_contribution_comment(
  p_contribution uuid,
  p_frame_key    text,
  p_body         text
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

  -- The commenting device must exist before the row can reference it.
  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  -- Has this steward already spoken on this upload? If so the comment is
  -- conversation and pays nothing; the first word is the one that counts.
  select exists (
    select 1
      from api.contribution_comments x
     where x.contribution_id = p_contribution
       and x.device_id = v_device
  ) into v_seen;

  insert into api.contribution_comments (contribution_id, frame_key, device_id, body)
  values (p_contribution, p_frame_key, v_device, v_body)
  returning * into v_row;

  if not v_seen then
    perform private.credit_eco_tokens(
      v_device, private.user_id(), c_reward,
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
    'created_at',     v_row.created_at,
    -- 5 the first time this device speaks on this upload, 0 afterwards. The
    -- client pops exactly this, so the celebration never claims more than the
    -- ledger hold.
    'awarded_tokens', v_awarded
  );
end;
$$;

comment on function api.post_contribution_comment(uuid, text, text) is
  'Records the caller''s comment on ONE frame and pays 5 eco-tokens the first time this device comments on this upload. Bounded body, checked frame, author is the caller''s own device, never anyone else''s.';

grant execute on function api.post_contribution_comment(uuid, text, text) to anon;

-- A new table and two new functions are invisible to PostgREST until it is told
-- to re-read the schema.
notify pgrst, 'reload schema';
