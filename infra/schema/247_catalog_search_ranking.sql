-- Globie Earth :: 247 :: catalog_search re-ranks instead of trusting raw cosine
--
-- Semantic search runs over one flat api.embeddings space, and two failure modes
-- showed up in real use:
--
--   1. Near-duplicate rows. The DNP biodiversity survey stores one row per
--      (species, protected area, survey year) - Apatura ilia alone has 115 of
--      them - and the backfill appended each row's whole synonym list, so a
--      species with a long synonym list became a long, near-identical passage
--      repeated across tens of rows. Those passages sit close to the centroid of
--      the space, so they are near *every* query: a hub. top-k then returned the
--      same species several times and drowned the real answer. (Measured with
--      the live model: the Apatura passage scored ~0.80 even for a nonsense
--      query, which no unrelated passage should.)
--
--   2. No lexical signal. A caller asking for "Yang Na" should land on the row
--      literally called Yang Na, not on whatever passage the vector space places
--      nearest - especially with a small model whose cosine floor is high (~0.75
--      for unrelated text), where an absolute score cannot separate a match from
--      a neighbour.
--
-- This adds a second, optional argument - the raw query text - and makes the
-- ranking two-stage:
--
--   * stage 1 keeps the vector index: the nearest rows are fetched by cosine
--     distance (HNSW, vector_cosine_ops) over a window wider than the answer,
--     so the re-rank has material and can drop near-duplicates;
--   * stage 2 re-ranks those candidates by cosine plus a pg_trgm lexical match
--     of the resolved title against the query text, then keeps only the best row
--     per (entity_type, title).
--
-- `similarity` stays the raw cosine: the number a caller is shown is the one
-- actually computed, not the blended rank. When p_query_text is null (the web
-- client still calls with three arguments) the lexical term is zero and only the
-- wider window and the de-duplication change anything.
--
-- The three-argument function is dropped first: a fourth argument with a default
-- would otherwise make a three-argument call ambiguous between the two overloads
-- (PostgREST resolves an RPC by argument name, so it would have to choose).
drop function if exists api.catalog_search(vector, integer, text);

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
                    e.entity_id) as title,
           e.content,
           1 - (e.embedding <=> p_query) as cosine
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
    limit least(400, greatest(200, greatest(1, least(coalesce(p_match_count, 10), 50)) * 40))
  ),
  ranked as (
    -- A title that lexically matches the question ("Yang Na") is lifted above a
    -- passage that merely sits near it in a dense vector neighbourhood. The
    -- weight is large on purpose: cosine gaps between neighbours are ~0.01, so
    -- any real name match must win outright.
    select c.*,
           c.cosine
             + case
                 when p_query_text is null or p_query_text = '' then 0
                 else 0.35 * similarity(c.title, p_query_text)
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
