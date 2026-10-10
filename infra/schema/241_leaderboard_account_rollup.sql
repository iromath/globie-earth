-- Globie Earth :: 241 :: the board rolls up by account, and always shows you
--
-- Two reports against the shipped board, one cause.
--
-- A2 - the board ranked per DEVICE while the header and the passport aggregate
-- per ACCOUNT. A signed-in steward with a phone and a tablet appeared twice,
-- each row holding a fraction of their real total, and neither row matched the
-- number in their own header. The identity the rest of the app agrees on is the
-- account: api.eco_token_balance carries a nullable user_id (070_accounts.sql),
-- stamped when a device is claimed (080_account_ownership.sql). So the board
-- now groups by that same key -
--
--     group_key = coalesce(balance.user_id, d.id)
--
-- a signed-in account collapses its devices into one row; a device-only caller
-- (user_id still null) groups by its own id, which is exactly the behaviour it
-- has today.
--
-- A3 - `where s.value > 0` ran before the caller was marked, so a steward with
-- a zero value - the caller included - simply vanished. The sheet promises to
-- mark the caller's own row. The board now returns the top page by value AND
-- the caller's own row, ranked honestly: a caller with no activity sits at the
-- bottom with their real rank, never dropped.
--
-- A4 - a hard 25-row cap, no way to reach rank 26. A `p_offset` parameter lets
-- the sheet append the next page.
--
-- A6 - api.contribution_frame_votes had no index on device_id, so the board's
-- `group by device_id` could not use one. Added here.
--
-- A9 - the fallback handle widens from 4 to 6 characters (65,536 -> 16.7M
-- values, far fewer accidental "Steward A1B2" collisions), and the avatar is
-- resolved from api.users by the account, not only via a balance row.
--
-- Supersedes the api.leaderboard(text, integer) defined in 239. Depends on 236,
-- 237 and 239; apply those first. The callable shape is preserved: p_metric and
-- p_limit keep their names, types and defaults, so every existing caller keeps
-- working - p_offset is new and defaults to 0.

-- The 2-argument function from 239 must go before the 3-argument one is
-- created, or PostgREST would see two overloads and could not resolve a call
-- that omits p_offset.
drop function if exists api.leaderboard(text, integer);

create or replace function api.leaderboard(
  p_metric text    default 'trees',
  p_limit  integer default 25,
  p_offset integer default 0
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
    -- One row per device, carrying the account it belongs to (the balance
    -- row's user_id, or the device id when unclaimed) so the rollup below can
    -- sum a signed-in steward's devices into a single line.
    select
      coalesce(bal.user_id, d.id)                               as group_key,
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
    -- The balance row the header and the passport read (239), welcome grant
    -- included. Its user_id is what rolls a signed-in steward's devices up.
    left join api.eco_token_balance bal on bal.device_id = d.id
    left join (
      select device_id,
             count(distinct (species_type || ':' || species_id)) guide_species
        from api.species_contributions
       where status = 'approved'
       group by device_id
    ) guide on guide.device_id = d.id
  ),
  -- A2: the account total. A multi-device account is one row here; a
  -- device-only steward is one row keyed by their device id.
  account as (
    select
      i.group_key,
      sum(i.trees)::bigint          as trees,
      sum(i.co2_kg)::bigint         as co2_kg,
      sum(i.contributions)::bigint  as contributions,
      sum(i.votes)::bigint          as votes,
      sum(i.tokens)::bigint         as tokens,
      sum(i.guide_species)::bigint  as guide_species
    from impact i
    group by i.group_key
  ),
  scored as (
    select
      a.group_key,
      case p_metric
        when 'contributions' then a.contributions
        when 'votes'         then a.votes
        when 'co2'           then a.co2_kg
        when 'tokens'        then a.tokens
        when 'guide_species' then a.guide_species
        else a.trees
      end as value
    from account a
  ),
  -- The caller, keyed the same way (their device's account, else their device).
  caller as (
    select coalesce(
      (select b.user_id from api.eco_token_balance b
        where b.device_id = private.device_id()),
      private.device_id()
    ) as group_key
  ),
  -- A3: the public board still lists only stewards with something on it, but
  -- the caller is fetched separately below so they are never dropped.
  positive as (
    select
      s.group_key,
      s.value,
      row_number() over (order by s.value desc, s.group_key)::int as rank
    from scored s
    where s.value > 0
  ),
  -- A4: the requested page of the public board.
  page as (
    select p.group_key, p.value, p.rank
    from positive p
    order by p.rank
    offset greatest(0, coalesce(p_offset, 0))
    limit greatest(1, least(p_limit, 100))
  ),
  -- A3: the caller's own row with an honest rank - their real rank among the
  -- stewards who are on the board, or just past the end when they have nothing
  -- (0 value). Synthesised even if the caller has no device row yet, so a
  -- freshly created device is still shown.
  caller_ranked as (
    select
      c.group_key,
      coalesce(s.value, 0)::bigint as value,
      case
        when coalesce(s.value, 0) > 0
          then coalesce(
                 (select p.rank from positive p where p.group_key = c.group_key),
                 (select count(*) from positive) + 1
               )
        else (select count(*) from positive) + 1
      end as rank
    from caller c
    left join scored s on s.group_key = c.group_key
    where c.group_key is not null
  ),
  -- The page, plus the caller's row when it is not already on it.
  selected as (
    select group_key, value, rank from page
    union
    select group_key, value, rank from caller_ranked
  ),
  -- Name the steward without ever returning the credential. An account's own
  -- profile name wins, then a public sponsor name on the device, then a
  -- six-character handle - enough to be recognised, not enough to be reused.
  named as (
    select
      sel.group_key,
      sel.value,
      sel.rank,
      coalesce(
        (
          select u.display_name from api.users u
           where u.id = sel.group_key
             and coalesce(u.display_name, '') <> ''
           limit 1
        ),
        (
          select sp.display_name from api.sponsors sp
           where sp.device_id = sel.group_key
             and sp.is_public
             and sp.display_name <> ''
           order by sp.created_at
           limit 1
        ),
        'Steward ' || upper(right(replace(sel.group_key::text, '-', ''), 6))
      ) as display_name,
      -- A9: the avatar belongs to the account, so resolve it by group key
      -- instead of only through a balance row.
      (
        select u.avatar_url from api.users u
         where u.id = sel.group_key
           and u.avatar_url is not null
         limit 1
      ) as avatar_url
    from selected sel
  )
  select
    n.rank,
    n.display_name,
    n.avatar_url,
    n.value,
    (n.group_key = (select group_key from caller)) as is_me
  from named n
  order by n.rank, n.group_key;
$$;

comment on function api.leaderboard(text, integer, integer) is
  'The top stewards by one metric (trees | contributions | votes | co2 | tokens | guide_species). Rolls up per account when signed in, else per device (241). Returns a display name and a value, never a device id; is_me marks the caller''s own row, which is always included even at 0 value. p_offset pages the list. The tokens metric is the balance the header shows, opening grant included (239).';

grant execute on function api.leaderboard(text, integer, integer) to anon;

-- A6: the board groups contribution_frame_votes by device_id; give it an index.
create index if not exists contribution_frame_votes_device_idx
  on api.contribution_frame_votes (device_id);

-- PostgREST caches function signatures; this file is applied by hand rather
-- than by a restart, so ask it to reload.
notify pgrst, 'reload schema';
