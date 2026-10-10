-- Globie Earth :: 040 :: functions exposed as PostgREST RPCs
--
-- All of these are SECURITY DEFINER and owned by the migration role, so they
-- read and write across RLS. Each one that touches device data derives the
-- device from private.device_id() (the X-Device-Id header) rather than trusting
-- a caller-supplied argument.

-- ------------------------------------------------- semantic search (d) -----

-- Nearest catalog chunks to a caller-computed query vector. The client embeds
-- the query text (refresh api.app_config for the expected model/dimension) and
-- posts the vector; nothing here depends on a server-side provider.
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
         coalesce(sp.name, gd.name, st.title, e.entity_id),
         e.content,
         1 - (e.embedding <=> p_query)
  from api.embeddings e
  left join api.species   sp on e.entity_type = 'species'  and sp.id = e.entity_id
  left join api.guardians gd on e.entity_type = 'guardian' and gd.id = e.entity_id
  left join api.sites     st on e.entity_type = 'site'     and st.id::text = e.entity_id
  where p_query is not null
    and (p_entity_type is null or e.entity_type = p_entity_type)
  order by e.embedding <=> p_query
  limit greatest(1, least(coalesce(p_match_count, 10), 50))
$$;

-- Similar items to a catalog entity. Needs no query embedding, so it works
-- with no embedding provider configured at all.
create or replace function api.similar_content(
  p_entity_type text,
  p_entity_id   text,
  p_match_count integer default 5
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
  with seed as (
    select avg(e.embedding) as embedding
    from api.embeddings e
    where e.entity_type = p_entity_type
      and e.entity_id = p_entity_id
  )
  select e.entity_type,
         e.entity_id,
         coalesce(sp.name, gd.name, st.title, e.entity_id),
         e.content,
         1 - (e.embedding <=> sd.embedding)
  from api.embeddings e
  cross join seed sd
  left join api.species   sp on e.entity_type = 'species'  and sp.id = e.entity_id
  left join api.guardians gd on e.entity_type = 'guardian' and gd.id = e.entity_id
  left join api.sites     st on e.entity_type = 'site'     and st.id::text = e.entity_id
  where sd.embedding is not null
    and not (e.entity_type = p_entity_type and e.entity_id = p_entity_id)
  order by e.embedding <=> sd.embedding
  limit greatest(1, least(coalesce(p_match_count, 5), 50))
$$;

-- Matching: species nearest to the taste profile implied by what this device
-- has already adopted. Falls through to nothing when the device has no
-- adoptions or no embeddings are loaded yet.
create or replace function api.recommend_species(
  p_match_count integer default 3
) returns table (
  species_id text,
  name       text,
  tagline    text,
  similarity double precision
)
language sql
stable
security definer
set search_path = api, public
as $$
  with adopted as (
    select a.species_id
    from api.adoptions a
    where a.device_id = private.device_id()
  ),
  taste as (
    select avg(e.embedding) as embedding
    from api.embeddings e
    join adopted a on a.species_id = e.entity_id
    where e.entity_type = 'species'
  )
  select s.id,
         s.name,
         s.tagline,
         1 - (e.embedding <=> t.embedding)
  from api.species s
  join api.embeddings e on e.entity_type = 'species' and e.entity_id = s.id
  cross join taste t
  where t.embedding is not null
    and s.id not in (select a.species_id from adopted a)
  order by e.embedding <=> t.embedding
  limit greatest(1, least(coalesce(p_match_count, 3), 20))
$$;

-- ------------------------------------------------------ (a) adoption -------

-- Creates the adoption, issues its Living Deed, and bumps the species tally in
-- one transaction. Eco-tokens are awarded separately so the earning rule stays
-- in one place.
--
-- p_quantity is the number of saplings one pledge covers. A supporter tier
-- backs several trees with a single payment, so the pledge totals and the
-- deed's trees_planted scale with it rather than the row count. Defaults to 1,
-- which is what the single-species adopt flow uses.
--
-- The 3-argument form is dropped first: with p_quantity defaulted, keeping both
-- would leave PostgREST with an ambiguous overload for a 3-argument call.
drop function if exists api.create_adoption(text, text, text);

create or replace function api.create_adoption(
  p_species_id        text,
  p_rc_product_id     text default null,
  p_rc_transaction_id text default null,
  p_quantity          integer default 1
) returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device   uuid := private.device_id();
  v_qty      integer := greatest(1, least(coalesce(p_quantity, 1), 1000));
  v_species  api.species;
  v_adoption api.adoptions;
  v_deed     api.living_deeds;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;

  select * into v_species from api.species s where s.id = p_species_id;
  if not found then
    raise exception 'Unknown species %', p_species_id using errcode = '23503';
  end if;

  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  -- A store transaction can be delivered again by the RevenueCat SDK (restore,
  -- retry, or a CustomerInfo refresh). Hand back the adoption that transaction
  -- already produced rather than minting a second deed and a second batch of
  -- eco-tokens; `replayed` tells the caller no new tokens are owed.
  --
  -- The key includes species_id because one transaction can legitimately cover
  -- several species: a supporter tier plants both kae-na and yang-na against a
  -- single payment, so a per-transaction key alone would dedupe the second
  -- species into a replay of the first.
  insert into api.adoptions (
    device_id, species_id, pledge_thb, pledge_usd, rc_product_id, rc_transaction_id
  ) values (
    v_device, v_species.id, v_species.pledge_thb * v_qty, v_species.pledge_usd * v_qty,
    p_rc_product_id, p_rc_transaction_id
  )
  on conflict (device_id, rc_transaction_id, species_id)
    where rc_transaction_id is not null
  do nothing
  returning * into v_adoption;

  if v_adoption.id is null then
    -- Either this is a replay, or a concurrent delivery won the insert race.
    select * into v_adoption
      from api.adoptions
     where device_id = v_device
       and species_id = v_species.id
       and rc_transaction_id = p_rc_transaction_id;

    select * into v_deed from api.living_deeds where adoption_id = v_adoption.id;

    return jsonb_build_object(
      'adoption', to_jsonb(v_adoption),
      'deed',     to_jsonb(v_deed),
      'replayed', true
    );
  end if;

  insert into api.living_deeds (
    adoption_id, device_id, stages, stage_index, trees_planted
  ) values (
    v_adoption.id, v_device, v_species.stages, 0, v_qty
  )
  returning * into v_deed;

  update api.species s
     set adopted_count = s.adopted_count + v_qty
   where s.id = v_species.id;

  return jsonb_build_object(
    'adoption', to_jsonb(v_adoption),
    'deed',     to_jsonb(v_deed),
    'replayed', false
  );
end;
$$;

-- ------------------------------------------------------- (c) eco-tokens ----

-- Appends to the ledger and returns the new balance. The UPDATE takes a row
-- lock, so concurrent awards to one device serialise and balance_after is
-- always accurate.
create or replace function api.award_eco_tokens(
  p_delta       integer,
  p_reason      text,
  p_source_type text default null,
  p_source_id   text default null
) returns api.eco_token_balance
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_balance api.eco_token_balance;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;

  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  insert into api.eco_token_balance (device_id, balance)
  values (v_device, 0)
  on conflict (device_id) do nothing;

  update api.eco_token_balance b
     set balance = b.balance + p_delta,
         updated_at = now()
   where b.device_id = v_device
  returning * into v_balance;

  if v_balance.balance < 0 then
    raise exception 'Insufficient eco-token balance' using errcode = '23514';
  end if;

  insert into api.eco_token_ledger (
    device_id, delta, balance_after, reason, source_type, source_id
  ) values (
    v_device, p_delta, v_balance.balance, p_reason, p_source_type, p_source_id
  );

  return v_balance;
end;
$$;

grant execute on function api.catalog_search(vector, integer, text) to anon;
grant execute on function api.similar_content(text, text, integer) to anon;
grant execute on function api.recommend_species(integer) to anon;
grant execute on function api.create_adoption(text, text, text, integer) to anon;
grant execute on function api.award_eco_tokens(integer, text, text, text) to anon;
