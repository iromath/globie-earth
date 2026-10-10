-- Globie Earth :: 235 :: the review queue shows only what a voter can act on
--
-- 233 made the media file the unit of decision and gave api.review_queue one
-- job: hand a device the contributions that still have a frame awaiting a vote.
-- Two kinds of row reached the crowd that no vote could move - the sheet showed
-- live controls, the server refused the vote with 23514 ("This photograph can no
-- longer be voted on.") and the row stayed put:
--
--   * The contributor's own upload. api.cast_frame_vote refuses a vote cast by
--     the device that submitted the row (a visitor cannot judge their own
--     photo), but the view never excluded it, so the person who had just
--     contributed met their own photo in the queue with buttons that could not
--     work.
--   * A contribution whose voting window has closed. 232 set voting_closes_at
--     (default now() + 7 days) and cast_frame_vote refuses every vote past it,
--     but the view never expired it, so a row whose frames can never reach a
--     quorum sat in front of the crowd forever.
--
-- Both are predicate gaps in the view, so this migration adds the two
-- predicates and changes nothing else: the decision rule, the RPC and the
-- per-frame payload are untouched. A closed or own upload is a steward's call
-- (230), not the crowd's, and leaves the crowd queue rather than lingering in it.
--
-- The own-upload test reads private.device_id() (030_rls.sql): a caller without
-- an X-Device-Id header is nobody, so the comparison is NULL and every row still
-- shows - the same rows a header-less reader saw before.
--
-- Depends on 233. Apply 231, 232, 233 first.

create or replace view api.review_queue as
select
  c.id,
  c.species_type,
  c.species_id,
  c.species_name,
  c.photo_url,
  coalesce(
    nullif(c.photos, '[]'::jsonb),
    jsonb_build_array(
      jsonb_build_object(
        'key', c.photo_key, 'url', c.photo_url, 'status', 'pending',
        'voteUp', 0, 'voteDown', 0
      )
    )
  ) as photos,
  c.organs,
  c.ai_subject,
  c.vote_up,
  c.vote_down,
  c.created_at,
  c.voting_closes_at
from api.species_contributions c
where c.device_id is distinct from private.device_id()
  and (c.voting_closes_at is null or c.voting_closes_at > now())
  and exists (
    select 1
      from jsonb_array_elements(
             coalesce(
               nullif(c.photos, '[]'::jsonb),
               jsonb_build_array(jsonb_build_object('key', c.photo_key, 'status', 'pending'))
             )
           ) f
     where coalesce(f->>'status', 'pending') = 'pending'
  );

comment on view api.review_queue is
  'Contributions a crowd voter can still act on: at least one frame awaiting a vote, not the caller''s own upload, and still inside its voting window (232/233/235). Never the submitter.';

-- The view is the only way it is reached. Writes are taken back outright: a
-- view is auto-updatable, and left granted, a default-privilege UPDATE would
-- run as the owner and rewrite the base row behind the vote RPC's back.
revoke all on api.review_queue from anon;
grant select on api.review_queue to anon;

-- A changed view is invisible to PostgREST until it is told to re-read.
notify pgrst, 'reload schema';
