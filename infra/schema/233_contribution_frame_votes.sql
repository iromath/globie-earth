-- Globie Earth :: 233 :: the crowd votes on each photograph, not on the batch
--
-- 231 let one contribution carry several organ-labelled photographs; 232 let
-- the crowd approve or refuse the contribution as a whole. Together they left a
-- hole a real submission fell through: a visitor sent four photos of
-- หญ้าเจ้าหญ้า - whole, leaf, flower, fruit - and the fruit was a different
-- species. The set was good enough to pass, so the wrong fruit rode in on the
-- three right photographs and would have been published with them.
--
-- The unit of decision was the answer, and it was the wrong one: if a
-- photograph is judged, a photograph is what the crowd should vote on.
--
-- This migration makes the *media file* the unit of decision and keeps the
-- upload as the submission group:
--
--   * Every frame carries its own status and tally, kept on the frame inside
--     the `photos` jsonb 231 added - no new column, no join to read a score.
--   * A device votes per frame (api.cast_frame_vote), on the same rule 232 set:
--     a quorum of five and more than three quarters one way.
--   * The contribution row's status, vote_up and vote_down become roll-ups of
--     its frames: approved as soon as one frame is approved (so the right
--     photographs publish without waiting on the wrong one), rejected only when
--     every frame is refused, pending while any is undecided.
--   * Only approved frames are published. The species page renders the frames
--     whose status is approved and never the ones the crowd refused - which is
--     the whole point: the wrong fruit does not ride in.
--   * The contributor is paid 300 once, when their first frame is approved; a
--     voter is paid 50 for every frame they called correctly.
--
-- Depends on 231 (the `photos` jsonb) and 232 (the quorum rule, the shared
-- private.credit_eco_tokens payout helper and the review_queue view). Apply
-- 231, 232 first. api.cast_contribution_vote() from 232 is left in place but is
-- no longer called: the app votes per frame now.

-- ---------------------------------------------- frames carry their own ------
--
-- A frame keeps its own state on itself: `status` (pending|approved|rejected)
-- and `voteUp`/`voteDown`. Absent on a row written before this migration, so
-- every existing frame is normalised below - a decided row's frames inherit its
-- verdict, a pending row's frames stay pending. After that the route keeps the
-- shape up to date and the RPC reads and writes it.

-- Rows whose `photos` never existed (pre-231) get a single frame of their
-- primary photograph, keyed by photo_key, so every row has a frame list to
-- vote on and to read.
update api.species_contributions c
   set photos = jsonb_build_array(
         jsonb_build_object(
           'key',         c.photo_key,
           'url',         c.photo_url,
           'organ',       coalesce(c.organs[1], 'whole'),
           'contentType', c.content_type,
           'byteSize',    c.byte_size,
           'status',      case when c.status = 'pending' then 'pending' else c.status end,
           'voteUp',      c.vote_up,
           'voteDown',    c.vote_down
         )
       )
 where c.photos is null
    or jsonb_typeof(c.photos) <> 'array'
    or jsonb_array_length(c.photos) = 0;

-- Rows that already carry a frame list get the per-frame keys filled in: the
-- status each frame inherits from the row, and a zeroed tally. `order by ord`
-- keeps the submission order intact.
update api.species_contributions c
   set photos = normalized.frames
  from (
    select c2.id,
           jsonb_agg(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   t.elem,
                   '{status}',
                   to_jsonb(case when c2.status = 'pending' then 'pending' else c2.status end),
                   true
                 ),
                 '{voteUp}',
                 '0'::jsonb,
                 true
               ),
               '{voteDown}',
               '0'::jsonb,
               true
             )
             order by t.ord
           ) as frames
      from api.species_contributions c2,
           lateral jsonb_array_elements(c2.photos) with ordinality as t(elem, ord)
     where jsonb_typeof(c2.photos) = 'array'
       and jsonb_array_length(c2.photos) > 0
     group by c2.id
  ) normalized
 where c.id = normalized.id;

comment on column api.species_contributions.photos is
  'Every submitted photo as [{key,url,organ,contentType,byteSize,status,voteUp,voteDown}]; photo_key/photo_url stay the primary (first) image. status is the crowd''s per-frame verdict (233), never the row''s.';

-- -------------------------------------------------------- the frame votes ---

create table if not exists api.contribution_frame_votes (
  id              uuid primary key default gen_random_uuid(),
  contribution_id uuid not null
                  references api.species_contributions(id) on delete cascade,
  -- The stable object key of the frame voted on - the `key` in each photos[]
  -- entry. It is what makes a vote about one media file rather than the batch.
  frame_key       text not null,
  device_id       uuid not null references api.devices(id) on delete cascade,
  vote            boolean not null,
  created_at      timestamptz not null default now(),
  -- One device, one vote, per frame, ever. The whole "you cannot vote twice"
  -- guarantee on a single photograph: the RPC need not test for it.
  unique (contribution_id, frame_key, device_id)
);

comment on table api.contribution_frame_votes is
  'One row per device per contributed frame: the crowd''s verdict on that single media file. Written only by api.cast_frame_vote(); a device may read its own vote and nothing else.';

create index if not exists contribution_frame_votes_frame_idx
  on api.contribution_frame_votes (contribution_id, frame_key);

alter table api.contribution_frame_votes enable row level security;

-- 010_bootstrap.sql granted anon insert, update and delete on every new api
-- table by default. A frame vote is cast through the RPC (SECURITY DEFINER, so
-- it bypasses these policies), never by a direct table write, so the three are
-- taken back. The default select stays, narrowed below to the caller's own row.
revoke insert, update, delete on api.contribution_frame_votes from anon;

drop policy if exists contribution_frame_votes_self_select on api.contribution_frame_votes;
create policy contribution_frame_votes_self_select on api.contribution_frame_votes
  for select to anon using (device_id = private.device_id());

-- ---------------------------------------------------- the public queue ------

-- The review queue, for devices that are not moderators. It now selects the
-- contributions that still have at least one frame awaiting a vote, whether the
-- row as a whole is pending, part-approved or wholly approved - a frame that is
-- still contested has to stay in front of the crowd. The per-frame status and
-- tally ride inside `photos`, so the queue needs no join and exposes no more
-- than it did before: never the submitter.
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
where exists (
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
  'Contributions with at least one frame still awaiting a vote, as a voter sees them: the frame set (with each frame''s own status and tally), the species and the closing time - never the submitter.';

-- The view is the only way it is reached. Writes are taken back outright: a
-- view is auto-updatable, and left granted, a default-privilege UPDATE would
-- run as the owner and rewrite the base row behind the vote RPC's back.
revoke all on api.review_queue from anon;
grant select on api.review_queue to anon;

-- --------------------------------------------------- the frame vote itself --

create or replace function api.cast_frame_vote(
  p_contribution uuid,
  p_frame_key    text,
  p_vote         boolean
) returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  -- The decision rule, in one place - the same quorum and margin 232 set.
  c_quorum             constant integer := 5;
  c_contributor_reward constant integer := 300;
  c_voter_reward       constant integer := 50;
  v_device   uuid := private.device_id();
  v_row      api.species_contributions;
  v_frames   jsonb;
  v_index    integer;
  v_frame    jsonb;
  v_status   text;
  v_up       integer;
  v_down     integer;
  v_total    integer;
  v_vote     api.contribution_frame_votes;
  v_row_up     integer;
  v_row_down   integer;
  v_row_pending integer;
  v_row_approved integer;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;
  if p_frame_key is null or length(p_frame_key) = 0 then
    raise exception 'A frame key is required' using errcode = '22004';
  end if;

  -- Lock the row before reading anything. Two voters arriving together must not
  -- both spend the vote that decides the frame on the tally each of them saw;
  -- the second waits here and then reads the first one's tally.
  select * into v_row
    from api.species_contributions
   where id = p_contribution
   for update;

  if v_row.id is null then
    raise exception 'No such contribution' using errcode = 'P0002';
  end if;
  if v_row.voting_closes_at is not null and now() >= v_row.voting_closes_at then
    raise exception 'Voting has closed for this contribution' using errcode = '23514';
  end if;
  if v_row.device_id = v_device then
    raise exception 'The contributor cannot vote on their own photograph' using errcode = '23514';
  end if;

  v_frames := v_row.photos;

  -- Find the frame this vote is about. A vote names a media file, not a row.
  select (t.ord - 1), t.elem
    into v_index, v_frame
    from jsonb_array_elements(v_frames) with ordinality as t(elem, ord)
   where t.elem->>'key' = p_frame_key
   limit 1;

  if v_index is null then
    raise exception 'No such photograph in this contribution' using errcode = 'P0002';
  end if;

  v_status := coalesce(v_frame->>'status', 'pending');
  if v_status <> 'pending' then
    raise exception 'This photograph has already been decided' using errcode = '23514';
  end if;

  -- The voting device must exist before the vote can reference it.
  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  begin
    insert into api.contribution_frame_votes (contribution_id, frame_key, device_id, vote)
    values (p_contribution, p_frame_key, v_device, p_vote);
  exception
    when unique_violation then
      raise exception 'This device has already voted on this photograph' using errcode = '23505';
  end;

  v_up   := coalesce((v_frame->>'voteUp')::int, 0)   + case when p_vote then 1 else 0 end;
  v_down := coalesce((v_frame->>'voteDown')::int, 0) + case when p_vote then 0 else 1 end;
  v_total := v_up + v_down;

  -- Decide the frame, but only on a clear enough crowd. `* 4 > total * 3` is
  -- "> 75%", in integers so nothing rounds a 3-2 into a decision.
  v_status := 'pending';
  if v_total >= c_quorum and v_up * 4 > v_total * 3 then
    v_status := 'approved';
  elsif v_total >= c_quorum and v_down * 4 > v_total * 3 then
    v_status := 'rejected';
  end if;

  v_frame := jsonb_set(
               jsonb_set(
                 jsonb_set(v_frame, '{voteUp}',   to_jsonb(v_up),   true),
                 '{voteDown}',                    to_jsonb(v_down), true
               ),
               '{status}',                        to_jsonb(v_status), true
             );

  -- Write the frame back into its place in the list, and the row with it.
  v_frames := jsonb_set(v_frames, array[v_index::text], v_frame, false);

  update api.species_contributions
     set photos = v_frames
   where id = p_contribution
  returning * into v_row;

  -- Roll the frames up onto the row, which is what the species page and the
  -- list read: the tally is the sum, and the status is approved the moment one
  -- frame is (so the right photographs are published at once), rejected only
  -- when every frame is, and pending while any is still undecided.
  select
    coalesce(sum(coalesce((f->>'voteUp')::int, 0)), 0),
    coalesce(sum(coalesce((f->>'voteDown')::int, 0)), 0),
    count(*) filter (where coalesce(f->>'status', 'pending') = 'pending'),
    count(*) filter (where coalesce(f->>'status', 'pending') = 'approved')
    into v_row_up, v_row_down, v_row_pending, v_row_approved
    from jsonb_array_elements(v_frames) f;

  update api.species_contributions
     set vote_up     = v_row_up,
         vote_down   = v_row_down,
         status      = case
                         when v_row_pending > 0 then 'pending'
                         when v_row_approved > 0 then 'approved'
                         else 'rejected'
                       end,
         review_source = case when v_row_pending = 0 then 'community' else review_source end,
         decided_at    = case
                           when v_row_pending = 0 then coalesce(decided_at, now())
                           else decided_at
                         end
   where id = p_contribution
  returning * into v_row;

  -- Pay, once each, in the same transaction that decided.
  if v_status = 'approved' then
    -- The contributor is paid once per upload, on their first approved frame -
    -- never once per frame, and never twice. points_paid_at is the guard.
    if v_row.points_paid_at is null then
      perform private.credit_eco_tokens(
        v_row.device_id, null, c_contributor_reward,
        'contribution_accepted', 'contribution', p_contribution::text
      );
      update api.species_contributions
         set points_paid_at = now()
       where id = p_contribution
      returning * into v_row;
    end if;
  end if;

  -- A correct vote on this frame is a vote on the side that carried: yes on an
  -- approval, no on a refusal. Each frame pays its own winning voters, once,
  -- because a frame is decided exactly once - a later vote on it is refused
  -- above, before it could reach this block again.
  if v_status <> 'pending' then
    for v_vote in
      select *
        from api.contribution_frame_votes
       where contribution_id = p_contribution
         and frame_key = p_frame_key
         and vote = (v_status = 'approved')
    loop
      perform private.credit_eco_tokens(
        v_vote.device_id, null, c_voter_reward,
        'contribution_vote', 'contribution', p_contribution::text || ':' || p_frame_key
      );
    end loop;
  end if;

  -- Only the fields a voter may see. device_id - who submitted it - and the
  -- frame's object key beyond the one voted on do not leave this function.
  return jsonb_build_object(
    'id',               v_row.id,
    'frame_key',        p_frame_key,
    'frame_status',     v_status,
    'frame_vote_up',    v_up,
    'frame_vote_down',  v_down,
    'status',           v_row.status,
    'vote_up',          v_row.vote_up,
    'vote_down',        v_row.vote_down,
    'votes_required',   c_quorum,
    'decided_at',       v_row.decided_at,
    'voting_closes_at', v_row.voting_closes_at
  );
end;
$$;

comment on function api.cast_frame_vote(uuid, text, boolean) is
  'Records one device''s yes/no vote on ONE frame of a pending contribution, then decides that frame and pays its rewards when a quorum of 5 has formed and the split is clear (>75% one way). One call, one transaction; the caller cannot be the contributor and cannot vote twice on the same frame.';

grant execute on function api.cast_frame_vote(uuid, text, boolean) to anon;

-- A new table, a changed view and a new function are all invisible to PostgREST
-- until it is told to re-read the schema.
notify pgrst, 'reload schema';
