-- Globie Earth :: 100 :: sound studio
--
-- One row per generated track. The `studio` service writes these rows: it
-- connects as the migration role, so it is deliberately outside the policies
-- below and scopes every query by device_id itself. This file exists so the app
-- can read and prune its own library straight from PostgREST, pinned to the
-- same X-Device-Id header every other device-owned table uses (see 030_rls.sql).
--
-- Status is the proxy's business, so `update` is not granted to anon: a client
-- can list its tracks and discard one, and that is all. A row is never rewritten
-- from the browser.

create table if not exists api.studio_tracks (
  id                uuid primary key default gen_random_uuid(),
  device_id         uuid not null references api.devices(id) on delete cascade,
  title             text not null,
  prompt            text not null,
  style             text not null,
  instrumental      boolean not null default true,
  -- Pinned rather than floating: the provider renames its models (V4 -> V5_5),
  -- so a bump is an explicit decision and an old track keeps its provenance.
  model             text not null default 'V4_5ALL',
  status            text not null default 'queued'
                    check (status in ('queued','generating','ready','failed')),
  provider_task_id  text,
  provider_track_id text,
  -- Filename inside the studio_audio volume, never a path into the container and
  -- never the provider's own URL, which is hosted and not permanent.
  audio_path        text,
  duration_seconds  integer,
  sha256            text,
  credits_spent     integer,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table api.studio_tracks is
  'One Sound Studio generation job per row. audio_path names a file in the studio_audio volume; mp3s are never stored in Postgres.';

create index if not exists studio_tracks_device_idx
  on api.studio_tracks (device_id, created_at desc);

-- ------------------------------------------------------------------- RLS ---

alter table api.studio_tracks enable row level security;

-- 010_bootstrap.sql grants anon select, insert, update and delete on every new
-- api table by default, so update is taken back here explicitly.
revoke update on api.studio_tracks from anon;

drop policy if exists studio_tracks_select on api.studio_tracks;
create policy studio_tracks_select on api.studio_tracks
  for select to anon using (device_id = private.device_id());

drop policy if exists studio_tracks_insert on api.studio_tracks;
create policy studio_tracks_insert on api.studio_tracks
  for insert to anon with check (device_id = private.device_id());

drop policy if exists studio_tracks_delete on api.studio_tracks;
create policy studio_tracks_delete on api.studio_tracks
  for delete to anon using (device_id = private.device_id());
