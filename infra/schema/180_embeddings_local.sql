-- Globie Earth :: 180 :: self-hosted embeddings - the vector space narrows to 384
--
-- 020_tables.sql declared api.embeddings.embedding as vector(1536) for Amazon
-- Titan Text Embeddings V1, the only provider then imagined. That plan changed:
-- the AWS account holding this stack is under new-account verification, so the
-- Bedrock data plane answers every InvokeModel with
-- `ValidationException: Operation not allowed` and Titan cannot embed anything.
-- The default provider is now the self-hosted model
-- (Xenova/multilingual-e5-small through transformers.js, 384 dims), which needs
-- no account and bills nothing. See infra/mcp/src/embed.ts.
--
-- A vector only means something in the space of the model that wrote it, so the
-- stored width has to follow the model. This migration:
--
--   1. clears api.embeddings, because a 1536-wide row is unreadable by the
--      384-wide model and a width change cannot preserve it;
--   2. moves the column to vector(384) and rebuilds the HNSW index over it;
--   3. moves the api.app_config provenance rows to the new model and width, so
--      the client's dimension check (src/lib/api.ts) agrees with the column.
--
-- The vectors themselves are not migrated: 060_seed_catalog.sql ships none, and
-- Bedrock never produced any, so there is nothing to carry across. The re-embed
-- is scripts/backfill-embeddings.mjs, run as the migration role because
-- 030_rls.sql revokes all on api.embeddings from anon.
--
-- api.catalog_search is deliberately NOT redefined here. Its p_query is an
-- untyped `vector` and its body (`1 - (e.embedding <=> p_query)`) is
-- dimension-agnostic, so the same function serves either width - and re-emitting
-- it would be a second copy of the definition in 040/150 that could drift.

-- 1. Drop only rows the new model could not read. On the intended first run the
-- column is still vector(1536), so vector_dims() is 1536 for every row and this
-- clears the table. Guarding on the width rather than an unconditional delete
-- keeps a re-run from wiping a fresh backfill.
delete from api.embeddings where vector_dims(embedding) <> 384;

-- 2. The HNSW index is built over the very column being retyped, so it is
-- dropped first and rebuilt at the new width rather than left to be rebuilt
-- implicitly by the ALTER. (The other two indexes are on entity_type/entity_id
-- and content, so the retype does not touch them.)
drop index if exists api.embeddings_hnsw_idx;

alter table api.embeddings
  alter column embedding type vector(384);

-- The column default, so a row inserted without an explicit model still names
-- the one model that produces this width. backfill-embeddings.mjs always writes
-- `model` explicitly; this is the safety net 020_tables.sql left pointing at
-- Titan.
alter table api.embeddings
  alter column model set default 'Xenova/multilingual-e5-small';

create index if not exists embeddings_hnsw_idx
  on api.embeddings using hnsw (embedding vector_cosine_ops);

-- 3. Embedding provenance. 010_bootstrap.sql seeds these; the client reads
-- embedding_dims to size its query vector, so both rows move with the column.
insert into api.app_config (key, value) values
  ('embedding_model', 'Xenova/multilingual-e5-small'),
  ('embedding_dims',  '384')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
