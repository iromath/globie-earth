-- Globie Earth :: 200 :: a photograph for the DNP plant checklist and fauna
--
-- 130_dnp_plants.sql stored the national plant checklist and 140/150 stored the
-- national-park fauna observations and the national wildlife checklist. None of
-- them carried a picture: a reader could learn a species' name, family, IUCN
-- status and where it grows, but not what it looks like. This adds one
-- photograph per species, so the DNP layers can be shown rather than only read.
--
-- The photograph is the first openly-licensed StillImage GBIF holds for the
-- taxon, taken from a GBIF occurrence - in practice an iNaturalist observation,
-- which is why the query below prefers that publisher and why the licence and
-- the photographer come with the image:
--
--   occurrence/search?taxonKey=<key>&mediaType=StillImage
--     &datasetKey=50c9509d-22c7-4a22-a47d-8c48425ef4a7   (iNaturalist, preferred)
--
--   photo_url      the image itself. An iNaturalist open-data original is
--                  rewritten to its `large` (1024px) variant so a card or hero
--                  does not download a full-resolution original; any other
--                  publisher's URL is kept exactly as GBIF serves it.
--   photo_source   the publisher of the image, e.g. "iNaturalist", or "GBIF"
--                  when GBIF named no publisher.
--   photo_license  the image licence as a short code, e.g. "CC BY-NC 4.0".
--   photo_credit   the photographer / rights holder, for attribution.
--   photo_ref      the human-readable source page (GBIF media.references), so
--                  the record can be traced and the attribution checked.
--
-- The three plants columns (160/170) are keyed by the GBIF usageKey already
-- stored as gbif_key. The fauna and wildlife tables have no GBIF key, so this
-- adds gbif_key to each: the importer resolves it once from scientific_name via
-- species/match (EXACT, confidence 99 for the sampled names) and stores it, so
-- the photo - and any future GBIF enrichment - is keyed by the species' stable
-- identity rather than by a name string.
--
-- Every column is nullable and written in place by enrich-dnp-media.mjs (keyed
-- on gbif_key / scientific_name), so the migration is idempotent and a re-run
-- refreshes the rows. A species GBIF holds no image for keeps NULL - a missing
-- photograph is stored as missing, never as a placeholder.
--
-- Source of the images: GBIF (https://www.gbif.org), which republishes them
-- under each image's own licence (mostly Creative Commons). The DNP rows stay
-- external reference data under the Open Data Common licence; the image licence
-- is recorded per row in photo_license.

alter table api.dnp_plants   add column if not exists photo_url     text;
alter table api.dnp_plants   add column if not exists photo_source  text;
alter table api.dnp_plants   add column if not exists photo_license text;
alter table api.dnp_plants   add column if not exists photo_credit  text;
alter table api.dnp_plants   add column if not exists photo_ref     text;

alter table api.dnp_wildlife add column if not exists gbif_key      bigint;
alter table api.dnp_wildlife add column if not exists photo_url     text;
alter table api.dnp_wildlife add column if not exists photo_source  text;
alter table api.dnp_wildlife add column if not exists photo_license text;
alter table api.dnp_wildlife add column if not exists photo_credit  text;
alter table api.dnp_wildlife add column if not exists photo_ref     text;

alter table api.dnp_fauna    add column if not exists gbif_key      bigint;
alter table api.dnp_fauna    add column if not exists photo_url     text;
alter table api.dnp_fauna    add column if not exists photo_source  text;
alter table api.dnp_fauna    add column if not exists photo_license text;
alter table api.dnp_fauna    add column if not exists photo_credit  text;
alter table api.dnp_fauna    add column if not exists photo_ref     text;

comment on column api.dnp_plants.photo_url is
  'Photograph of the species: the iNaturalist open-data `large` (1024px) variant, or another GBIF publisher URL as served. Null when GBIF holds no StillImage for the species.';
comment on column api.dnp_plants.photo_source is
  'Publisher of photo_url, e.g. iNaturalist, or GBIF when GBIF named no publisher. Null when there is no photo.';
comment on column api.dnp_plants.photo_license is
  'Licence of photo_url as a short code, e.g. "CC BY-NC 4.0". Null when there is no photo.';
comment on column api.dnp_plants.photo_credit is
  'Photographer / rights holder credited for photo_url. Null when there is no photo.';
comment on column api.dnp_plants.photo_ref is
  'Human-readable source page for photo_url (GBIF media.references). Null when there is no photo.';

comment on column api.dnp_wildlife.gbif_key is
  'GBIF usageKey resolved from scientific_name via species/match. Key under which the photo (and future GBIF facts) are stored. Null when GBIF did not match the name.';
comment on column api.dnp_wildlife.photo_url is
  'Photograph of the species from GBIF occurrence media (iNaturalist-preferred), at the iNaturalist `large` (1024px) variant. Null when GBIF holds no StillImage.';
comment on column api.dnp_wildlife.photo_source is
  'Publisher of photo_url, e.g. iNaturalist, or GBIF when GBIF named no publisher. Null when there is no photo.';
comment on column api.dnp_wildlife.photo_license is
  'Licence of photo_url as a short code, e.g. "CC BY-NC 4.0". Null when there is no photo.';
comment on column api.dnp_wildlife.photo_credit is
  'Photographer / rights holder credited for photo_url. Null when there is no photo.';
comment on column api.dnp_wildlife.photo_ref is
  'Human-readable source page for photo_url (GBIF media.references). Null when there is no photo.';

comment on column api.dnp_fauna.gbif_key is
  'GBIF usageKey resolved from scientific_name via species/match. Key under which the photo (and future GBIF facts) are stored. Null when GBIF did not match the name.';
comment on column api.dnp_fauna.photo_url is
  'Photograph of the species from GBIF occurrence media (iNaturalist-preferred), at the iNaturalist `large` (1024px) variant. Null when GBIF holds no StillImage.';
comment on column api.dnp_fauna.photo_source is
  'Publisher of photo_url, e.g. iNaturalist, or GBIF when GBIF named no publisher. Null when there is no photo.';
comment on column api.dnp_fauna.photo_license is
  'Licence of photo_url as a short code, e.g. "CC BY-NC 4.0". Null when there is no photo.';
comment on column api.dnp_fauna.photo_credit is
  'Photographer / rights holder credited for photo_url. Null when there is no photo.';
comment on column api.dnp_fauna.photo_ref is
  'Human-readable source page for photo_url (GBIF media.references). Null when there is no photo.';

-- The importer joins the fauna/wildlife UPDATE on scientific_name (already
-- trigram-indexed by 140/150) and on gbif_key, and the plant UPDATE on
-- gbif_key, which 130 did not index. One btree per key column keeps those
-- joins and any "find this species' photo" lookup cheap.
create index if not exists dnp_plants_gbif_key_idx   on api.dnp_plants   (gbif_key);
create index if not exists dnp_wildlife_gbif_key_idx on api.dnp_wildlife (gbif_key);
create index if not exists dnp_fauna_gbif_key_idx    on api.dnp_fauna    (gbif_key);
