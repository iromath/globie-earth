-- Globie Earth :: 120 :: DNP biodiversity survey (external reference layer)
--
-- "Migrate the decisions, not the dump" (Dev-Docs/PODCAST-INTEGRATION-PLAN.md 2.2):
-- what belongs in Postgres is the survey rows we actually search over, not the
-- upstream CKAN export. 110_podcast.sql kept its 4.7 M-row mirror on disk; here
-- the row count is small enough (61k) that the rows themselves are the useful
-- artefact, so they are imported - but they are kept in their own table, never
-- merged into api.species. DNP data is reference fact about protected-area
-- surveys (plants/insects/fungi/wildlife, BE 2554-2564), not Globie's own
-- adoptable catalogue: merging would swamp adoption, quota and recommendation
-- logic with species nobody can plant.
--
-- Source: https://catalog.dnp.go.th/dataset/biodiversity-survey-species
--   (Forest Research Office, "Open Data Common" licence.)
--
-- Embeddings stay one table (020_tables.sql) so catalog_search compares every
-- entity in a single cosine space. That table's entity_type CHECK is widened
-- below to admit 'dnp_species', and catalog_search gains the matching join.

create table if not exists api.dnp_species (
  id             bigserial primary key,
  -- Provenance, so a hit can always be traced back to the exact upstream row.
  resource_id    text not null,                 -- CKAN resource uuid
  source_id      text not null,                 -- CKAN datastore row _id
  source_url     text not null,
  license        text not null default 'Open Data Common',
  imported_at    timestamptz not null default now(),
  -- The surveyed fields, one column per upstream column (Thai names in comments).
  group_type     text not null,                 -- ประเภท (Plants / Insects / Fungi / Wildlife)
  protected_area text not null,                 -- พื้นที่อนุรักษ์
  forest_type    text,                          -- สังคมป่า
  survey_year_be integer,                       -- ปีที่สำรวจ (Buddhist Era)
  thai_name      text,                          -- ชื่อไทย
  scientific_name text,                         -- ชื่อวิทยาศาสตร์
  family         text,                          -- ชื่อวงศ์
  synonyms       text,                          -- ชื่อพ้อง
  -- One upstream row appears once. A re-import is an update, not a duplicate.
  unique (resource_id, source_id)
);

comment on table api.dnp_species is
  'DNP biodiversity survey rows (protected areas, BE 2554-2564). External reference data under the Open Data Common licence - not Globie''s own adoptable catalogue.';

-- A keyword fallback matches with ILIKE, so both name columns get trigram indexes.
create index if not exists dnp_species_scientific_trgm_idx
  on api.dnp_species using gin (scientific_name gin_trgm_ops);
create index if not exists dnp_species_thai_trgm_idx
  on api.dnp_species using gin (thai_name gin_trgm_ops);
create index if not exists dnp_species_area_idx
  on api.dnp_species (protected_area);

-- ------------------------------------------------------------------- RLS ----

-- World-readable, exactly like species/guardians/sites: the survey is public
-- and identical for every device, so there is no device scoping. The default
-- 010_bootstrap.sql grant (select/insert/update/delete to anon) is narrowed to
-- select only - the app and the MCP server read this, nobody writes it through
-- PostgREST (the importer runs as the migration role, like backfill-embeddings).
alter table api.dnp_species enable row level security;

drop policy if exists dnp_species_read on api.dnp_species;
create policy dnp_species_read on api.dnp_species
  for select to anon using (true);

revoke insert, update, delete on api.dnp_species from anon;

-- ------------------------------------------- embeddings: admit the new type --

-- entity_type is a column-level CHECK (020_tables.sql). Postgres named it
-- embeddings_entity_type_check from the table and column, so drop-and-recreate
-- is the only way to widen it (there is no ALTER ... CHECK).
alter table api.embeddings drop constraint if exists embeddings_entity_type_check;
alter table api.embeddings add constraint embeddings_entity_type_check
  check (entity_type in ('species', 'site', 'guardian', 'dnp_species'));

-- ------------------------------------------------- search: add the DNP join --

-- Same contract as 040_functions.sql, with one extra left join so a DNP row
-- resolves to its scientific (else Thai) name as the title. Recomputed exactly
-- as before for every other entity type, so nothing about the existing rows
-- changes. search_path and SECURITY DEFINER are unchanged; CREATE OR REPLACE
-- keeps the grant made in 040_functions.sql.
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
         coalesce(sp.name, gd.name, st.title, dn.scientific_name, dn.thai_name, e.entity_id),
         e.content,
         1 - (e.embedding <=> p_query)
  from api.embeddings e
  left join api.species     sp on e.entity_type = 'species'     and sp.id = e.entity_id
  left join api.guardians   gd on e.entity_type = 'guardian'    and gd.id = e.entity_id
  left join api.sites       st on e.entity_type = 'site'        and st.id::text = e.entity_id
  left join api.dnp_species dn on e.entity_type = 'dnp_species' and dn.id::text = e.entity_id
  where p_query is not null
    and (p_entity_type is null or e.entity_type = p_entity_type)
  order by e.embedding <=> p_query
  limit greatest(1, least(coalesce(p_match_count, 10), 50))
$$;

grant execute on function api.catalog_search(vector, integer, text) to anon;
