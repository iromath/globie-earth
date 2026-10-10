-- Globie Earth :: 160 :: enrich the DNP plant checklist from GBIF
--
-- 130_dnp_plants.sql stored the national plant checklist with an English common
-- name resolved from GBIF, but nothing else about each species. This adds the
-- three further facts GBIF can supply for the same species, so a listener can ask
-- about a plant's genus, its synonyms, or whether it is native to Thailand - not
-- just what it is called.
--
--   genus         the botanical genus, from species/<key> (GBIF usageKey)
--   synonyms      the GBIF synonym names, joined, from species/<key>/synonyms
--   native_status whether GBIF records the species as native/introduced/cultivated
--                 in Thailand, from species/<key>/distributions (establishmentMeans
--                 for the Thailand locality). Null when GBIF lists no Thailand
--                 distribution.
--
-- An IUCN category is NOT added here. This migration originally said GBIF returns
-- iucnRedListCategory = null for these Thai plants; that was wrong - the dedicated
-- species/<key>/iucnRedListCategory endpoint answers for the gbif_key on every row.
-- The category, the Thailand occurrence signal and the Maps v2 tile template are
-- added by 170_dnp_plants_redlist_range.sql instead, keeping this file to the
-- three facts it was written for.
--
-- All three are resolved by the same GBIF usageKey already stored as gbif_key
-- (130_dnp_plants.sql), so no new matching is needed - the importer only fetches
-- the per-key detail endpoints. Idempotent: the enrichment importer updates the
-- existing rows in place (enrich-dnp-plants.mjs).

alter table api.dnp_plants add column if not exists genus         text;
alter table api.dnp_plants add column if not exists synonyms      text;
alter table api.dnp_plants add column if not exists native_status text;

comment on column api.dnp_plants.genus is
  'Botanical genus, resolved from the GBIF usageKey in gbif_key. Null when GBIF did not resolve the species.';
comment on column api.dnp_plants.synonyms is
  'GBIF synonym names, comma-joined. Null when GBIF lists none.';
comment on column api.dnp_plants.native_status is
  'Whether GBIF records the species as native/introduced/cultivated in Thailand (distributions.establishmentMeans). Null when GBIF lists no Thailand distribution.';

-- The synonym list is free text a listener may search by, so it gets a trigram
-- index alongside the name columns 130_dnp_plants.sql already indexed. genus is a
-- short, mostly-redundant token, so a plain btree is enough for an equality/prefix
-- lookup and a trigram index would be wasted space.
create index if not exists dnp_plants_synonyms_trgm_idx
  on api.dnp_plants using gin (synonyms gin_trgm_ops);
create index if not exists dnp_plants_genus_idx
  on api.dnp_plants (genus);
