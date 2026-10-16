-- Globie Earth :: 254 :: Thai cookbook (the sanctuary's own recipe layer)
--
-- Globie Earth's catalogue already answers "what is this plant, where does it
-- grow, is it protected". A listener standing in a kitchen asks the next
-- question: "what do I cook with it?" This layer answers that from the project's
-- *own* cookbook - "Cookbook Version Kai & Shea" by Openmind Projects, the
-- trainees' recipe book the project publishes - so the answer is Globie's own
-- content, not a scraped recipe site.
--
-- Shape, mirroring the DNP reference layers (130/140/150): a world-readable
-- table, one row per dish, imported by scripts/import-cookbook.mjs from a
-- curated JSON checked into the repo (scripts/data/cookbook-recipes.json), then
-- made searchable by `npm run backfill:embeddings -- recipe` through the one
-- flat api.embeddings space. Embeds stay in one table (020_tables.sql) so
-- catalog_search compares recipes and species in a single cosine space.
--
-- Free-text lists - ingredients, numbered steps, tips - are jsonb rather than
-- child tables: they are read whole by the tool, never queried into, and jsonb
-- keeps the importer a plain upsert. The slug is the dish's stable identity, so
-- a re-import refreshes a row instead of duplicating it.

create table if not exists api.cookbook_recipes (
  id              bigserial primary key,
  slug            text not null,                 -- stable identity, e.g. 'som-tum-thai'
  name_en         text not null,                 -- English title as the book prints it
  name_local      text,                          -- romanised Thai name as printed (e.g. 'Gaeng Phed Gai')
  name_thai       text,                          -- Thai script, only where the book prints it (else null)
  region          text,                          -- northern | north-eastern | central | southern (null for the base pastes)
  category        text not null,                 -- dip | soup | curry | salad | noodle | stir-fry | steamed | grilled | fried | braise | paste
  servings        text,                           -- free text, because the book writes "2-3"
  total_minutes   integer,                        -- the book's own headline time
  description     text not null,                  -- the book's intro paragraph, verbatim
  ingredients     jsonb not null default '[]'::jsonb,   -- list of strings
  steps           jsonb not null default '[]'::jsonb,   -- list of { step, detail, minutes }
  tips            jsonb not null default '[]'::jsonb,   -- list of strings (the book's margin notes)
  -- Provenance, so a row can always be traced back to the book it came from.
  source          text not null default 'Openmind Kitchen Cookbook',
  source_url      text,
  license         text not null default 'OpenmindProjects',
  imported_at     timestamptz not null default now(),
  unique (slug)
);

comment on table api.cookbook_recipes is
  'Thai recipes curated from the Openmind Projects cookbook "Cookbook Version Kai & Shea". Globie Earth''s own recipe layer, embedded into api.embeddings as entity_type ''recipe'' so search_forest_knowledge and the cookbook tools can answer cooking questions.';

-- A keyword fallback matches with ILIKE, so each searchable name column gets a
-- trigram index - including name_local, which is how an English speaker types a
-- Thai dish name.
create index if not exists cookbook_recipes_name_en_trgm_idx
  on api.cookbook_recipes using gin (name_en gin_trgm_ops);
create index if not exists cookbook_recipes_name_local_trgm_idx
  on api.cookbook_recipes using gin (name_local gin_trgm_ops);
create index if not exists cookbook_recipes_name_thai_trgm_idx
  on api.cookbook_recipes using gin (name_thai gin_trgm_ops);
create index if not exists cookbook_recipes_region_idx
  on api.cookbook_recipes (region);
create index if not exists cookbook_recipes_category_idx
  on api.cookbook_recipes (category);

-- ------------------------------------------------------------------- RLS ----

-- World-readable, exactly like species/guardians/sites and the DNP layers: the
-- recipes are public and identical for every device, so there is no device
-- scoping. The default 010_bootstrap.sql grant (select/insert/update/delete to
-- anon) is narrowed to select only - the app and the MCP server read this,
-- nobody writes it through PostgREST (the importer runs as the migration role,
-- like backfill-embeddings.mjs does for api.embeddings).
alter table api.cookbook_recipes enable row level security;

drop policy if exists cookbook_recipes_read on api.cookbook_recipes;
create policy cookbook_recipes_read on api.cookbook_recipes
  for select to anon using (true);

revoke insert, update, delete on api.cookbook_recipes from anon;

-- ------------------------------------------- embeddings: admit the new type --

-- entity_type is a column-level CHECK (020_tables.sql, last widened by
-- 150_dnp_wildlife.sql). Postgres named it embeddings_entity_type_check from the
-- table and column, so drop-and-recreate is the only way to widen it (there is
-- no ALTER ... CHECK). This list must carry every live entity type, not just the
-- new one, or an existing row would violate it.
alter table api.embeddings drop constraint if exists embeddings_entity_type_check;
alter table api.embeddings add constraint embeddings_entity_type_check
  check (entity_type in ('species', 'site', 'guardian', 'dnp_species', 'dnp_plant', 'dnp_fauna', 'dnp_wildlife', 'recipe'));

-- --------------------------------------------- search: add the recipe join --

-- The 247_catalog_search_ranking.sql definition (four arguments, two-stage
-- re-rank, de-duplicated by (entity_type, title)), re-emitted with one more left
-- join so a recipe row resolves to its English title (else romanised, else Thai
-- script) as the title. Recomputed exactly as before for every other entity
-- type, so nothing about the existing rows changes. search_path, SECURITY
-- DEFINER, the widened ANN window and the gated pg_trgm lift are unchanged;
-- CREATE OR REPLACE keeps the grant made in 040_functions.sql.
create or replace function api.catalog_search(
  p_query       vector,
  p_match_count integer default 10,
  p_entity_type text default null,
  p_query_text  text default null
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
-- The window below asks the ANN index for more rows than the default
-- hnsw.ef_search (40) would explore; raise it so the index actually returns them.
set hnsw.ef_search = 400
as $$
  with candidates as (
    select e.entity_type,
           e.entity_id,
           coalesce(sp.name, gd.name, st.title,
                    dn.scientific_name, dn.thai_name,
                    dp.english_name, dp.scientific_name, dp.thai_name,
                    df.scientific_name, df.thai_name, df.protected_area,
                    dw.english_name, dw.scientific_name, dw.thai_name,
                    rc.name_en, rc.name_local, rc.name_thai,
                    e.entity_id) as title,
           e.content,
           1 - (e.embedding <=> p_query) as cosine
    from api.embeddings e
    left join api.species          sp on e.entity_type = 'species'      and sp.id = e.entity_id
    left join api.guardians        gd on e.entity_type = 'guardian'     and gd.id = e.entity_id
    left join api.sites            st on e.entity_type = 'site'         and st.id::text = e.entity_id
    left join api.dnp_species      dn on e.entity_type = 'dnp_species'  and dn.id::text = e.entity_id
    left join api.dnp_plants       dp on e.entity_type = 'dnp_plant'    and dp.id::text = e.entity_id
    left join api.dnp_fauna        df on e.entity_type = 'dnp_fauna'    and df.id::text = e.entity_id
    left join api.dnp_wildlife     dw on e.entity_type = 'dnp_wildlife' and dw.id::text = e.entity_id
    left join api.cookbook_recipes rc on e.entity_type = 'recipe'       and rc.id::text = e.entity_id
    where p_query is not null
      and (p_entity_type is null or e.entity_type = p_entity_type)
    order by e.embedding <=> p_query
    limit least(400, greatest(200, greatest(1, least(coalesce(p_match_count, 10), 50)) * 40))
  ),
  ranked as (
    -- A title that lexically matches the query lifts above a passage that merely
    -- sits near it in a dense vector neighbourhood. The match is gated at 0.45 so
    -- it fires only on a near-exact name (see 247_catalog_search_ranking.sql).
    select c.*,
           c.cosine
             + case
                 when p_query_text is null or p_query_text = '' then 0
                 when similarity(c.title, p_query_text) >= 0.45
                   then 0.35 * similarity(c.title, p_query_text)
                 else 0
               end as score
    from candidates c
  ),
  best as (
    select distinct on (entity_type, title)
           entity_type, entity_id, title, content, cosine, score
    from ranked
    order by entity_type, title, score desc
  )
  select entity_type, entity_id, title, content, cosine as similarity
  from best
  order by score desc
  limit greatest(1, least(coalesce(p_match_count, 10), 50))
$$;

grant execute on function api.catalog_search(vector, integer, text, text) to anon;

-- A new table and a re-emitted function are invisible to PostgREST until it is
-- told to re-read the schema: this file is applied by hand, so ask it to reload
-- or the first call fails with PGRST205 ("Could not find the table
-- 'api.cookbook_recipes' in the schema cache").
notify pgrst, 'reload schema';
