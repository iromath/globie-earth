-- Globie Earth :: 246 :: reconcile the Trees board rows with the community total
--
-- PRODUCT DECISION - this deliberately revisits the trade-off in 244.
--
-- 244 gave the Roadmap headline and the leaderboard's Trees tab one shared
-- number, api.community_trees() = sum(api.species.adopted_count). What it did
-- not do is make the *rows* of the Trees board add up to that number. Each
-- steward's value is sum(api.living_deeds.trees_planted) - only the deeds
-- api.create_adoption writes against a real device. The catalog's seeded
-- adopted counts (060_seed_catalog.sql: 57 + 37) and any adopted_count not
-- backed by a deed have no device behind them, so the rows summed to 61 while
-- the headline read 380. A steward saw the board quietly disagree with the page
-- it links from (exactly the complaint 244 was opened for).
--
-- 244 chose not to close that gap by writing placeholder deeds, because doing
-- so "would put a phantom steward at the top of the Trees board". The product
-- owner has since asked for the rows to reconcile by assigning the unattributed
-- balance to the stewards already on the board - which is not a phantom steward:
-- no new account is invented, and this file distributes the deficit in
-- proportion to each steward's existing deeds, so the ranking order does not
-- change. Only the magnitudes scale up to meet the community total.
--
-- Each share is written as a real (supplemental) adoption + living deed, so the
-- board stays a pure read of api.living_deeds - no query-time fudging, and the
-- stewardship records stay self-consistent. co2_offset_kg stays 0 so the CO2
-- board is untouched; no eco-tokens are awarded (that path is separate).
--
-- Idempotent: it measures adopted_count against living_deeds and does nothing
-- once they agree, so re-running is safe. It also (re)creates
-- api.community_trees() so the Trees tab banner works even if 244 was never
-- applied to this database.
--
-- Applied by hand like the rest of infra/schema/ (see docker-push.sh):
--   psql "$DATABASE_URL" -f infra/schema/246_steward_tree_reconciliation.sql

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
  'The community''s planted-tree total: the sum of api.species.adopted_count (244, reaffirmed by 246). The single figure the Roadmap headline and the leaderboard''s Trees tab both read.';

grant execute on function api.community_trees() to anon;

do $$
declare
  v_community  bigint;
  v_deeds      bigint;
  v_deficit    bigint;
  v_share_sum  bigint;
  v_remainder  bigint;
  v_leader     uuid;
  v_stewards   integer := 0;
  v_i          integer := 0;
  r            record;
  v_species_id text;
  v_pledge_thb numeric(10,2);
  v_pledge_usd numeric(10,2);
  v_adoption   uuid;
begin
  select coalesce(sum(s.adopted_count), 0)::bigint into v_community from api.species s;
  select coalesce(sum(d.trees_planted), 0)::bigint  into v_deeds     from api.living_deeds d;
  v_deficit := v_community - v_deeds;

  if v_deficit <= 0 then
    raise notice '246: Trees board already reconciles (% deeds vs % community) - nothing to do.',
      v_deeds, v_community;
    return;
  end if;

  -- Floor each steward's proportional slice of the deficit. floor() rounds
  -- down, so the shares under-count by v_remainder (0 <= remainder < stewards).
  create temporary table _steward_share on commit drop as
  select
    d.device_id,
    sum(d.trees_planted)::bigint as trees,
    floor(
      v_deficit::numeric * sum(d.trees_planted)::numeric
      / (select nullif(sum(d2.trees_planted), 0)::numeric from api.living_deeds d2)
    )::bigint as share
  from api.living_deeds d
  group by d.device_id
  having sum(d.trees_planted) > 0;

  select count(*) into v_stewards from _steward_share;
  if v_stewards = 0 then
    raise notice '246: % unattributed trees but no steward accounts to carry them - nothing to do.',
      v_deficit;
    return;
  end if;

  select coalesce(sum(share), 0) into v_share_sum from _steward_share;
  v_remainder := v_deficit - v_share_sum;

  -- Hand the rounding remainder to the steward already leading the board, so
  -- the order the board shows today is preserved.
  select device_id into v_leader
    from _steward_share
   order by trees desc, device_id
   limit 1;
  update _steward_share set share = share + v_remainder where device_id = v_leader;

  for r in
    select device_id, trees, share
      from _steward_share
     where share > 0
     order by trees desc, device_id
  loop
    v_i := v_i + 1;

    -- Alternate the two catalog species so the supplemental deeds read like
    -- ordinary adoptions rather than one species absorbing the whole balance.
    v_species_id := case when v_i % 2 = 0 then 'kae-na' else 'yang-na' end;

    select s.pledge_thb, s.pledge_usd
      into v_pledge_thb, v_pledge_usd
      from api.species s
     where s.id = v_species_id;

    -- Insert the adoption directly rather than through api.create_adoption:
    -- adopted_count already carries these trees, so going through the function
    -- would double-count them on the Roadmap. rc_product_id is the audit tag
    -- that makes this whole file reversible:
    --   delete from api.adoptions where rc_product_id = 'reconcile-246';
    -- (living_deeds cascades on the adoption FK.)
    insert into api.adoptions (
      device_id, species_id, pledge_thb, pledge_usd, status, rc_product_id, adopted_at
    ) values (
      r.device_id, v_species_id,
      v_pledge_thb * r.share, v_pledge_usd * r.share,
      'active', 'reconcile-246', now()
    )
    returning id into v_adoption;

    insert into api.living_deeds (
      adoption_id, device_id, trees_planted, co2_offset_kg, progress_pct
    ) values (
      v_adoption, r.device_id, r.share::integer, 0, 0
    );
  end loop;

  raise notice '246: assigned % trees across % stewards (board % -> %).',
    v_deficit, v_i, v_deeds, v_community;
end;
$$;

-- PostgREST caches function signatures; ask it to reload after the new rows.
notify pgrst, 'reload schema';
