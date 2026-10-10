-- Globie Earth :: 110 :: public podcasts
--
-- The two small, curated things the Podcast Index integration owns. Neither is
-- the catalogue: the 4.7 M-row mirror stays on disk as a read-only volume and is
-- never migrated into Postgres (Dev-Docs/PODCAST-INTEGRATION-PLAN.md 2.2). What
-- belongs here is only what is *ours* - the proxy's response cache and an
-- editor's shortlist - which is "migrate the decisions, not the dump".
--
-- Both tables are service-owned: the `podcast` service reads and writes them
-- with the migration role, and the app never touches them directly. Podcast
-- content is public and identical for every device, so there is no device_id and
-- no RLS policy - and, because 010_bootstrap.sql grants anon select, insert,
-- update and delete on every new api table by default, the grants are taken back
-- explicitly below. Without that revoke, the third-party index and the cache
-- would be writable straight from the browser through PostgREST.

-- The proxy's response cache: one row per upstream call, keyed by endpoint and
-- arguments (e.g. 'trending:health:20'). Kilobyte rows with a per-endpoint TTL,
-- pruned by fetched_at, so the free tier's 1,000 requests a month are spent once
-- rather than once per install (plan 3.1).
create table if not exists api.podcast_cache (
  key        text primary key,
  payload    jsonb not null,
  fetched_at timestamptz not null default now()
);

comment on table api.podcast_cache is
  'Podcast Index REST responses, keyed by endpoint+args. Service-owned and pruned by fetched_at; the app never reads it.';

create index if not exists podcast_cache_fetched_idx
  on api.podcast_cache (fetched_at);

-- The editor's shortlist - the honest form of "the good stuff". A person chose
-- these, so the Featured shelf can say so and mean it. The mirror's taxonomy has
-- no mindfulness/sustainability token (plan 2.1), so this table is how the
-- on-brief shelves are populated at all; feed_id names a row in the mirror's
-- `feeds` table, not a foreign key into Postgres.
create table if not exists api.podcast_featured (
  id         uuid primary key default gen_random_uuid(),
  shelf      text not null,
  feed_id    bigint not null,
  position   integer not null default 0,
  note       text,
  created_at timestamptz not null default now(),
  -- A shelf that lists the same show twice is an editing slip, not a feature.
  unique (shelf, feed_id)
);

comment on table api.podcast_featured is
  'An editor-curated podcast shortlist. feed_id refers to the read-only mirror index, not to a Postgres row.';

create index if not exists podcast_featured_shelf_idx
  on api.podcast_featured (shelf, position);

-- ------------------------------------------------------------------- RLS ---

-- RLS on with no policy is the strictest posture available: even if a grant were
-- ever re-added, anon still sees nothing. The service role bypasses RLS, which
-- is the only role that should read these.
alter table api.podcast_cache enable row level security;
alter table api.podcast_featured enable row level security;

-- 010_bootstrap.sql grants anon select, insert, update and delete on every new
-- api table by default. Take all of it back: these tables are the proxy's.
revoke all on api.podcast_cache from anon;
revoke all on api.podcast_featured from anon;
