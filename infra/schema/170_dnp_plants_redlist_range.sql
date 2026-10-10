-- Globie Earth :: 170 :: three further GBIF facts for the DNP plant checklist
--
-- 160_dnp_plants_enrich.sql added a plant's genus, synonyms and native status.
-- This adds the three further facts GBIF can supply for the same species, so a
-- listener can ask how threatened a plant is, whether it is actually recorded
-- growing in Thailand, and where - not just what it is called.
--
--   iucn_status    the IUCN Red List category code, from
--                  species/<key>/iucnRedListCategory ({code}, or HTTP 204 when
--                  GBIF serves no assessment). e.g. EN, VU, LC - but also the
--                  non-assessed codes NC/NE/DD, because "not yet assessed" is
--                  itself the honest answer and must not be invented as null.
--   th_record_count the number of GBIF occurrence records for the species in
--                  Thailand (occurrence/search?taxonKey=<key>&country=TH&limit=0).
--                  0 is a real fact - GBIF holds no Thai records for it - and is
--                  kept distinct from null, which means "not resolved yet".
--   th_provinces   the Thai provinces with the most GBIF records for the species,
--                  from the same call's stateProvince facet, comma-joined. Null
--                  when GBIF holds no Thai record to place.
--   map_tile_url   the GBIF Maps v2 occurrence-density tile template for the
--                  species in Thailand, with {z}/{x}/{y} left for the caller to
--                  fill:
--                    https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@2x.png?taxonKey=<key>&country=TH&style=classic.point
--                  Stored rather than derived so the exact Maps v2 contract (the
--                  required @2x suffix, the country filter, the tile style) lives
--                  in one place a renderer can hand straight to a map library.
--
-- 160_dnp_plants_enrich.sql noted that an IUCN category was deliberately left
-- out because "GBIF's species/<key> returns iucnRedListCategory = null for these
-- Thai plants". That note was wrong: the dedicated iucnRedListCategory endpoint
-- answers for the gbif_key already on every row (a sampled 40 of 40 keys returned
-- a code), so it is added here. The earlier note is corrected in that file.
--
-- Every fact is keyed by the same GBIF usageKey already stored as gbif_key
-- (130_dnp_plants.sql), so no new matching is needed - the enrichment importer
-- (enrich-dnp-plants.mjs) only fetches the per-key detail endpoints. Idempotent:
-- that importer updates the existing rows in place.

alter table api.dnp_plants add column if not exists iucn_status     text;
alter table api.dnp_plants add column if not exists th_record_count integer;
alter table api.dnp_plants add column if not exists th_provinces    text;
alter table api.dnp_plants add column if not exists map_tile_url    text;

comment on column api.dnp_plants.iucn_status is
  'IUCN Red List category code (GBIF species/<key>/iucnRedListCategory), e.g. EN/VU/LC, or the non-assessed codes NC/NE/DD. Null when GBIF serves no assessment.';
comment on column api.dnp_plants.th_record_count is
  'Number of GBIF occurrence records for the species in Thailand (occurrence/search, country=TH). 0 means GBIF holds none; null means not resolved yet.';
comment on column api.dnp_plants.th_provinces is
  'Thai provinces with the most GBIF occurrence records for the species, comma-joined. Null when GBIF holds no Thai record to place.';
comment on column api.dnp_plants.map_tile_url is
  'GBIF Maps v2 occurrence-density tile URL template for the species in Thailand, with {z}/{x}/{y} for the caller to fill. Null when the species has no GBIF key.';

-- The red-list category is a short code a caller filters by ("which plants are
-- endangered?"), so a plain btree suits it. th_record_count is sorted/filtered by
-- the same way ("most-recorded Thai plants"). th_provinces is free text a
-- listener may name a province in, so it gets a trigram index alongside the
-- name columns 130/160 already indexed.
create index if not exists dnp_plants_iucn_idx
  on api.dnp_plants (iucn_status);
create index if not exists dnp_plants_th_record_count_idx
  on api.dnp_plants (th_record_count);
create index if not exists dnp_plants_th_provinces_trgm_idx
  on api.dnp_plants using gin (th_provinces gin_trgm_ops);
