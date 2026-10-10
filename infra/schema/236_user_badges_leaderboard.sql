-- Globie Earth :: 236 :: digital badges and the contributor leaderboard
--
-- The app has always paid for stewardship - 100 eco-tokens a sapling
-- (090_starting_grant.sql), 300 for an accepted photograph and 50 for a correct
-- vote (232/233, infra/schema/232_contribution_votes.sql) - but nothing ever
-- named what a steward had done. The ledger holds the truth and the passport
-- shows a running balance, and a balance is not a badge: a number tells a
-- visitor how much they have, never what it was for. This migration turns the
-- activity the ledger and the deeds already record into two things a person can
-- be proud of and be compared by:
--
--   * a badge - earned once, by a rule, and paid for - shown on the Guardian
--     Passport beside the deeds it came from; and
--   * a leaderboard - the stewards who have planted the most, contributed the
--     most, voted the most - so a contribution is visible beyond the ledger.
--
-- The rule for a badge is deliberately data, not code: api.badge_definitions
-- maps a code to one {metric, target} pair and a reward, and private.award_badges
-- reads this device's impact and stamps the badges whose rule is met. Adding a
-- badge is an INSERT, not a migration.
--
-- Rewards reuse private.credit_eco_tokens(uuid, uuid, integer, text, text, text)
-- (232), the one place that credits a balance, so a steward whose first ever
-- credit is a badge still receives the opening grant - the bug 090 exists to
-- prevent. The write is guarded by the unique (device_id, badge_code) key, so a
-- replay cannot pay twice.
--
-- The leaderboard is the first cross-device read in the app, and identity is the
-- whole problem: a leaderboard must name a steward without handing the world
-- their device UUID (which is their credential - 030_rls.sql). The RPC is
-- SECURITY DEFINER and returns a display name and a value, never a device id;
-- the name is api.sponsors.display_name when the steward chose to be public,
-- and a four-character handle derived from the device otherwise.
--
-- Depends on 232 (private.credit_eco_tokens, api.species_contributions tallies)
-- and 233 (api.contribution_frame_votes). Apply 232, 233 first.

-- ---------------------------------------------------- the badge catalog ----

create table if not exists api.badge_definitions (
  code          text primary key,
  name          text not null,
  thai_name     text,
  description   text not null,
  -- A Material Symbols name, the icon set the rest of the app already renders.
  icon          text not null default 'military_tech',
  tier          text not null default 'bronze'
                check (tier in ('bronze', 'silver', 'gold', 'platinum')),
  -- Paid once, through private.credit_eco_tokens, the moment the badge is won.
  reward_tokens integer not null default 0,
  sort_order    integer not null default 0,
  -- {"metric": "<one of private.device_impact's columns>", "target": <int>}.
  -- Data, not code: a new badge is an INSERT here.
  criteria      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

comment on table api.badge_definitions is
  'The badge catalogue: what each badge is and the {metric,target} rule that earns it. World-readable; extended by INSERT, never by code.';
comment on column api.badge_definitions.criteria is
  'The earning rule as {"metric": "<impact column>", "target": <int>}. private.award_badges reads this device''s impact and stamps the badge when the metric meets the target.';
comment on column api.badge_definitions.reward_tokens is
  'Eco-tokens paid once, via private.credit_eco_tokens, when the badge is earned.';

-- The catalogue. Insert-only rules above, so a re-run overwrites the copy.
insert into api.badge_definitions
  (code, name, thai_name, description, icon, tier, reward_tokens, sort_order, criteria)
values
  ('first_seed',        'First Seed',          'เมล็ดแรก',
   'Adopt your first tree and put it in the ground.',                       'eco',                 'bronze',   100,  10, '{"metric":"trees","target":1}'),
  ('sapling_steward',   'Sapling Steward',     'ผู้ดูแลกล้าไม้',
   'Adopt five trees and keep a small grove growing.',                      'forest',              'silver',   250,  20, '{"metric":"trees","target":5}'),
  ('grove_keeper',      'Grove Keeper',        'ผู้พิทักษ์ป่าเล็ก',
   'Adopt fifteen trees - a grove with a name.',                            'park',                'gold',     600,  30, '{"metric":"trees","target":15}'),
  ('forest_founder',    'Forest Founder',      'ผู้ก่อป่า',
   'Adopt fifty trees and stand behind a whole forest.',                    'nature',              'platinum',2000,  40, '{"metric":"trees","target":50}'),
  ('carbon_guardian',   'Carbon Guardian',     'ผู้พิทักษ์คาร์บอน',
   'Anchor 1,000 kg of CO2 in living wood.',                                'co2',                 'gold',     500,  50, '{"metric":"co2_kg","target":1000}'),
  ('field_debut',       'Field Debut',         'ลงสนามครั้งแรก',
   'Have a photograph you contributed accepted by the community.',          'photo_camera',        'bronze',   150,  60, '{"metric":"contributions","target":1}'),
  ('field_photographer','Field Photographer',  'ช่างภาพภาคสนาม',
   'Get five contributed photographs approved.',                            'photo_library',       'silver',   400,  70, '{"metric":"contributions","target":5}'),
  ('species_champion',  'Species Champion',    'ผู้พิทักษ์ชนิดพันธุ์',
   'Back five different species.',                                          'diversity_3',         'gold',     600,  80, '{"metric":"species","target":5}'),
  ('community_judge',   'Community Judge',     'ผู้ตัดสินชุมชน',
   'Cast ten votes in the community review.',                               'how_to_vote',         'silver',   200,  90, '{"metric":"votes","target":10}'),
  ('tireless_voter',    'Tireless Voter',      'ผู้ลงคะแนนไม่รู้เหนื่อย',
   'Cast fifty votes in the community review.',                             'ballot',              'gold',     750, 100, '{"metric":"votes","target":50}')
on conflict (code) do update set
  name          = excluded.name,
  thai_name     = excluded.thai_name,
  description   = excluded.description,
  icon          = excluded.icon,
  tier          = excluded.tier,
  reward_tokens = excluded.reward_tokens,
  sort_order    = excluded.sort_order,
  criteria      = excluded.criteria;

-- ----------------------------------------------------- badges earned ------

create table if not exists api.user_badges (
  id         uuid primary key default gen_random_uuid(),
  device_id  uuid not null references api.devices(id) on delete cascade,
  -- The account that held this device at the moment of earning, when there was
  -- one. Copied, not derived: a badge is a fact about a time, not a join.
  user_id    uuid references api.users(id) on delete set null,
  badge_code text not null references api.badge_definitions(code) on delete cascade,
  earned_at  timestamptz not null default now(),
  -- One device, one badge, ever. This is what makes the reward idempotent.
  unique (device_id, badge_code)
);

comment on table api.user_badges is
  'Badges a device has earned. Written only by private.award_badges(); a device may read its own and nothing else.';

create index if not exists user_badges_device_idx on api.user_badges (device_id, earned_at desc);

alter table api.user_badges enable row level security;

-- 010_bootstrap.sql granted anon insert, update and delete on every new api
-- table by default. A badge is earned through the RPC (SECURITY DEFINER, which
-- bypasses these policies), never by a direct write, so the three are taken
-- back. The default select stays, narrowed below to the caller's own rows.
revoke insert, update, delete on api.user_badges from anon;

drop policy if exists user_badges_self_select on api.user_badges;
create policy user_badges_self_select on api.user_badges
  for select to anon using (device_id = private.device_id());

-- The catalogue is public: the passport shows locked badges too.
alter table api.badge_definitions enable row level security;
revoke insert, update, delete on api.badge_definitions from anon;

drop policy if exists badge_definitions_read on api.badge_definitions;
create policy badge_definitions_read on api.badge_definitions
  for select to anon using (true);

-- ----------------------------------------------------- this device's ------
--
-- One place that answers "what has this steward done". Everything the badge
-- rules and the leaderboard care about is a count or a sum over tables the app
-- already writes; none of it is stored twice.
create or replace function private.device_impact(p_device uuid)
returns table (
  trees               integer,
  co2_kg              numeric,
  contributions       integer,
  contributions_total integer,
  votes               integer,
  species             integer
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
               where ld.device_id = p_device), 0)::integer
$$;

comment on function private.device_impact(uuid) is
  'One device''s stewardship in numbers: trees, CO2, approved contributions, votes cast and distinct species adopted. The input to the badge rules and the leaderboard.';

-- ------------------------------------------------ awarding, exactly once ---

-- The output column is awarded_code, not badge_code: a plpgsql output parameter
-- shadows a same-named table column, which makes the ON CONFLICT target below
-- ambiguous ("column reference badge_code is ambiguous"). The DROP is needed
-- because CREATE OR REPLACE cannot rename an output parameter.
drop function if exists private.award_badges(uuid, uuid);
create function private.award_badges(
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
      coalesce(ledger.tokens, 0)::bigint                        as tokens
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
  ),
  scored as (
    select
      i.device_id,
      case p_metric
        when 'contributions' then i.contributions
        when 'votes'         then i.votes
        when 'co2'           then i.co2_kg
        when 'tokens'        then i.tokens
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
  'The top stewards by one metric (trees | contributions | votes | co2 | tokens). Returns a display name and a value, never a device id; is_me marks the caller''s own row.';

grant execute on function api.leaderboard(text, integer) to anon;

-- New tables, a new view and new functions are invisible to PostgREST until it
-- is told to re-read the schema.
notify pgrst, 'reload schema';
