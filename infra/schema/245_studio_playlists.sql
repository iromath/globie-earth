-- Globie Earth :: 245 :: studio playlists
--
-- A playlist is a device's own ordered list of tracks it can hear: its own
-- finished renders, and anything another device has shared to the public
-- catalogue. It is a second table rather than a column because the membership
-- is a set, and a set of ids in a text column cannot be joined, ordered or
-- cascaded.
--
-- Like api.studio_tracks, these rows are reached only through the Studio proxy
-- (infra/studio/src/server.ts), which connects as the migration role and scopes
-- every statement by device_id itself. There is deliberately no PostgREST path:
-- a playlist entry can name a track the reading device does not own, so the
-- proxy has to hydrate it with the public DTO - a browser read would need the
-- same join and the same redaction, and two implementations of one shape drift.
-- See Dev-Docs/PUBLIC-SOUND-LIBRARY-PLAN.md D3 for the redaction rule.

create table if not exists api.studio_playlists (
  id         uuid primary key default gen_random_uuid(),
  device_id  uuid not null references api.devices(id) on delete cascade,
  title      text not null,
  -- `updated_at` moves on add and remove, so the list can show most-recent
  -- first without a join to the membership table.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table api.studio_playlists is
  'One device-owned playlist. Written and read only by the Studio proxy (anon has no grant).';

create index if not exists studio_playlists_device_idx
  on api.studio_playlists (device_id, updated_at desc);

-- The membership join. `(playlist_id, track_id)` is the primary key, so adding
-- the same track twice is a no-op rather than a duplicate row - the same
-- "the unique key is the rate limit" shape api.studio_reports uses.
--
-- Both foreign keys cascade: deleting a playlist drops its membership, and
-- deleting a render drops it out of every playlist that named it, so no list
-- is ever left pointing at a track that no longer exists.
create table if not exists api.studio_playlist_tracks (
  playlist_id uuid not null references api.studio_playlists(id) on delete cascade,
  track_id    uuid not null references api.studio_tracks(id) on delete cascade,
  -- Append order. Not a unique key: reordering is not a feature yet, and a
  -- dense sequence would have to be rewritten to insert into the middle.
  position    integer not null default 0,
  added_at    timestamptz not null default now(),
  primary key (playlist_id, track_id)
);

comment on table api.studio_playlist_tracks is
  'Ordered membership of a playlist. Cascades from both ends, so neither a deleted playlist nor a pruned render leaves a dangling entry.';

create index if not exists studio_playlist_tracks_order_idx
  on api.studio_playlist_tracks (playlist_id, position);

-- ------------------------------------------------------------------- RLS ---
--
-- 010_bootstrap.sql grants anon select/insert/update/delete on every new api
-- table by default. These are the proxy's business, so take it all back. RLS is
-- switched on as well so that a future grant cannot quietly expose a row: with
-- no policy for anon, even a granted read returns nothing.

alter table api.studio_playlists enable row level security;
alter table api.studio_playlist_tracks enable row level security;

revoke all on api.studio_playlists from anon;
revoke all on api.studio_playlist_tracks from anon;
