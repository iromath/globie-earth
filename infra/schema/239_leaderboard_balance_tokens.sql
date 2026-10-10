-- Globie Earth :: 239 :: the leaderboard's Eco Tokens column is the balance
--
-- 236 built the board's `tokens` metric from the ledger:
--
--     sum(delta) where delta > 0 and reason <> 'welcome'
--
-- The intent was to rank achievement and leave the opening gift out. The
-- effect, reported against the shipped app, was two different numbers for the
-- same steward: the header and the passport read api.eco_token_balance (which
-- the 090 grant opens at 1,010), while the board read the ledger minus that
-- grant, so "Eco Tokens" sat exactly 1,010 below the balance the visitor could
-- see in their own header (3,780 vs 2,770 in the report). A reward that is real
-- in one place and absent in another reads as a sync bug, not as a rule.
--
-- The fix is to rank by the same figure the rest of the app shows. The balance
-- table is the one source the header, the passport and the board can agree on,
-- so the `tokens` metric now reads it directly. This is deliberately not a
-- second aggregation of the ledger: the balance row is written under a row lock
-- (040/080) precisely so a read is immediately consistent, and the welcome
-- grant lives inside it.
--
-- Everything else in api.leaderboard is unchanged from 237 (the guide_species
-- arm included). Depends on 236 and 237; re-run both before this one.

create or replace function api.leaderboard(
  p_metric text    default 'trees',
  p_limit  integer default 25
) returns table (
  rank         integer,
  display_name text,
  avatar_url   text,
  value        bigint,
  is_me        boolean
)
language sql
stable
security definer
set search_path = api, public
as $$
  with impact as (
    select
      d.id                                                      as device_id,
      coalesce(deed.trees, 0)::bigint                           as trees,
      coalesce(deed.co2, 0)::bigint                             as co2_kg,
      coalesce(contrib.approved, 0)::bigint                     as contributions,
      coalesce(votes.cast, 0)::bigint                           as votes,
      coalesce(bal.balance, 0)::bigint                          as tokens,
      coalesce(guide.guide_species, 0)::bigint                  as guide_species
    from api.devices d
    left join (
      select device_id, sum(trees_planted) trees, sum(co2_offset_kg) co2
        from api.living_deeds group by device_id
    ) deed on deed.device_id = d.id
    left join (
      select device_id, count(*) approved
        from api.species_contributions where status = 'approved' group by device_id
    ) contrib on contrib.device_id = d.id
    left join (
      select device_id, count(*) cast
        from api.contribution_frame_votes group by device_id
    ) votes on votes.device_id = d.id
    -- Changed in 239. Reads the balance row (the header's own figure, welcome
    -- grant included) instead of a ledger sum that excluded the grant. Keyed by
    -- device_id, so the board and the header agree for a device-only caller.
    left join (
      select device_id, balance
        from api.eco_token_balance
    ) bal on bal.device_id = d.id
    left join (
      select device_id,
             count(distinct (species_type || ':' || species_id)) guide_species
        from api.species_contributions
       where status = 'approved'
       group by device_id
    ) guide on guide.device_id = d.id
  ),
  scored as (
    select
      i.device_id,
      case p_metric
        when 'contributions' then i.contributions
        when 'votes'         then i.votes
        when 'co2'           then i.co2_kg
        when 'tokens'        then i.tokens
        when 'guide_species' then i.guide_species
        else i.trees
      end as value
    from impact i
  ),
  -- Name the steward without ever returning the device UUID, which is their
  -- credential. A public sponsor name wins; otherwise a four-character handle
  -- derived from the id - enough to be recognised, not enough to be reused.
  named as (
    select
      s.device_id,
      s.value,
      coalesce(
        (
          select sp.display_name from api.sponsors sp
           where sp.device_id = s.device_id
             and sp.is_public
             and sp.display_name <> ''
           order by sp.created_at
           limit 1
        ),
        'Steward ' || upper(right(replace(s.device_id::text, '-', ''), 4))
      ) as display_name,
      (
        select u.avatar_url from api.users u
         where u.id = (
           select b.user_id from api.eco_token_balance b
            where b.device_id = s.device_id
         )
           and u.avatar_url is not null
         limit 1
      ) as avatar_url
    from scored s
    where s.value > 0
    order by s.value desc, s.device_id
    limit greatest(1, least(p_limit, 100))
  )
  select
    (row_number() over (order by n.value desc, n.device_id))::int as rank,
    n.display_name,
    n.avatar_url,
    n.value,
    (n.device_id = private.device_id())                          as is_me
  from named n
  order by rank;
$$;

comment on function api.leaderboard(text, integer) is
  'The top stewards by one metric (trees | contributions | votes | co2 | tokens | guide_species). Returns a display name and a value, never a device id; is_me marks the caller''s own row. The tokens metric is the balance the header shows, opening grant included (239).';

grant execute on function api.leaderboard(text, integer) to anon;

-- PostgREST caches function signatures; this file is applied by hand rather
-- than by a restart, so ask it to reload.
notify pgrst, 'reload schema';
