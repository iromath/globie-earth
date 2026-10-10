-- Globie Earth :: 190 :: public sound library
--
-- Let a device publish one of its own ready renders into a shared, public
-- catalogue that any device can play without adopting a Living Tree and without
-- holding the Forest Keeper Pass. Publishing is a column and not a second table:
-- a published track is the same row with a different audience, and a copy would
-- be a second thing to keep in step with the renderer.
--
-- The base table's RLS is untouched - it stays device-only, exactly as in
-- 100_studio.sql. The public catalogue is the Studio proxy's, never PostgREST's:
-- a row carries the player's own `prompt` and their `device_id`, and neither
-- belongs to the public. The proxy's public DTO is the one public shape. See
-- Dev-Docs/PUBLIC-SOUND-LIBRARY-PLAN.md D2/D3.

-- Additive, so every existing row stays private and nothing needs a backfill.
alter table api.studio_tracks
  add column if not exists visibility text not null default 'private'
  check (visibility in ('private','public'));

alter table api.studio_tracks
  add column if not exists published_at timestamptz;

comment on column api.studio_tracks.visibility is
  'private until the owning device publishes it; only the Studio proxy may flip it (update is revoked from anon).';
comment on column api.studio_tracks.published_at is
  'When the track entered the public catalogue, null while private. The catalogue orders by this.';

-- The catalogue query: published, ready, newest first. Partial, so it never
-- grows with the private majority.
create index if not exists studio_tracks_public_idx
  on api.studio_tracks (published_at desc)
  where visibility = 'public' and status = 'ready';

-- Reports. One row per (track, device), so a single device cannot bury a track
-- by tapping twice - the unique key is the rate limit.
create table if not exists api.studio_reports (
  id         uuid primary key default gen_random_uuid(),
  track_id   uuid not null references api.studio_tracks(id) on delete cascade,
  device_id  uuid not null references api.devices(id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now(),
  unique (track_id, device_id)
);

comment on table api.studio_reports is
  'One report per device per public track. The Studio proxy reads the distinct count and hides a track past STUDIO_REPORT_THRESHOLD.';

create index if not exists studio_reports_track_idx
  on api.studio_reports (track_id);

-- 010_bootstrap.sql grants anon select/insert/update/delete on every new api
-- table by default. Reports are the proxy's business, so take it all back: a
-- report is never written from the browser.
revoke all on api.studio_reports from anon;
