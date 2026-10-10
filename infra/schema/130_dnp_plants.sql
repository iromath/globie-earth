-- Globie Earth :: 130 :: DNP plant checklist (external reference layer)
--
-- "Migrate the decisions, not the dump" (Dev-Docs/PODCAST-INTEGRATION-PLAN.md 2.2):
-- 120_dnp.sql imported the DNP biodiversity *survey* (what grows where, protected
-- areas, BE 2554-2564). This is a second, different DNP artefact: a national
-- checklist of the plant species recorded in Thailand - one row per species, no
-- location and no year. It is a taxonomy list, so it sits in its own table and
-- is never merged into api.species for the same reason as the survey: merging
-- would swamp Globie's adoptable catalogue with species nobody can plant.
--
-- The upstream ships two Thai-script fields (the local name) and two Latin ones
-- (scientific name, family). "English" therefore means an English *common* name,
-- which the upstream does not carry - the importer resolves one per species from
-- GBIF's vernacular-name index (the citable authority), and stores null when
-- GBIF has none, rather than inventing a translation.
--
-- Source: https://catalog.dnp.go.th/dataset/plant-species
--   (Forest and Plant Conservation Research Office, "Open Data Common" licence.)
--
-- Embeddings stay one table (020_tables.sql) so catalog_search compares every
-- entity in a single cosine space. Its entity_type CHECK is widened below to
-- admit 'dnp_plant', and catalog_search gains the matching join.

create table if not exists api.dnp_plants (
  id             bigserial primary key,
  -- Provenance, so a row can always be traced back to the exact upstream export.
  resource_id    text not null,                 -- CKAN resource uuid
  source_id      text not null,                 -- the CSV's own "No." column
  source_url     text not null,
  license        text not null default 'Open Data Common',
  imported_at    timestamptz not null default now(),
  -- The checklist fields, one column per upstream column (Thai names in comments).
  thai_name      text,                          -- LocalName_Thai (ชื่อไทย)
  scientific_name text not null,                -- Botanical_Name (ชื่อวิทยาศาสตร์)
  family         text,                          -- Family_Name (ชื่อวงศ์)
  -- The English common name, resolved from GBIF, and its provenance. english_name
  -- is null when GBIF documents no English vernacular name for the species.
  english_name   text,
  english_source text,                          -- 'gbif' whenever english_name is set
  gbif_key       bigint,                        -- the GBIF usageKey that resolved it
  gbif_match_type text,                         -- EXACT / FUZZY / HIGHERRANK / NONE
  gbif_confidence integer,                      -- GBIF match confidence, 0..100
  -- A checklist names a species once, and the scientific name is its stable
  -- identity (unlike the CSV's "No.", which is just a row counter that DNP may
  -- renumber). A re-import is an update, not a duplicate.
  unique (resource_id, scientific_name)
);

comment on table api.dnp_plants is
  'DNP plant checklist: species recorded in Thailand, with an English common name resolved from GBIF. External reference data under the Open Data Common licence - not Globie''s own adoptable catalogue.';

-- A keyword fallback matches with ILIKE, so each searchable name column gets a
-- trigram index - including english_name, which the app and voice surface search.
create index if not exists dnp_plants_scientific_trgm_idx
  on api.dnp_plants using gin (scientific_name gin_trgm_ops);
create index if not exists dnp_plants_thai_trgm_idx
  on api.dnp_plants using gin (thai_name gin_trgm_ops);
create index if not exists dnp_plants_english_trgm_idx
  on api.dnp_plants using gin (english_name gin_trgm_ops);
create index if not exists dnp_plants_family_idx
  on api.dnp_plants (family);

-- ------------------------------------------------------------------- RLS ----

-- World-readable, exactly like species/guardians/sites and the DNP survey: the
-- checklist is public and identical for every device, so there is no device
-- scoping. The default 010_bootstrap.sql grant (select/insert/update/delete to
-- anon) is narrowed to select only - the app and the MCP server read this,
-- nobody writes it through PostgREST (the importer runs as the migration role,
-- like backfill-embeddings.mjs does for api.embeddings).
alter table api.dnp_plants enable row level security;

drop policy if exists dnp_plants_read on api.dnp_plants;
create policy dnp_plants_read on api.dnp_plants
  for select to anon using (true);

revoke insert, update, delete on api.dnp_plants from anon;

-- ------------------------------------------- embeddings: admit the new type --

-- entity_type is a column-level CHECK (020_tables.sql, last widened by
-- 120_dnp.sql). Postgres named it embeddings_entity_type_check from the table
-- and column, so drop-and-recreate is the only way to widen it (there is no
-- ALTER ... CHECK). This list must carry every live entity type, not just the
-- new one, or an existing row would violate it.
alter table api.embeddings drop constraint if exists embeddings_entity_type_check;
alter table api.embeddings add constraint embeddings_entity_type_check
  check (entity_type in ('species', 'site', 'guardian', 'dnp_species', 'dnp_plant'));

-- --------------------------------------------- search: add the plant join --

-- Same contract as 040_functions.sql (and 120_dnp.sql), with one more left join
-- so a plant row resolves to its English common name (else scientific, else
-- Thai) as the title. Recomputed exactly as before for every other entity type,
-- so nothing about the existing rows changes. search_path and SECURITY DEFINER
-- are unchanged; CREATE OR REPLACE keeps the grant made in 040_functions.sql.
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
                  e.entity_id),
         e.content,
         1 - (e.embedding <=> p_query)
  from api.embeddings e
  left join api.species     sp on e.entity_type = 'species'     and sp.id = e.entity_id
  left join api.guardians   gd on e.entity_type = 'guardian'    and gd.id = e.entity_id
  left join api.sites       st on e.entity_type = 'site'        and st.id::text = e.entity_id
  left join api.dnp_species dn on e.entity_type = 'dnp_species' and dn.id::text = e.entity_id
  left join api.dnp_plants  dp on e.entity_type = 'dnp_plant'   and dp.id::text = e.entity_id
  where p_query is not null
    and (p_entity_type is null or e.entity_type = p_entity_type)
  order by e.embedding <=> p_query
  limit greatest(1, least(coalesce(p_match_count, 10), 50))
$$;

grant execute on function api.catalog_search(vector, integer, text) to anon;
