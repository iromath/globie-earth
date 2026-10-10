-- Globie Earth :: 220 :: photographs contributed by visitors
--
-- The Field Guide shows one openly-licensed photograph per DNP species
-- (200_dnp_media.sql). Many rows have none, and many that do could be better.
-- This table is where a visitor's own photograph goes when they contribute one
-- from a species page.
--
-- A row is written by the MCP server's POST /contribute route, not by the
-- browser: that route is the only place the photo is inspected (Globie's vision
-- model rates it safe/unsafe and relevant/irrelevant), the only place the bytes
-- are put into object storage, and the only place the accepted submission is
-- recorded. Nothing reaches this table without having passed that scan, so a
-- row here is always safe and on-subject. A submission the model rates unsafe
-- or off-subject is refused at the route and never stored at all - the
-- offending image is not kept.
--
-- The row is `pending`: accepting a contribution is a deliberate act, and a
-- photograph that will carry a species name needs a human to check it. Wiring
-- an approval that flips a row to `approved` (and clears it for the page to
-- read) is a later step; this migration only makes the queue real.
--
-- The bytes live in object storage and are never stored here. photo_key is the
-- object key inside the bucket; photo_url is the public URL the key resolves to
-- once the bucket is served. Both are non-null because, as above, only an
-- uploaded-and-scanned image reaches this table.

create table if not exists api.species_contributions (
  id           uuid primary key default gen_random_uuid(),
  device_id    uuid not null references api.devices(id) on delete cascade,
  -- The three DNP reference universes that carry photographs, matching the
  -- photo-bearing types in src/lib/dnp.ts (PHOTO_TYPES). api.species is not one
  -- of them: those rows are the adoptable catalogue, not the encyclopedia.
  species_type text not null
               check (species_type in ('dnp_plant','dnp_fauna','dnp_wildlife')),
  -- The DNP row's bigserial id, never api.species' text slug (SPECIES-ENCYCLOPEDIA-PLAN §2).
  species_id   bigint not null,
  -- The name as it read on the page when the photo was offered, kept for the
  -- moderator's queue so it does not have to be re-joined to read.
  species_name text,
  -- pending -> approved is a human decision that is not built yet. rejected is
  -- kept so a queued photo can be turned down without deleting the record.
  status       text not null default 'pending'
               check (status in ('pending','approved','rejected')),
  -- Where the bytes are. photo_key names the object; photo_url is what an
  -- <img> would load once the row is approved and shown.
  photo_key    text not null,
  photo_url    text not null,
  content_type text,
  byte_size    integer,
  -- The scan the route ran before it stored anything, kept as provenance: which
  -- model read the photo and what it said. ai_safe is not a column because an
  -- unsafe photo never reaches this table.
  ai_category  text,
  ai_subject   text,
  ai_reason    text,
  ai_model     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table api.species_contributions is
  'Photographs contributed by visitors from a species page, after the MCP route rated them safe and on-subject. Bytes live in object storage (photo_key/photo_url); the row is a pending moderation-queue entry and is never rewritten from the browser.';

-- "find a species' contributions" for the queue, and "my contributions" for a
-- device. One btree each, mirroring 100_studio.sql's device index.
create index if not exists species_contributions_species_idx
  on api.species_contributions (species_type, species_id);
create index if not exists species_contributions_device_idx
  on api.species_contributions (device_id, created_at desc);

-- ------------------------------------------------------------------- RLS ---

alter table api.species_contributions enable row level security;

-- 010_bootstrap.sql grants anon select, insert, update and delete on every new
-- api table by default, so update is taken back here explicitly: a contribution
-- is a record of what was submitted and must not be rewritten from the browser
-- (same rule as api.studio_tracks).
revoke update on api.species_contributions from anon;

drop policy if exists species_contributions_select on api.species_contributions;
create policy species_contributions_select on api.species_contributions
  for select to anon using (device_id = private.device_id());

drop policy if exists species_contributions_insert on api.species_contributions;
create policy species_contributions_insert on api.species_contributions
  for insert to anon with check (device_id = private.device_id());

drop policy if exists species_contributions_delete on api.species_contributions;
create policy species_contributions_delete on api.species_contributions
  for delete to anon using (device_id = private.device_id());
