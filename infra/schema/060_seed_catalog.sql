-- Globie Earth :: 060 :: catalog seed
-- Mirrors src/data/mockData.ts so the API returns the same content the bundled
-- app already ships with. Idempotent: re-running refreshes the catalog.
--
-- Embeddings are NOT seeded here: they need an embedding provider, and
-- api.embeddings.embedding is dimension-locked. Until rows exist,
-- similar_content / recommend_species return nothing and catalog_search should
-- be treated as unavailable.

-- pledge_usd is the single price the app charges and displays for a species.
-- pledge_thb is a legacy column kept for schema compatibility; nothing reads it.
insert into api.species (
  id, name, botanical, tagline, need_badge, need_color, image, description,
  adopted_count, total_quota, pledge_thb, pledge_usd, stages, current_stage_index, sort_order
) values
  (
    'kae-na', 'Kae Na', 'Dolichandrone serrulata (ต้นแคนา)',
    'Mother Tree • Sacred Restoration', 'CRITICAL NEED', 'error',
    '/assets/mother_tree.jpg',
    'Fast-growing pioneer tree producing edible medicinal blossoms. Fixes depleted paddy fields and builds canopy corridors.',
    57, 1000000, 890, 5,
    array['Seed', 'Sprout', 'Seedling', 'Baby', 'Canopy'], 0, 1
  ),
  (
    'yang-na', 'Yang Na', 'Dipterocarpus alatus (ต้นยางนา)',
    'Father Tree • Living Oil Well', 'URGENT RESIN PILLAR', 'secondary',
    '/assets/father_tree.jpg',
    'Deep-rooting giants that restore soil moisture, resist wildfire sweeps, capture massive carbon, and support community resin taps.',
    37, 1000000, 1290, 15,
    array['Seed', 'Sprout', 'Seedling', 'Sapling', 'Giant'], 0, 2
  )
on conflict (id) do update set
  name = excluded.name,
  botanical = excluded.botanical,
  tagline = excluded.tagline,
  need_badge = excluded.need_badge,
  need_color = excluded.need_color,
  image = excluded.image,
  description = excluded.description,
  total_quota = excluded.total_quota,
  pledge_thb = excluded.pledge_thb,
  pledge_usd = excluded.pledge_usd,
  stages = excluded.stages,
  sort_order = excluded.sort_order;

insert into api.guardians (
  id, name, thai_name, scientific_name, title, rarity, image, epithet, quote,
  traits, metrics, locked, unlock_requirement, sort_order
) values
  (
    'mother-tree', 'The Mother Tree', 'ต้นแคนา', 'Dolichandrone serrulata',
    'Phra Mae Kae Na', 'Mythic', '/assets/mother_tree.jpg',
    'Sacred Bloom of Compassion',
    'Her blooming white horns breathe life into wind-worn landscapes and calm the restless heart.',
    array['Sacred Bloom of Compassion (Care / แค)', 'Bio-Air Purifier', 'Ancestral Soil Healer'],
    '[{"label":"O₂ Yield","value":"1,420","unit":"kg/yr","colorClass":"text-[#5e1100]"},
      {"label":"Harmony","value":"98%","unit":"Coherence","colorClass":"text-[#001f16]"},
      {"label":"Power","value":"MAX","unit":"Awoken","colorClass":"text-[#8e4e14]"}]'::jsonb,
    false, null, 1
  ),
  (
    'father-tree', 'The Father Tree', 'ต้นยางนา', 'Dipterocarpus alatus',
    'Phra Phaw Yang Na', 'Legendary', '/assets/father_tree.jpg',
    'Heroic Forest Defender & Living Oil Well',
    'Heroic Forest Defender whose energetic amber bio-resin fuels sacred soil life and protects the sanctuary canopy.',
    array['Living Oil Well', 'Forest Engine', 'Deep Subsoil Taproot'],
    '[{"label":"Carbon","value":"180t","unit":"Stored","colorClass":"text-[#001f16]"},
      {"label":"Resin","value":"400+ L","unit":"per year","colorClass":"text-[#8e4e14]"},
      {"label":"Root Depth","value":"12 m","unit":"Bedrock","colorClass":"text-[#5e1100]"}]'::jsonb,
    false, null, 2
  ),
  (
    'bamboo-sovereign', 'Bamboo Rhizome Sovereign', 'ไผ่ตงศรีปราจีน', 'Dendrocalamus asper',
    'Phra Phai Rhizo-Net', 'Locked', '',
    'Subterranean Network Weaver',
    'Weaves subterranean mycelium root highways that stop hillside flash floods within 48 hours.',
    array['Hyper Carbon Trapper', 'Mycelial Bridge', 'Water Table Sentinel'],
    '[{"label":"Growth","value":"1.2m","unit":"Daily Peak","colorClass":"text-gray-400"},
      {"label":"Soil Bind","value":"94%","unit":"Shear Force","colorClass":"text-gray-400"},
      {"label":"Tensile","value":"40kN","unit":"Network","colorClass":"text-gray-400"}]'::jsonb,
    true,
    'Complete The Father Tree''s Trial to unlock the next guardian (Bamboo Rhizome) and unlock rapid carbon absorption.',
    3
  )
on conflict (id) do update set
  name = excluded.name,
  thai_name = excluded.thai_name,
  scientific_name = excluded.scientific_name,
  title = excluded.title,
  rarity = excluded.rarity,
  image = excluded.image,
  epithet = excluded.epithet,
  quote = excluded.quote,
  traits = excluded.traits,
  metrics = excluded.metrics,
  unlock_requirement = excluded.unlock_requirement,
  sort_order = excluded.sort_order;

insert into api.sites (
  id, title, sub_sector, image, video_url, badge, gps_coords, telemetry,
  description, additional_photos, sort_order
) values
  (
    1, 'Stop 1: Wetland Basin & Retention Dykes',
    'Native Agroforestry & Water Retention Basin',
    '/assets/walk_dams.jpg', '/assets/wetland_basin_drone.mp4', 'LIVE DRONE STREAM',
    'Wetland Basin Sector',
    'Alt: 42m • Hum: 78% • Canal Depth: 3.2m • Water pH: 6.8',
    'Ancient flood-plain buffers and earthen dykes where Kae Na and Yang Na saplings form multi-layered windbreaks, filtering agricultural runoff and anchoring the water table.',
    '[{"title":"OpenmindProjects Volunteer Wetland Walk","image":"/assets/walk_james_ross.jpg","caption":"Field survey team inspecting the earthen dam levee between water basins."},
      {"title":"Earthen Retention Dykes","image":"/assets/walk_dams.jpg","caption":"Series of water retention dykes stabilizing local ground moisture."},
      {"title":"Community Fishing Nets","image":"/assets/walk_fishing_net.jpg","caption":"Traditional bamboo fish traps providing non-timber village food security."},
      {"title":"Community Village Homes","image":"/assets/family_homes.jpg","caption":"Smallholder community residences directly protected by the wetland corridor."},
      {"title":"Agroforestry Behind Houses","image":"/assets/farm_behind_houses.jpg","caption":"Permaculture plots integrating fruit trees and native sapling nursery beds."}]'::jsonb,
    1
  ),
  (
    2, 'Stop 2: The Ancestral Creek', 'Isaan Tributary & Wetland Spine',
    '/assets/creek_drone.jpg', null, 'TRIBUTARY SPINE',
    '16.482°N, 102.819°E',
    'Alt: 42m • Hum: 78% • Stream Velocity: 0.8m/s',
    'This living creek is our sanctuary spine. Our deep taproots guard the farms downstream.',
    '[]'::jsonb, 2
  ),
  (
    3, 'Stop 3: Bio-Swale Nursery & Seed Bank', 'Smallholder Community Greenhouse',
    '/assets/wetland_basin.jpg', null, 'COMMUNITY NURSERY',
    '16.495°N, 102.834°E',
    'Alt: 39m • Soil pH: 6.4 • Moisture: 86%',
    'The OpenmindProjects Team works alongside local youth, their parents, and our novice monk to cultivate indigenous wild seeds, providing fair-wage livelihoods and geo-tagged tracking deeds.',
    '[]'::jsonb, 3
  ),
  (
    4, 'Stop 4: Sacred Yang Na Oleoresin Grove', 'Living Oil Well Bedrock Corridor',
    '/assets/creek_drone.jpg', null, 'LIVING OIL WELL',
    '16.478°N, 102.805°E',
    'Alt: 44m • Canopy Height: 38m • Taproot: 22m',
    'Century-old Yang Na giants standing over 35 meters tall, naturally seeping honey-colored bio-resin harvested without harming tree vitality.',
    '[]'::jsonb, 4
  )
on conflict (id) do update set
  title = excluded.title,
  sub_sector = excluded.sub_sector,
  image = excluded.image,
  video_url = excluded.video_url,
  badge = excluded.badge,
  gps_coords = excluded.gps_coords,
  telemetry = excluded.telemetry,
  description = excluded.description,
  additional_photos = excluded.additional_photos,
  sort_order = excluded.sort_order;
