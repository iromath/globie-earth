-- Globie Earth :: 249 :: the crowd votes to replace a species' cover photograph
--
-- A DNP species page shows one photograph as its face: the row's own enriched
-- `photo_url` when it holds one, otherwise the newest community photograph the
-- crowd approved (SpeciesDetailPanel's hero rule). The community stack built in
-- 220/230/231/232/233 only ever judges CONTRIBUTIONS - a visitor's own uploads -
-- so the one photograph a visitor cannot act on is the wrong one already sitting
-- at the top of the page. On api.dnp_fauna/4 that cover is a Smithsonian ledger
-- scan: `enrich-dnp-media.mjs` fell through to "any GBIF publisher" when
-- iNaturalist held nothing, accepted the scan because it ships as CC0, and the
-- page has shown a museum accession sheet under "Tragulus juvanicus" ever since.
--
-- This migration gives the crowd the missing lever, reusing the shape of 233
-- rather than inventing a second kind of vote:
--
--   * api.species_cover_votes - one row per (candidate frame, device). The
--     media file is again the unit of decision, so a nomination names a
--     contribution AND a frame key, exactly as a frame vote does.
--   * api.species_cover_overrides - the decision: the frame the crowd chose to
--     become the cover. A row here wins over the species' own `photo_url`, so
--     approving a replacement is how the wrong catalog cover is retired.
--   * api.cast_cover_vote(...) - the ballot. Five votes and more than three
--     quarters agree and the candidate becomes the cover, the contributor is
--     paid and every winning voter is paid, all in one transaction.
--
-- A candidate must already be an approved frame: only a photograph the crowd
-- has confirmed can become the page's face. So "suggest a new cover image" is
-- the existing contribute flow, and this vote is the second, deliberate step
-- that promotes one confirmed photograph over the catalog's.
--
-- The cover override is world-readable (a page's face is public), the votes are
-- self-readable only (echoing 233's frame votes), and neither is writable from
-- the browser: 010_bootstrap.sql's default grant is taken back for both.

-- ------------------------------------------------------------- the votes ----

create table if not exists api.species_cover_votes (
  id              uuid primary key default gen_random_uuid(),
  species_type    text not null
                  check (species_type in ('dnp_plant','dnp_fauna','dnp_wildlife','dnp_species')),
  species_id      bigint not null,
  contribution_id uuid not null references api.species_contributions(id) on delete cascade,
  -- The frame inside that contribution's `photos` jsonb, the same identity a
  -- frame vote names (233_contribution_frame_votes.sql).
  frame_key       text not null,
  device_id       uuid not null references api.devices(id) on delete cascade,
  vote            boolean not null,
  created_at      timestamptz not null default now(),
  unique (contribution_id, frame_key, device_id)
);

comment on table api.species_cover_votes is
  'One device''s vote on ONE nominated frame as a species'' cover photograph. The frame (contribution_id + frame_key) is the candidate; vote=true means "make this the cover". Five votes and more than three quarters decide it (api.cast_cover_vote).';

create index if not exists species_cover_votes_species_idx
  on api.species_cover_votes (species_type, species_id);
create index if not exists species_cover_votes_candidate_idx
  on api.species_cover_votes (contribution_id, frame_key);

alter table api.species_cover_votes enable row level security;

-- 010_bootstrap.sql grants anon insert/update/delete on every new api table by
-- default; all three are taken back - a vote is written only by the RPC below,
-- never by the browser.
revoke insert, update, delete on api.species_cover_votes from anon;

drop policy if exists species_cover_votes_self_select on api.species_cover_votes;
create policy species_cover_votes_self_select on api.species_cover_votes
  for select to anon using (device_id = private.device_id());

-- --------------------------------------------------------- the decision -----

create table if not exists api.species_cover_overrides (
  species_type    text not null
                  check (species_type in ('dnp_plant','dnp_fauna','dnp_wildlife','dnp_species')),
  species_id      bigint not null,
  contribution_id uuid not null references api.species_contributions(id) on delete cascade,
  frame_key       text not null,
  -- Denormalised so a page can paint the cover without re-reading the
  -- contribution: the stored URL and the one-line label the hero captions with.
  photo_url       text not null,
  label           text,
  vote_up         integer not null default 0,
  vote_down       integer not null default 0,
  decided_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (species_type, species_id)
);

comment on table api.species_cover_overrides is
  'The cover photograph the crowd chose for a species, which wins over the row''s own photo_url. Written only by api.cast_cover_vote once a nomination reaches quorum; world-readable because a species page''s face is public.';

alter table api.species_cover_overrides enable row level security;

revoke insert, update, delete on api.species_cover_overrides from anon;

drop policy if exists species_cover_overrides_public_select on api.species_cover_overrides;
create policy species_cover_overrides_public_select on api.species_cover_overrides
  for select to anon using (true);

-- A read-only tally per nomination, so a species page can show "3 of 5" before
-- the quorum is met without seeing which device cast which vote.
create or replace view api.species_cover_tally as
select
  v.species_type,
  v.species_id,
  v.contribution_id,
  v.frame_key,
  count(*) filter (where v.vote)     as vote_up,
  count(*) filter (where not v.vote) as vote_down,
  count(*)                           as vote_total
from api.species_cover_votes v
group by v.species_type, v.species_id, v.contribution_id, v.frame_key;

comment on view api.species_cover_tally is
  'Per-nomination cover vote counts for the species page: how many of the five votes a candidate has, up and down. No device is named.';

revoke all on api.species_cover_tally from anon;
grant select on api.species_cover_tally to anon;

-- ------------------------------------------------------------- the ballot ---

create or replace function api.cast_cover_vote(
  p_contribution uuid,
  p_frame_key text,
  p_vote boolean
) returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  c_quorum constant integer := 5;
  c_contributor_reward constant integer := 300;
  c_voter_reward constant integer := 50;
  v_device uuid := private.device_id();
  v_row api.species_contributions;
  v_frames jsonb;
  v_frame jsonb;
  v_frame_status text;
  v_species_type text;
  v_species_id bigint;
  v_up integer;
  v_down integer;
  v_total integer;
  v_won boolean := false;
  v_prev api.species_cover_overrides;
  v_changed boolean := false;
  v_cover api.species_cover_overrides;
  v_voter record;
  v_frame_url text;
  v_label text;
begin
  -- The caller is a device or there is no vote to count (the rule 233 sets).
  if v_device is null then
    raise exception 'A cover vote needs a caller identity' using errcode = '28000';
  end if;
  if p_frame_key is null or length(trim(p_frame_key)) = 0 then
    raise exception 'A cover vote needs the frame it is about' using errcode = '22004';
  end if;

  -- Lock the contribution while this vote is counted, so two devices voting at
  -- once cannot both see "one short of the quorum".
  select * into v_row from api.species_contributions c where c.id = p_contribution for update;
  if not found then
    raise exception 'No contribution % to vote on', p_contribution using errcode = 'P0002';
  end if;

  v_species_type := v_row.species_type;
  v_species_id := v_row.species_id;

  -- Rows that predate the organ set (231) carry no `photos`; their single
  -- primary photograph is the whole frame, as adaptFrames() reads it client-side.
  v_frames := coalesce(
    nullif(v_row.photos, '[]'::jsonb),
    jsonb_build_array(jsonb_build_object('key', v_row.photo_key, 'url', v_row.photo_url))
  );

  select t.frame into v_frame
    from jsonb_array_elements(v_frames) as t(frame)
   where t.frame->>'key' = p_frame_key
   limit 1;

  if v_frame is null then
    raise exception 'No frame % on contribution %', p_frame_key, p_contribution using errcode = 'P0002';
  end if;

  -- Only a photograph the crowd already confirmed may become the cover. A frame
  -- with no verdict of its own falls back to the row's: only an approved row is
  -- offered as a candidate, so an absent frame status reads as approved - the
  -- same rule approvedFrames() follows in src/components/guide/SpeciesDetailPanel.tsx.
  v_frame_status := coalesce(
    v_frame->>'status',
    case when v_row.status = 'approved' then 'approved' else 'pending' end
  );
  if v_frame_status <> 'approved' then
    raise exception 'Only a photograph the community has confirmed can become the cover'
      using errcode = '23514';
  end if;

  v_frame_url := coalesce(v_frame->>'url', v_row.photo_url);
  v_label := v_row.ai_subject;

  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  -- One vote per device per nominated frame; a repeat is refused, not merged.
  begin
    insert into api.species_cover_votes
      (species_type, species_id, contribution_id, frame_key, device_id, vote)
    values
      (v_species_type, v_species_id, p_contribution, p_frame_key, v_device, p_vote);
  exception when unique_violation then
    raise exception 'This device has already voted on this cover photograph'
      using errcode = '23505';
  end;

  select
    count(*) filter (where v.vote),
    count(*) filter (where not v.vote),
    count(*)
    into v_up, v_down, v_total
    from api.species_cover_votes v
   where v.species_type = v_species_type
     and v.species_id = v_species_id
     and v.contribution_id = p_contribution
     and v.frame_key = p_frame_key;

  -- The same decisive rule as a frame vote: five votes and more than three
  -- quarters agree (233_contribution_frame_votes.sql).
  if v_total >= c_quorum and v_up * 4 > v_total * 3 then
    v_won := true;
  end if;

  select * into v_prev from api.species_cover_overrides o
   where o.species_type = v_species_type and o.species_id = v_species_id
   for update;

  -- Pay only when the decision actually moves: a repeat win on the same frame
  -- refreshes the tally but never pays a second time.
  v_changed := v_prev.species_type is null
    or v_prev.contribution_id <> p_contribution
    or v_prev.frame_key <> p_frame_key;

  if v_won and v_changed then
    insert into api.species_cover_overrides
      (species_type, species_id, contribution_id, frame_key, photo_url, label,
       vote_up, vote_down, decided_at, updated_at)
    values
      (v_species_type, v_species_id, p_contribution, p_frame_key, v_frame_url, v_label,
       v_up, v_down, now(), now())
    on conflict (species_type, species_id) do update set
      contribution_id = excluded.contribution_id,
      frame_key       = excluded.frame_key,
      photo_url       = excluded.photo_url,
      label           = excluded.label,
      vote_up         = excluded.vote_up,
      vote_down       = excluded.vote_down,
      decided_at      = now(),
      updated_at      = now();

    -- The contributor whose photograph becomes the page's face.
    perform private.credit_eco_tokens(
      v_row.device_id, null, c_contributor_reward, 'cover_accepted', 'contribution',
      p_contribution::text || ':' || p_frame_key
    );

    -- Every device that voted for it and called the verdict right.
    for v_voter in
      select v.device_id
        from api.species_cover_votes v
       where v.contribution_id = p_contribution
         and v.frame_key = p_frame_key
         and v.vote
    loop
      perform private.credit_eco_tokens(
        v_voter.device_id, null, c_voter_reward, 'cover_vote_win', 'contribution',
        p_contribution::text || ':' || p_frame_key || ':voter'
      );
    end loop;
  elsif v_won then
    update api.species_cover_overrides o
       set vote_up = v_up, vote_down = v_down, updated_at = now()
     where o.species_type = v_species_type and o.species_id = v_species_id;
  end if;

  select * into v_cover from api.species_cover_overrides o
   where o.species_type = v_species_type and o.species_id = v_species_id;

  return jsonb_build_object(
    'contribution_id', p_contribution,
    'frame_key', p_frame_key,
    'vote_up', v_up,
    'vote_down', v_down,
    'vote_total', v_total,
    'votes_required', c_quorum,
    'won', v_won,
    'cover_url', v_cover.photo_url,
    'cover_contribution_id', v_cover.contribution_id,
    'cover_frame_key', v_cover.frame_key,
    'cover_decided_at', v_cover.decided_at
  );
end;
$$;

comment on function api.cast_cover_vote(uuid, text, boolean) is
  'Records one device''s vote on a nominated frame as a species'' cover photograph and, once five votes and more than three quarters agree, writes the cover override and pays the contributor and the winning voters. Raises 23505 on a repeat vote, 23514 when the frame is not an approved photograph, P0002 when the frame names no photograph, 28000 with no caller identity.';

grant execute on function api.cast_cover_vote(uuid, text, boolean) to anon;

notify pgrst, 'reload schema';
