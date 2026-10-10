-- Globie Earth :: 242 :: the Thai half of every badge
--
-- 236 and 237 gave each badge an English `description` and a Thai `thai_name`,
-- and the passport shows the name in the reader's language. The description -
-- the sentence that says what earned the badge - stayed English only, so a Thai
-- reader saw a Thai title above an English line. This migration adds the missing
-- half: a `thai_description` column, the Thai sentence for all thirteen badges,
-- and the column carried out through api.my_impact() so the client can show it.
--
-- It is a column and a re-insert, nothing more. The badge catalogue keeps its
-- rule from 236 - a badge is a row, extended by INSERT - so the thirteen rows
-- are re-asserted here through the same `on conflict (code) do update` pattern
-- 236/237 use, which backfills the new column on rows that already exist and
-- heals the copy on a re-run. The one catalogue edit rides along: A5 clarifies
-- species_champion, whose `species` metric counts adopted *tree* species
-- (236's private.device_impact), not Field Guide species (237's guide_species).
--
-- my_impact() is re-emitted whole rather than patched: its badge object gains
-- one key, `thai_description`, and CREATE OR REPLACE keeps the return type
-- (jsonb) so the signature is unchanged. Everything else is 237's body.
--
-- Depends on 236 and 237 (the catalogue, private.device_impact, my_impact).
-- Apply 236, 237 first.

-- ------------------------------------------------- the Thai sentence ------

alter table api.badge_definitions
  add column if not exists thai_description text;

comment on column api.badge_definitions.thai_description is
  'The Thai sentence for the badge''s criterion, shown when the reader''s language is Thai. thai_name is its title; this is its body.';

-- ----------------------------------------------------- the catalogue ------
--
-- Re-asserted whole, the 236/237 way: a re-run overwrites the copy, so this file
-- and 236/237 can never disagree. Every row now carries its Thai sentence, and
-- species_champion (A5) reads "adopted tree species" so it is not mistaken for
-- the Field Guide's guide_species badges from 237.
insert into api.badge_definitions
  (code, name, thai_name, description, thai_description, icon, tier, reward_tokens, sort_order, criteria)
values
  ('first_seed',        'First Seed',          'เมล็ดแรก',
   'Adopt your first tree and put it in the ground.',
   'ปลูกต้นไม้ต้นแรกของคุณและนำลงดิน',
   'eco',                 'bronze',   100,  10, '{"metric":"trees","target":1}'),
  ('sapling_steward',   'Sapling Steward',     'ผู้ดูแลกล้าไม้',
   'Adopt five trees and keep a small grove growing.',
   'ปลูกต้นไม้ 5 ต้นและดูแลสวนเล็ก ๆ ให้เติบโต',
   'forest',              'silver',   250,  20, '{"metric":"trees","target":5}'),
  ('grove_keeper',      'Grove Keeper',        'ผู้พิทักษ์ป่าเล็ก',
   'Adopt fifteen trees - a grove with a name.',
   'ปลูกต้นไม้ 15 ต้น จนกลายเป็นสวนที่มีชื่อ',
   'park',                'gold',     600,  30, '{"metric":"trees","target":15}'),
  ('forest_founder',    'Forest Founder',      'ผู้ก่อป่า',
   'Adopt fifty trees and stand behind a whole forest.',
   'ปลูกต้นไม้ 50 ต้น และยืนเคียงข้างป่าทั้งผืน',
   'nature',              'platinum',2000,  40, '{"metric":"trees","target":50}'),
  ('carbon_guardian',   'Carbon Guardian',     'ผู้พิทักษ์คาร์บอน',
   'Anchor 1,000 kg of CO2 in living wood.',
   'กักเก็บคาร์บอนไดออกไซด์ 1,000 กก. ไว้ในเนื้อไม้ที่มีชีวิต',
   'co2',                 'gold',     500,  50, '{"metric":"co2_kg","target":1000}'),
  ('field_debut',       'Field Debut',         'ลงสนามครั้งแรก',
   'Have a photograph you contributed accepted by the community.',
   'ให้ภาพถ่ายที่คุณร่วมส่งได้รับการอนุมัติจากชุมชน',
   'photo_camera',        'bronze',   150,  60, '{"metric":"contributions","target":1}'),
  ('field_photographer','Field Photographer',  'ช่างภาพภาคสนาม',
   'Get five contributed photographs approved.',
   'ให้ภาพถ่ายที่ร่วมส่งได้รับการอนุมัติ 5 ภาพ',
   'photo_library',       'silver',   400,  70, '{"metric":"contributions","target":5}'),
  ('species_champion',  'Species Champion',    'ผู้พิทักษ์ชนิดพันธุ์',
   'Back five different adopted tree species.',
   'สนับสนุนชนิดพันธุ์ไม้ที่ปลูกไว้ 5 ชนิดที่แตกต่างกัน',
   'diversity_3',         'gold',     600,  80, '{"metric":"species","target":5}'),
  ('community_judge',   'Community Judge',     'ผู้ตัดสินชุมชน',
   'Cast ten votes in the community review.',
   'โหวต 10 ครั้งในการกลั่นกรองของชุมชน',
   'how_to_vote',         'silver',   200,  90, '{"metric":"votes","target":10}'),
  ('tireless_voter',    'Tireless Voter',      'ผู้ลงคะแนนไม่รู้เหนื่อย',
   'Cast fifty votes in the community review.',
   'โหวต 50 ครั้งในการกลั่นกรองของชุมชน',
   'ballot',              'gold',     750, 100, '{"metric":"votes","target":50}'),
  ('field_guide_reader', 'Field Guide Reader', 'ผู้อ่านคู่มือภาคสนาม',
   'Have your first photograph of a guide species accepted.',
   'ให้ภาพถ่ายชนิดพันธุ์ในคู่มือภาพแรกของคุณได้รับการอนุมัติ',
   'menu_book',           'bronze',   150, 110, '{"metric":"guide_species","target":1}'),
  ('species_scout',      'Species Scout',      'นักสำรวจชนิดพันธุ์',
   'Have photographs of five different guide species accepted.',
   'ให้ภาพถ่ายของชนิดพันธุ์ในคู่มือ 5 ชนิดที่แตกต่างกันได้รับการอนุมัติ',
   'travel_explore',      'silver',   400, 120, '{"metric":"guide_species","target":5}'),
  ('biodiversity_keeper','Biodiversity Keeper','ผู้พิทักษ์ความหลากหลาย',
   'Have photographs of fifteen different guide species accepted.',
   'ให้ภาพถ่ายของชนิดพันธุ์ในคู่มือ 15 ชนิดที่แตกต่างกันได้รับการอนุมัติ',
   'forest',              'gold',     700, 130, '{"metric":"guide_species","target":15}')
on conflict (code) do update set
  name             = excluded.name,
  thai_name        = excluded.thai_name,
  description      = excluded.description,
  thai_description = excluded.thai_description,
  icon             = excluded.icon,
  tier             = excluded.tier,
  reward_tokens    = excluded.reward_tokens,
  sort_order       = excluded.sort_order,
  criteria         = excluded.criteria;

-- -------------------------------------------- what this caller has done ----
--
-- 237's body, unchanged except for one key: each badge object now carries
-- thai_description beside description, so the client can pick by language.
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
             'code',             d.code,
             'name',             d.name,
             'thai_name',        d.thai_name,
             'description',      d.description,
             'thai_description', d.thai_description,
             'icon',             d.icon,
             'tier',             d.tier,
             'reward_tokens',    d.reward_tokens,
             'metric',           d.criteria->>'metric',
             'target',           coalesce((d.criteria->>'target')::int, 1),
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
  'The caller''s own stewardship: the impact numbers, every badge with its earned state, progress and Thai/English copy, and the codes newly earned by this call (which were paid here). Awards and pays on read; the passport calls it when it opens.';

grant execute on function api.my_impact() to anon;

-- A new column and a replaced function are invisible to PostgREST until it
-- re-reads the schema.
notify pgrst, 'reload schema';
