-- Globie Earth :: 237 :: a guide-species metric for badges and the board
--
-- 236 made a badge a row in api.badge_definitions and the leaderboard a CASE
-- over private.device_impact's columns, and said so out loud: a new badge is an
-- INSERT, not a migration. That holds for a badge whose rule is already one of
-- the impact columns. It does not hold for the one thing this app is about that
-- has no column yet - the Field Guide.
--
-- A species a visitor photographs and gets accepted is a Guide Species, and the
-- pair that names it - species_type + species_id in api.species_contributions -
-- is exactly the key the Field Guide speaks in (src/lib/dnp.ts builds
-- `dnp_plant:1234` from the same two values). Counting it is a real measure of
-- coverage over the encyclopedia: how many different species a steward has put
-- on the record. It is deliberately distinct from 236's `species`, which counts
-- adopted trees' species in api.adoptions, not encyclopedia coverage.
--
-- So this migration adds one column to private.device_impact, `guide_species`
-- (distinct approved species per device), and teaches the three readers that
-- switch on a metric - award_badges, my_impact and api.leaderboard - to answer
-- for it. It then inserts three badges whose rule is that column. No new table:
-- the contributions the app already writes hold the truth, and this only reads
-- it.
--
-- The one wrinkle is the column itself. A RETURNS TABLE cannot gain a column
-- through CREATE OR REPLACE ("cannot change return type"), so device_impact is
-- dropped and rebuilt first. Its callers are plpgsql and call it by name, and a
-- plpgsql body is not resolved until it runs - so the drop breaks nothing, but
-- they are recreated after it here anyway, which they must be to carry the new
-- CASE arm.
--
-- Depends on 220/234 (api.species_contributions, its four guide species_type
-- values) and 236 (the impact shape, the badge rules, the board). Apply 236
-- first.

-- ------------------------------------------- this device's guide species ----

-- Dropped, not replaced: adding an output column changes the function's return
-- type, which CREATE OR REPLACE refuses. Safe here - callers are plpgsql and
-- resolve the name when they run, not when they are created.
drop function if exists private.device_impact(uuid);

create function private.device_impact(p_device uuid)
returns table (
  trees               integer,
  co2_kg              numeric,
  contributions       integer,
  contributions_total integer,
  votes               integer,
  species             integer,
  -- Distinct guide species this device has had an accepted photograph of. The
  -- key is species_type + ':' + species_id, the Field Guide's own key form.
  guide_species       integer
)
language sql
stable
security definer
set search_path = api, public
as $$
  select
    coalesce((select sum(ld.trees_planted) from api.living_deeds ld
               where ld.device_id = p_device), 0)::integer,
    coalesce((select sum(ld.co2_offset_kg) from api.living_deeds ld
               where ld.device_id = p_device), 0)::numeric,
    -- A contribution counts once it is approved, which under 233 is the moment
    -- its first frame is.
    coalesce((select count(*) from api.species_contributions c
               where c.device_id = p_device and c.status = 'approved'), 0)::integer,
    coalesce((select count(*) from api.species_contributions c
               where c.device_id = p_device), 0)::integer,
    coalesce((select count(*) from api.contribution_frame_votes v
               where v.device_id = p_device), 0)::integer,
    coalesce((select count(distinct a.species_id)
                from api.living_deeds ld
                join api.adoptions a on a.id = ld.adoption_id
               where ld.device_id = p_device), 0)::integer,
    -- New in 237. Distinct on the key, so ten photos of one species count once:
    -- this is breadth across the encyclopedia, not volume of photographs.
    coalesce((select count(distinct c.species_type || ':' || c.species_id)
                from api.species_contributions c
               where c.device_id = p_device and c.status = 'approved'), 0)::integer
$$;

comment on function private.device_impact(uuid) is
  'One device''s stewardship in numbers: trees, CO2, approved contributions, votes cast, distinct species adopted and distinct guide species contributed. The input to the badge rules and the leaderboard.';

-- ------------------------------------------------ awarding, exactly once ---

-- Recreated only to add one arm to the metric CASE. Output parameter name and
-- signature are unchanged, so CREATE OR REPLACE is enough.
create or replace function private.award_badges(
  p_device  uuid,
  p_account uuid
) returns table (awarded_code text)
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_impact record;
  v_def    api.badge_definitions;
  v_value  integer;
begin
  if p_device is null then
    return;
  end if;

  select * into v_impact from private.device_impact(p_device);

  -- Ascending sort_order, so a milestone shows in the order it was reached.
  for v_def in select * from api.badge_definitions order by sort_order loop
    if exists (
      select 1 from api.user_badges b
       where b.device_id = p_device and b.badge_code = v_def.code
    ) then
      continue;
    end if;

    v_value := case v_def.criteria->>'metric'
      when 'trees'               then v_impact.trees
      when 'co2_kg'              then floor(v_impact.co2_kg)::int
      when 'contributions'       then v_impact.contributions
      when 'contributions_total' then v_impact.contributions_total
      when 'votes'               then v_impact.votes
      when 'species'             then v_impact.species
      when 'guide_species'       then v_impact.guide_species
      else 0
    end;

    if v_value >= coalesce((v_def.criteria->>'target')::int, 1) then
      insert into api.user_badges (device_id, user_id, badge_code)
      values (p_device, p_account, v_def.code)
      on conflict (device_id, badge_code) do nothing;

      -- Pay only when the row was actually new, so a replayed award is silent.
      if found then
        if v_def.reward_tokens > 0 then
          perform private.credit_eco_tokens(
            p_device, p_account, v_def.reward_tokens,
            'badge_earned', 'badge', v_def.code
          );
        end if;
        awarded_code := v_def.code;
        return next;
      end if;
    end if;
  end loop;
end;
$$;

comment on function private.award_badges(uuid, uuid) is
  'Stamps every badge this device''s impact now meets and pays each one''s reward once. Returns the codes newly earned. The unique (device_id,badge_code) key is what makes a replay free.';

-- -------------------------------------------- what this caller has done ----

create or replace function api.my_impact()
returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
  v_account uuid := private.user_id();
  v_impact record;
  v_badges jsonb;
  v_new    jsonb;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;

  -- Awarding on read is deliberate: the passport is the moment a steward looks,
  -- so a milestone reached since the last visit is granted and paid here.
  select coalesce(jsonb_agg(awarded_code), '[]'::jsonb)
    into v_new
    from private.award_badges(v_device, v_account);

  select * into v_impact from private.device_impact(v_device);

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'code',          d.code,
             'name',          d.name,
             'thai_name',     d.thai_name,
             'description',   d.description,
             'icon',          d.icon,
             'tier',          d.tier,
             'reward_tokens', d.reward_tokens,
             'metric',        d.criteria->>'metric',
             'target',        coalesce((d.criteria->>'target')::int, 1),
             -- Progress capped at the target, so a bar never overflows.
             'progress', least(
               case d.criteria->>'metric'
                 when 'trees'               then v_impact.trees
                 when 'co2_kg'              then floor(v_impact.co2_kg)::int
                 when 'contributions'       then v_impact.contributions
                 when 'contributions_total' then v_impact.contributions_total
                 when 'votes'               then v_impact.votes
                 when 'species'             then v_impact.species
                 when 'guide_species'       then v_impact.guide_species
                 else 0
               end,
               coalesce((d.criteria->>'target')::int, 1)
             ),
             'earned',    ub.id is not null,
             'earned_at', ub.earned_at
           ) order by d.sort_order
         ), '[]'::jsonb)
    into v_badges
    from api.badge_definitions d
    left join api.user_badges ub
      on ub.badge_code = d.code and ub.device_id = v_device;

  return jsonb_build_object(
    'stats', jsonb_build_object(
      'trees',               v_impact.trees,
      'co2_kg',              v_impact.co2_kg,
      'contributions',       v_impact.contributions,
      'contributions_total', v_impact.contributions_total,
      'votes',               v_impact.votes,
      'species',             v_impact.species,
      'guide_species',       v_impact.guide_species,
      -- The opening grant is a gift, not an achievement, so it is not counted
      -- as earned. Everything else is a reward for something done.
      'tokens_earned', coalesce((
        select sum(l.delta) from api.eco_token_ledger l
         where l.device_id = v_device and l.delta > 0 and l.reason <> 'welcome'
      ), 0),
      'badges_earned', (select count(*) from api.user_badges b where b.device_id = v_device)
    ),
    'badges',  v_badges,
    'newly_earned', v_new
  );
end;
$$;

comment on function api.my_impact() is
  'The caller''s own stewardship: the impact numbers, every badge with its earned state and progress, and the codes newly earned by this call (which were paid here). Awards and pays on read; the passport calls it when it opens.';

grant execute on function api.my_impact() to anon;

-- -------------------------------------------------- the leaderboard --------

create or replace function api.leaderboard(
  p_metric text    default 'trees',
  p_limit  integer default 25
) returns table (
  rank         integer,
  display_name text,
  avatar_url   text,
  value        bigint,
  is_me        boolean
)
language sql
stable
security definer
set search_path = api, public
as $$
  with impact as (
    select
      d.id                                                      as device_id,
      coalesce(deed.trees, 0)::bigint                           as trees,
      coalesce(deed.co2, 0)::bigint                             as co2_kg,
      coalesce(contrib.approved, 0)::bigint                     as contributions,
      coalesce(votes.cast, 0)::bigint                           as votes,
      coalesce(ledger.tokens, 0)::bigint                        as tokens,
      coalesce(guide.guide_species, 0)::bigint                  as guide_species
    from api.devices d
    left join (
      select device_id, sum(trees_planted) trees, sum(co2_offset_kg) co2
        from api.living_deeds group by device_id
    ) deed on deed.device_id = d.id
    left join (
      select device_id, count(*) approved
        from api.species_contributions where status = 'approved' group by device_id
    ) contrib on contrib.device_id = d.id
    left join (
      select device_id, count(*) cast
        from api.contribution_frame_votes group by device_id
    ) votes on votes.device_id = d.id
    left join (
      select device_id, sum(delta) tokens
        from api.eco_token_ledger
       where delta > 0 and reason <> 'welcome'
       group by device_id
    ) ledger on ledger.device_id = d.id
    -- New in 237: distinct guide species per device, keyed the Field Guide way.
    left join (
      select device_id,
             count(distinct (species_type || ':' || species_id)) guide_species
        from api.species_contributions
       where status = 'approved'
       group by device_id
    ) guide on guide.device_id = d.id
  ),
  scored as (
    select
      i.device_id,
      case p_metric
        when 'contributions' then i.contributions
        when 'votes'         then i.votes
        when 'co2'           then i.co2_kg
        when 'tokens'        then i.tokens
        when 'guide_species' then i.guide_species
        else i.trees
      end as value
    from impact i
  ),
  -- Name the steward without ever returning the device UUID, which is their
  -- credential. A public sponsor name wins; otherwise a four-character handle
  -- derived from the id - enough to be recognised, not enough to be reused.
  named as (
    select
      s.device_id,
      s.value,
      coalesce(
        (
          select sp.display_name from api.sponsors sp
           where sp.device_id = s.device_id
             and sp.is_public
             and sp.display_name <> ''
           order by sp.created_at
           limit 1
        ),
        'Steward ' || upper(right(replace(s.device_id::text, '-', ''), 4))
      ) as display_name,
      (
        select u.avatar_url from api.users u
         where u.id = (
           select b.user_id from api.eco_token_balance b
            where b.device_id = s.device_id
         )
           and u.avatar_url is not null
         limit 1
      ) as avatar_url
    from scored s
    where s.value > 0
    order by s.value desc, s.device_id
    limit greatest(1, least(p_limit, 100))
  )
  select
    (row_number() over (order by n.value desc, n.device_id))::int as rank,
    n.display_name,
    n.avatar_url,
    n.value,
    (n.device_id = private.device_id())                          as is_me
  from named n
  order by rank;
$$;

comment on function api.leaderboard(text, integer) is
  'The top stewards by one metric (trees | contributions | votes | co2 | tokens | guide_species). Returns a display name and a value, never a device id; is_me marks the caller''s own row.';

grant execute on function api.leaderboard(text, integer) to anon;

-- ----------------------------------------------------- the new badges ------

-- Rules that reference the new column. Insert-only, like 236's catalogue: a
-- re-run overwrites the copy. sort_order is above the highest in 236 (100), so
-- a species badge shows after the planting, photo and vote milestones.
insert into api.badge_definitions
  (code, name, thai_name, description, icon, tier, reward_tokens, sort_order, criteria)
values
  ('field_guide_reader', 'Field Guide Reader', 'ผู้อ่านคู่มือภาคสนาม',
   'Have your first photograph of a guide species accepted.',      'menu_book',      'bronze', 150, 110, '{"metric":"guide_species","target":1}'),
  ('species_scout',      'Species Scout',      'นักสำรวจชนิดพันธุ์',
   'Have photographs of five different guide species accepted.',   'travel_explore', 'silver', 400, 120, '{"metric":"guide_species","target":5}'),
  ('biodiversity_keeper','Biodiversity Keeper','ผู้พิทักษ์ความหลากหลาย',
   'Have photographs of fifteen different guide species accepted.','forest',         'gold',   700, 130, '{"metric":"guide_species","target":15}')
on conflict (code) do update set
  name          = excluded.name,
  thai_name     = excluded.thai_name,
  description   = excluded.description,
  icon          = excluded.icon,
  tier          = excluded.tier,
  reward_tokens = excluded.reward_tokens,
  sort_order    = excluded.sort_order,
  criteria      = excluded.criteria;

-- New columns, functions and rows are invisible to PostgREST until it re-reads.
notify pgrst, 'reload schema';
