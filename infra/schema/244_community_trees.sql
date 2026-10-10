-- Globie Earth :: 244 :: one number for the community's planted trees
--
-- The Roadmap headline and the Trees tab of the leaderboard were reporting
-- different quantities. The Roadmap sums api.species.adopted_count - the
-- denormalised counter api.create_adoption bumps on every pledge, which already
-- carries the catalog's seeded baseline (060_seed_catalog.sql: 57 + 37 = 94).
-- The Trees tab sums api.living_deeds.trees_planted per account, which starts
-- from zero and so never shows that baseline. A steward comparing the two saw
-- the board quietly disagreeing with the page it links from.
--
-- This exposes the Roadmap's number as one callable total, so both surfaces read
-- the same source instead of each computing its own sum. It deliberately counts
-- species.adopted_count rather than living_deeds: the seeded baseline is a
-- catalog fact with no device behind it, and writing 94 placeholder deeds would
-- put a phantom steward at the top of the Trees board. Every live pledge still
-- moves this total, because create_adoption writes adopted_count and the deed
-- together (040_functions.sql, 080_account_ownership.sql).
--
-- Idempotent; applied by hand like the rest of infra/schema/ (see docker-push.sh).

create or replace function api.community_trees()
returns bigint
language sql
stable
security definer
set search_path = api, public
as $$
  select coalesce(sum(s.adopted_count), 0)::bigint from api.species s;
$$;

comment on function api.community_trees() is
  'The community''s planted-tree total: the sum of api.species.adopted_count, which includes the catalog''s seeded baseline and every pledge create_adoption records. The single figure the Roadmap headline and the leaderboard''s Trees tab both read (244).';

grant execute on function api.community_trees() to anon;

-- PostgREST caches function signatures; this file is applied by hand rather
-- than by a restart, so ask it to reload.
notify pgrst, 'reload schema';
