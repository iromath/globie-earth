-- Globie Earth :: 050 :: eco-token history
-- The ledger is append-only and read by time range. The image ships pgvector
-- but no TimescaleDB, so the daily rollup is a plain aggregate behind a
-- device-scoped function rather than a continuous aggregate. At this volume
-- that is one index scan, and it is always fresh - nothing to refresh or
-- backfill. The function is SECURITY DEFINER and filters on private.device_id(),
-- so a caller only ever sees its own days.

-- Range scans walk created_at on an append-only table, so BRIN keeps the write
-- path cheap where a b-tree would pay on every insert.
create index if not exists eco_token_ledger_created_brin_idx
  on api.eco_token_ledger using brin (created_at);

create or replace function api.token_history(p_days integer default 30)
returns table (
  day        timestamptz,
  net_tokens integer,
  entries    bigint
)
language sql
stable
security definer
set search_path = api, private, public
as $$
  select date_trunc('day', l.created_at)        as day,
         sum(l.delta)::integer                  as net_tokens,
         count(*)                               as entries
  from api.eco_token_ledger l
  where l.device_id = private.device_id()
    and l.created_at >= now()
        - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
  group by 1
  order by 1 desc
$$;

grant execute on function api.token_history(integer) to anon;
