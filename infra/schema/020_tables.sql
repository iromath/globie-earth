-- Globie Earth :: 020 :: tables
-- Four domains: content catalog (d), adoptions + living deeds (a),
-- guardian pledges + sponsors (b), eco-token ledger (c).

-- ---------------------------------------------------------------- identity --

create table if not exists api.devices (
  id          uuid primary key default gen_random_uuid(),
  platform    text not null default 'unknown',
  app_version text,
  locale      text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table api.devices is
  'Anonymous device identity. id is also the RevenueCat appUserID.';

-- ----------------------------------------------------------- (d) catalog ---

create table if not exists api.species (
  id                 text primary key,
  name               text not null,
  botanical          text not null,
  tagline            text not null,
  need_badge         text not null,
  need_color         text not null,
  image              text not null,
  description        text not null,
  adopted_count      integer not null default 0,
  total_quota        integer not null default 0,
  pledge_thb         numeric(10,2) not null,
  pledge_usd         numeric(10,2) not null,
  stages             text[] not null default '{}',
  current_stage_index integer not null default 0,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now()
);

create table if not exists api.guardians (
  id                 text primary key,
  name               text not null,
  thai_name          text not null,
  scientific_name    text not null,
  title              text not null,
  rarity             text not null,
  image              text not null default '',
  epithet            text not null,
  quote              text not null,
  traits             text[] not null default '{}',
  metrics            jsonb not null default '[]'::jsonb,
  locked             boolean not null default false,
  unlock_requirement text,
  sort_order         integer not null default 0
);

create table if not exists api.sites (
  id                integer primary key,
  title             text not null,
  sub_sector        text not null,
  image             text not null,
  video_url         text,
  badge             text,
  gps_coords        text not null,
  telemetry         text not null,
  description       text not null,
  additional_photos jsonb not null default '[]'::jsonb,
  sort_order        integer not null default 0
);

-- One embedding table for every entity type. This keeps the vector dimension
-- in exactly one column definition, so switching provider is a one-line change
-- here plus a re-embed. Declared at Titan V1's 1536; 180_embeddings_local.sql
-- moves the live column to the self-hosted model's 384.
create table if not exists api.embeddings (
  id          bigserial primary key,
  entity_type text not null check (entity_type in ('species', 'site', 'guardian')),
  entity_id   text not null,
  chunk_index integer not null default 0,
  content     text not null,
  embedding   vector(1536) not null,   -- EMBEDDING_DIM
  model       text not null default 'amazon.titan-embed-text-v1',
  created_at  timestamptz not null default now(),
  unique (entity_type, entity_id, chunk_index)
);

create index if not exists embeddings_hnsw_idx
  on api.embeddings using hnsw (embedding vector_cosine_ops);
create index if not exists embeddings_entity_idx
  on api.embeddings (entity_type, entity_id);
create index if not exists embeddings_content_trgm_idx
  on api.embeddings using gin (content gin_trgm_ops);

-- ----------------------------------------- (a) adoptions + living deeds ----

create table if not exists api.adoptions (
  id                uuid primary key default gen_random_uuid(),
  device_id         uuid not null references api.devices(id) on delete cascade,
  species_id        text not null references api.species(id),
  pledge_thb        numeric(10,2) not null,
  pledge_usd        numeric(10,2) not null,
  status            text not null default 'active'
                    check (status in ('pending', 'active', 'completed', 'refunded')),
  rc_product_id     text,
  rc_transaction_id text,
  adopted_at        timestamptz not null default now()
);

create index if not exists adoptions_device_idx
  on api.adoptions (device_id, adopted_at desc);

-- Store transactions are delivered more than once: the RevenueCat SDK replays
-- them on restore, on retry, and whenever CustomerInfo is refreshed. One
-- delivery of a transaction must never mint a second deed or a second batch of
-- eco-tokens, so this is the hard guarantee that api.create_adoption merges on.
-- Partial, because a pledge with no transaction id (a future non-store path) is
-- not deduplicated. species_id is part of the key because a single transaction
-- can cover several species - a supporter tier plants both kae-na and yang-na
-- against one payment - and those are separate deeds, not replays.
create unique index if not exists adoptions_device_rc_txn_species_uidx
  on api.adoptions (device_id, rc_transaction_id, species_id)
  where rc_transaction_id is not null;

create sequence if not exists api.deed_no_seq;

create table if not exists api.living_deeds (
  id             uuid primary key default gen_random_uuid(),
  adoption_id    uuid not null unique references api.adoptions(id) on delete cascade,
  device_id      uuid not null references api.devices(id) on delete cascade,
  deed_no        text not null unique
                 default ('GLB-' || to_char(now(), 'YYYY') || '-'
                          || lpad(nextval('api.deed_no_seq')::text, 6, '0')),
  stage_index    integer not null default 0,
  stages         text[] not null default '{}',
  trees_planted  integer not null default 1,
  co2_offset_kg  numeric(10,2) not null default 0,
  progress_pct   integer not null default 0 check (progress_pct between 0 and 100),
  gps_coords     text,
  issued_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists living_deeds_device_idx
  on api.living_deeds (device_id, issued_at desc);

-- --------------------------------------- (b) guardian pledges + sponsors ---

create table if not exists api.guardian_pledges (
  id                uuid primary key default gen_random_uuid(),
  device_id         uuid not null references api.devices(id) on delete cascade,
  guardian_id       text not null references api.guardians(id),
  bond_level        integer not null default 0,
  bond_xp           integer not null default 0,
  bond_xp_max       integer not null default 1000,
  synced_percent    integer not null default 0
                    check (synced_percent between 0 and 100),
  status            text not null default 'active'
                    check (status in ('active', 'paused', 'completed')),
  rc_product_id     text,
  rc_transaction_id text,
  pledged_at        timestamptz not null default now(),
  unique (device_id, guardian_id)
);

create table if not exists api.sponsors (
  id           uuid primary key default gen_random_uuid(),
  device_id    uuid not null references api.devices(id) on delete cascade,
  display_name text not null,
  tier         text not null default 'supporter',
  is_public    boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists api.sponsorships (
  id           uuid primary key default gen_random_uuid(),
  sponsor_id   uuid not null references api.sponsors(id) on delete cascade,
  device_id    uuid not null references api.devices(id) on delete cascade,
  adoption_id  uuid references api.adoptions(id) on delete set null,
  guardian_id  text references api.guardians(id),
  amount_thb   numeric(10,2) not null,
  sponsored_at timestamptz not null default now()
);

-- ------------------------------------------------------ (c) eco-token ------

-- Append-only. Rolled up by day in 050_history.sql.
create table if not exists api.eco_token_ledger (
  id            bigserial primary key,
  device_id     uuid not null references api.devices(id) on delete cascade,
  delta         integer not null,
  balance_after integer not null,
  reason        text not null,
  source_type   text,
  source_id     text,
  created_at    timestamptz not null default now()
);

create index if not exists eco_token_ledger_device_idx
  on api.eco_token_ledger (device_id, created_at desc);

-- Current balance. Kept as its own table rather than derived from the ledger
-- because reads must be immediately consistent after a write.
create table if not exists api.eco_token_balance (
  device_id  uuid primary key references api.devices(id) on delete cascade,
  balance    integer not null default 0,
  updated_at timestamptz not null default now()
);
