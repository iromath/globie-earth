-- Globie Earth :: 140 :: DNP national-park fauna (external reference layer)
--
-- "Migrate the decisions, not the dump" (Dev-Docs/PODCAST-INTEGRATION-PLAN.md 2.2):
-- 120_dnp.sql imported the DNP biodiversity *survey* (what grows/lives where across
-- protected areas, BE 2554-2564) and 130_dnp_plants.sql the national plant
-- checklist. This is a third, different DNP artefact: the *fauna* observed inside
-- national parks - one row per (park, species) observation, with taxonomy (order,
-- family, genus), conservation status (IUCN / ONEP / CITES) and the park's
-- approximate location. It is reference fact about where animals were recorded,
-- so it sits in its own table and is never merged into api.species for the same
-- reason as the survey and the checklist: merging would swamp Globie's adoptable
-- catalogue with animals nobody can plant.
--
-- The upstream carries Thai and English names, scientific name and the full
-- taxonomic breadcrumb, so no translation step is needed here (unlike the plant
-- checklist, which had to resolve English from GBIF). IUCN2004 / ONEP2005 /
-- CITES are already the codes the sources publish, so they are stored verbatim.
--
-- Source: https://catalog.dnp.go.th/dataset/animalnationalpark
--   (Forest and Plant Conservation Research Office, "Open Data Common" licence.)
--
-- Embeddings stay one table (020_tables.sql) so catalog_search compares every
-- entity in a single cosine space. Its entity_type CHECK is widened below to
-- admit 'dnp_fauna', and catalog_search gains the matching join.

create table if not exists api.dnp_fauna (
  id             bigserial primary key,
  -- Provenance, so a row can always be traced back to the exact upstream export.
  resource_id    text not null,                 -- CKAN resource uuid
  source_id      text not null,                 -- CKAN datastore row _id
  source_url     text not null,
  license        text not null default 'Open Data Common',
  imported_at    timestamptz not null default now(),
  -- The observation fields, one column per upstream column (Thai names in comments).
  -- group_type is nullable: the upstream leaves MBIO_DES_T_EDIT blank for ~2,700
  -- of the 5,112 rows (and BIO_CODE does not encode the group cleanly), so a
  -- missing group is stored as missing rather than invented.
  group_type     text,                          -- MBIO_DES_T_EDIT (animal group)
  protected_area text not null,                 -- PTA_NAM_T (park, Thai)
  protected_area_en text,                       -- PTA_NAM_E (park, English)
  thai_name      text,                          -- COM_NAME_T (ชื่อไทย)
  thai_name_alt  text,                          -- COM_NAME_T1 (alternate Thai name)
  scientific_name text,                         -- SCI_N_E (ชื่อวิทยาศาสตร์)
  order_name     text,                          -- ORD_N_E (อันดับ)
  family         text,                          -- FAM_N_E (วงศ์)
  genus          text,                          -- GN_N_E (สกุล)
  iucn_status    text,                          -- IUCN2004 (IUCN category code)
  onep_status    text,                          -- ONEP2005 (Thai ONEP status code)
  cites_status   text,                          -- CITES (appendix)
  habitat        text,                          -- HABITAT
  distribution   text,                          -- DISTRIBUTI
  location       text,                          -- LOC_N_T (site inside the park, Thai)
  location_en    text,                          -- LOC_N_E (site inside the park, English)
  province       text,                          -- IN_PROV (comma-joined Thai provinces)
  latitude       double precision,              -- Y_INDIAN75 (Indian 1975 northing)
  longitude      double precision,              -- X_INDIAN75 (Indian 1975 easting)
  -- One upstream row appears once. A re-import is an update, not a duplicate.
  unique (resource_id, source_id)
);

comment on table api.dnp_fauna is
  'DNP national-park fauna observations (species recorded inside protected areas, with taxonomy and IUCN/ONEP/CITES status). External reference data under the Open Data Common licence - not Globie''s own adoptable catalogue.';

-- A keyword fallback matches with ILIKE, so each searchable name column gets a
-- trigram index - including the park and family, which a listener often asks by.
create index if not exists dnp_fauna_scientific_trgm_idx
  on api.dnp_fauna using gin (scientific_name gin_trgm_ops);
create index if not exists dnp_fauna_thai_trgm_idx
  on api.dnp_fauna using gin (thai_name gin_trgm_ops);
create index if not exists dnp_fauna_area_trgm_idx
  on api.dnp_fauna using gin (protected_area gin_trgm_ops);
create index if not exists dnp_fauna_family_idx
  on api.dnp_fauna (family);

-- ------------------------------------------------------------------- RLS ----

-- World-readable, exactly like species/guardians/sites and the other DNP layers:
-- the fauna list is public and identical for every device, so there is no device
-- scoping. The default 010_bootstrap.sql grant (select/insert/update/delete to
-- anon) is narrowed to select only - the app and the MCP server read this,
-- nobody writes it through PostgREST (the importer runs as the migration role,
-- like backfill-embeddings.mjs does for api.embeddings).
alter table api.dnp_fauna enable row level security;

drop policy if exists dnp_fauna_read on api.dnp_fauna;
create policy dnp_fauna_read on api.dnp_fauna
  for select to anon using (true);

revoke insert, update, delete on api.dnp_fauna from anon;

-- ------------------------------------------- embeddings: admit the new type --

-- entity_type is a column-level CHECK (020_tables.sql, last widened by
-- 130_dnp_plants.sql). Postgres named it embeddings_entity_type_check from the
-- table and column, so drop-and-recreate is the only way to widen it (there is
-- no ALTER ... CHECK). This list must carry every live entity type, not just the
-- new one, or an existing row would violate it.
alter table api.embeddings drop constraint if exists embeddings_entity_type_check;
alter table api.embeddings add constraint embeddings_entity_type_check
  check (entity_type in ('species', 'site', 'guardian', 'dnp_species', 'dnp_plant', 'dnp_fauna'));

-- ---------------------------------------------- search: add the fauna join --

-- Same contract as 040_functions.sql (and 120/130), with one more left join so a
-- fauna row resolves to its scientific (else English park, else Thai) name as the
-- title. Recomputed exactly as before for every other entity type, so nothing
-- about the existing rows changes. search_path and SECURITY DEFINER are
-- unchanged; CREATE OR REPLACE keeps the grant made in 040_functions.sql.
create or replace function api.catalog_search(
  p_query       vector,
  p_match_count integer default 10,
  p_entity_type text default null
) returns table (
  entity_type text,
  entity_id   text,
  title       text,
  content     text,
  similarity  double precision
)
language sql
stable
security definer
set search_path = api, public
as $$
  select e.entity_type,
         e.entity_id,
         coalesce(sp.name, gd.name, st.title,
                  dn.scientific_name, dn.thai_name,
                  dp.english_name, dp.scientific_name, dp.thai_name,
                  df.scientific_name, df.thai_name, df.protected_area,
                  e.entity_id),
         e.content,
         1 - (e.embedding <=> p_query)
  from api.embeddings e
  left join api.species     sp on e.entity_type = 'species'     and sp.id = e.entity_id
  left join api.guardians   gd on e.entity_type = 'guardian'    and gd.id = e.entity_id
  left join api.sites       st on e.entity_type = 'site'        and st.id::text = e.entity_id
  left join api.dnp_species dn on e.entity_type = 'dnp_species' and dn.id::text = e.entity_id
  left join api.dnp_plants  dp on e.entity_type = 'dnp_plant'   and dp.id::text = e.entity_id
  left join api.dnp_fauna   df on e.entity_type = 'dnp_fauna'   and df.id::text = e.entity_id
  where p_query is not null
    and (p_entity_type is null or e.entity_type = p_entity_type)
  order by e.embedding <=> p_query
  limit greatest(1, least(coalesce(p_match_count, 10), 50))
$$;

grant execute on function api.catalog_search(vector, integer, text) to anon;
