-- Globie Earth :: 150 :: DNP national wildlife checklist + legal status
--
-- "Migrate the decisions, not the dump" (Dev-Docs/PODCAST-INTEGRATION-PLAN.md 2.2):
-- 120_dnp.sql imported the biodiversity survey, 130_dnp_plants.sql the national
-- plant checklist, 140_dnp_fauna.sql the national-park fauna observations. This is
-- the *national wildlife checklist* - the official list of the animals of Thailand
-- (birds, mammals, reptiles, amphibians) - merged with the two statutory lists
-- that define which of them are legally protected or reserved.
--
-- Two upstream shapes feed one table:
--   * The four "ชนิดพันธุ์สัตว์ป่าในประเทศไทย" PDFs (dataset wildlife), one per
--     class. Each row carries a Thai, scientific and English name, up to three
--     ONEP status columns (BE 2548/2560/2565), an IUCN 2022 category, a CITES
--     appendix, a legal-status code, and - for birds - a seasonal-status code.
--     The PDFs are laid out as a table, so the importer reads the columns by
--     word coordinates (pdftotext -bbox-layout); see import-dnp-wildlife.mjs.
--   * The two statutory lists, both datastore_active: "บัญชีสัตว์ป่าคุ้มครอง"
--     (protected, 55 rows) and "บัญชีสัตว์ป่าสงวน" (reserved, 19 rows). These are
--     authoritative, so they set is_protected / is_reserved by scientific name,
--     and a species that appears only on a statutory list still gets a row.
--
-- It is reference fact about the national fauna, so it sits in its own table and
-- is never merged into api.species for the same reason as the other DNP layers:
-- merging would swamp Globie's adoptable catalogue with animals nobody can plant.
--
-- Source: https://catalog.dnp.go.th/dataset/wildlife
--         https://catalog.dnp.go.th/dataset/dnp09_data21_02 (protected)
--         https://catalog.dnp.go.th/dataset/dnp09_data21_01 (reserved)
--   ("Open Data Common" licence.)
--
-- Embeddings stay one table (020_tables.sql) so catalog_search compares every
-- entity in a single cosine space. Its entity_type CHECK is widened below to
-- admit 'dnp_wildlife', and catalog_search gains the matching join.

create table if not exists api.dnp_wildlife (
  id             bigserial primary key,
  -- Provenance, so a row can always be traced back to its upstream source.
  resource_id    text not null,                 -- CKAN resource uuid (or list id)
  source_id      text not null,                 -- the row's own ordinal in its source
  source_url     text not null,
  license        text not null default 'Open Data Common',
  imported_at    timestamptz not null default now(),
  -- The checklist fields, one column per upstream column (Thai names in comments).
  group_type     text not null,                 -- class: birds / mammals / reptiles / amphibians
  thai_name      text,                          -- ชื่อไทย
  scientific_name text not null,                -- ชื่อวิทยาศาสตร์ (the row's identity)
  english_name   text,                          -- ชื่อสามัญ
  order_name     text,                          -- running "Order ..." taxonomy from the PDF
  family         text,                          -- running "Family ..." taxonomy from the PDF
  legal_status   text,                          -- สถานภาพตามกฏหมาย (ส = reserved, ค = protected)
  -- The two statutory lists, matched by scientific name. Authoritative: a species
  -- on the reserved list is reserved even where the checklist is silent.
  is_reserved    boolean not null default false,
  is_protected   boolean not null default false,
  -- The three ONEP assessments (BE 2548 / 2560 / 2565) and the world statuses.
  onep_2548      text,
  onep_2560      text,
  onep_2565      text,
  iucn_status    text,                          -- IUCN 2022 category code
  cites_status   text,                          -- CITES appendix
  seasonal_status text,                         -- สถานภาพตามฤดูกาล (birds only: R/B/N/V)
  note           text,                          -- หมายเหตุ
  -- A national checklist names a species once, across all four classes, and the
  -- scientific name is its stable identity. A re-import is an update, not a
  -- duplicate.
  unique (scientific_name)
);

comment on table api.dnp_wildlife is
  'DNP national wildlife checklist (birds, mammals, reptiles, amphibians) with ONEP/IUCN/CITES status and statutory protected/reserved flags. External reference data under the Open Data Common licence - not Globie''s own adoptable catalogue.';

-- A keyword fallback matches with ILIKE, so each searchable name column gets a
-- trigram index - including english_name, which the app and voice surface search.
create index if not exists dnp_wildlife_scientific_trgm_idx
  on api.dnp_wildlife using gin (scientific_name gin_trgm_ops);
create index if not exists dnp_wildlife_thai_trgm_idx
  on api.dnp_wildlife using gin (thai_name gin_trgm_ops);
create index if not exists dnp_wildlife_english_trgm_idx
  on api.dnp_wildlife using gin (english_name gin_trgm_ops);
create index if not exists dnp_wildlife_group_idx
  on api.dnp_wildlife (group_type);
create index if not exists dnp_wildlife_family_idx
  on api.dnp_wildlife (family);

-- ------------------------------------------------------------------- RLS ----

-- World-readable, exactly like species/guardians/sites and the other DNP layers:
-- the checklist is public and identical for every device, so there is no device
-- scoping. The default 010_bootstrap.sql grant (select/insert/update/delete to
-- anon) is narrowed to select only - the app and the MCP server read this,
-- nobody writes it through PostgREST (the importer runs as the migration role,
-- like backfill-embeddings.mjs does for api.embeddings).
alter table api.dnp_wildlife enable row level security;

drop policy if exists dnp_wildlife_read on api.dnp_wildlife;
create policy dnp_wildlife_read on api.dnp_wildlife
  for select to anon using (true);

revoke insert, update, delete on api.dnp_wildlife from anon;

-- ------------------------------------------- embeddings: admit the new type --

-- entity_type is a column-level CHECK (020_tables.sql, last widened by
-- 140_dnp_fauna.sql). Postgres named it embeddings_entity_type_check from the
-- table and column, so drop-and-recreate is the only way to widen it (there is
-- no ALTER ... CHECK). This list must carry every live entity type, not just the
-- new one, or an existing row would violate it.
alter table api.embeddings drop constraint if exists embeddings_entity_type_check;
alter table api.embeddings add constraint embeddings_entity_type_check
  check (entity_type in ('species', 'site', 'guardian', 'dnp_species', 'dnp_plant', 'dnp_fauna', 'dnp_wildlife'));

-- ------------------------------------------- search: add the wildlife join --

-- Same contract as 040_functions.sql (and 120/130/140), with one more left join
-- so a wildlife row resolves to its English (else scientific, else Thai) name as
-- the title. Recomputed exactly as before for every other entity type, so nothing
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
                  dw.english_name, dw.scientific_name, dw.thai_name,
                  e.entity_id),
         e.content,
         1 - (e.embedding <=> p_query)
  from api.embeddings e
  left join api.species     sp on e.entity_type = 'species'      and sp.id = e.entity_id
  left join api.guardians   gd on e.entity_type = 'guardian'     and gd.id = e.entity_id
  left join api.sites       st on e.entity_type = 'site'         and st.id::text = e.entity_id
  left join api.dnp_species dn on e.entity_type = 'dnp_species'  and dn.id::text = e.entity_id
  left join api.dnp_plants  dp on e.entity_type = 'dnp_plant'    and dp.id::text = e.entity_id
  left join api.dnp_fauna   df on e.entity_type = 'dnp_fauna'    and df.id::text = e.entity_id
  left join api.dnp_wildlife dw on e.entity_type = 'dnp_wildlife' and dw.id::text = e.entity_id
  where p_query is not null
    and (p_entity_type is null or e.entity_type = p_entity_type)
  order by e.embedding <=> p_query
  limit greatest(1, least(coalesce(p_match_count, 10), 50))
$$;

grant execute on function api.catalog_search(vector, integer, text) to anon;
