-- Globie Earth :: 240 :: hero progression - a level the ledger can defend
--
-- The header has shown a "LVL" pill since the first build, and the number in it
-- was never real. src/App.tsx seeds it to 14, two local events increment it, and
-- nothing ever writes it down: reload the page and the steward is back to where
-- they started, a second device disagrees with the first, and the LVL 30 mixer
-- unlock can be reached by sitting through a pair of claims rather than by doing
-- anything. A number that only ever went up in one browser tab is decoration, not
-- progression.
--
-- The app already records the one thing a level should mean. Every eco-token a
-- steward earns is an append to api.eco_token_ledger with a reason, and the
-- opening gift is stamped 'welcome'. A level is therefore not new state: it is a
-- read of a ledger the app has been writing all along.
--
--     xp = sum(delta) where delta > 0 and reason <> 'welcome'
--
-- counted for the account when the caller is signed in, and for the device when
-- they are not - the same rollup, and the same predicate, that
-- api.token_history (080) and the header's balance sum already use. It is
-- deliberately rewards-only: a gift is not an achievement, so 090's opening
-- grant does not put a new steward above LVL 1.
--
-- The ladder itself is data, not a formula, for the same reason a badge is a row
-- in api.badge_definitions: a curve that hard-codes `xp / 200` cannot be
-- steepened for the endgame without a code change. api.level_thresholds holds one
-- row per level - the xp at which it is reached - seeded here as 200 xp per level
-- for 1..40 and re-runnable so a later file can retune any rung with an upsert.
-- Level is then simply the highest rung the steward has cleared:
--
--     level = max(level) where xp_required <= xp        -- 1 when xp = 0
--
-- api.my_progress() answers the caller's level, their xp, the xp the next rung
-- wants, and the two token figures the passport shows - the rewards earned and
-- the balance held, both rolled up the same way. It is READ-ONLY: unlike
-- api.my_impact it awards and pays nothing, because the header hydrates on every
-- load and a milestone is a moment for the passport, not for the page chrome.
--
-- Calibration: the balance the app shows a champion steward includes 090's
-- 1,010 welcome grant, so their 3,780 is 2,770 of real rewards - and 2,770 sits
-- between rung 14 (2,600) and rung 15 (2,800), landing them on LVL 14, the value
-- the header pretends to today.
--
-- Depends on 020 (api.eco_token_ledger, api.eco_token_balance), 030/070
-- (private.device_id, private.user_id) and 090 (the welcome grant). Apply those
-- first.

-- --------------------------------------------------------- the ladder ------

create table if not exists api.level_thresholds (
  level       integer primary key,
  -- The rewards-earned xp at which this level is reached. Level 1 is 0 by
  -- construction, so a steward with no rewards yet is a level, not a null.
  xp_required bigint not null
);

comment on table api.level_thresholds is
  'The progression ladder: the xp at which each level is reached. Data, not a formula - retune a rung with an upsert, never a code change.';
comment on column api.level_thresholds.xp_required is
  'The rewards-only eco-token xp (delta > 0, reason <> welcome) needed to reach this level.';

-- 200 xp a level, levels 1..40: level 14 at 2,600 and the LVL 30 unlock at
-- 5,800. Insert-or-update so a re-run, or a later migration that steepens the
-- endgame, overwrites the copy rather than duplicating it.
insert into api.level_thresholds (level, xp_required)
select g, (g - 1) * 200
  from generate_series(1, 40) g
on conflict (level) do update set xp_required = excluded.xp_required;

-- The ladder is public - the client reads it to draw the bar to the next rung -
-- and writable only by these migrations. 010_bootstrap granted anon insert,
-- update and delete on every new api table by default, so take them back.
alter table api.level_thresholds enable row level security;
revoke insert, update, delete on api.level_thresholds from anon;

drop policy if exists level_thresholds_read on api.level_thresholds;
create policy level_thresholds_read on api.level_thresholds
  for select to anon using (true);

-- ---------------------------------------------------- the caller's rung ----

-- Read-only on purpose: the header calls this on every load, so it must not
-- carry api.my_impact's award-and-pay side effect. The xp predicate and the
-- balance predicate each name the device OR the account, which is exactly the
-- union the RLS policies hand the table reads - a device-only caller has a null
-- account and the clause collapses to the device alone.
create or replace function api.my_progress()
returns table (
  level          integer,
  xp             bigint,
  xp_next        bigint,
  tokens_earned  bigint,
  tokens_balance bigint
)
language sql
stable
security definer
set search_path = api, public
as $$
  with caller as (
    select private.device_id() as device_id,
           private.user_id()   as account_id
  ),
  earned as (
    select coalesce(sum(l.delta), 0)::bigint as xp
      from api.eco_token_ledger l, caller c
     where (l.device_id = c.device_id or l.user_id = c.account_id)
       and l.delta > 0
       and l.reason <> 'welcome'
  ),
  balance as (
    select coalesce(sum(b.balance), 0)::bigint as tokens
      from api.eco_token_balance b, caller c
     where b.device_id = c.device_id or b.user_id = c.account_id
  ),
  rung as (
    select coalesce(max(t.level), 1) as level
      from api.level_thresholds t, earned e
     where t.xp_required <= e.xp
  )
  select
    rung.level,
    earned.xp,
    -- The xp the next rung wants; null once the ladder runs out.
    (select t.xp_required from api.level_thresholds t where t.level = rung.level + 1),
    -- The same rewards figure, named for what the passport labels it.
    earned.xp,
    balance.tokens
  from rung, earned, balance;
$$;

comment on function api.my_progress() is
  'The caller''s level from the rewards-only xp ladder: level, xp (delta > 0, reason <> welcome, rolled up to the account when signed in), the xp the next level wants, plus the tokens earned and the balance held. Read-only - never awards or pays.';

grant execute on function api.my_progress() to anon;

-- PostgREST caches the schema; this file is applied by hand rather than by a
-- restart, so ask it to reload.
notify pgrst, 'reload schema';
