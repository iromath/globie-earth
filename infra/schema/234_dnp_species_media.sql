-- Globie Earth :: 234 :: a photograph for the DNP biodiversity survey
--
-- 200_dnp_media.sql gave a photograph to the three DNP tables that could carry
-- one - the national plant checklist, the national wildlife checklist and the
-- park fauna observations. api.dnp_species, the biodiversity survey, was left
-- without a photo column, so its rows could never receive media: 220's
-- species_type check named only the three photo-bearing tables, the app's
-- isContributable() and PHOTO_TYPES mirrored that, and so a survey species page
-- never rendered the contribute button - the empty "No photograph is held for
-- this species" state stood with no way to change it.
--
-- This closes that gap. The five photo columns are added to api.dnp_species
-- exactly as 200 added them to the other three, so every DNP table now has the
-- same shape and a survey species can hold a photograph - its own, or one the
-- community contributed. No gbif_key: the survey is not matched against GBIF,
-- and nothing keys an enrichment off it.
--
-- Every column is nullable and stays NULL until something writes it, so a
-- missing photograph is stored as missing, never as a placeholder - the same
-- rule 200 follows (SPECIES-ENCYCLOPEDIA-PLAN §8).

alter table api.dnp_species add column if not exists photo_url     text;
alter table api.dnp_species add column if not exists photo_source  text;
alter table api.dnp_species add column if not exists photo_license text;
alter table api.dnp_species add column if not exists photo_credit  text;
alter table api.dnp_species add column if not exists photo_ref     text;

comment on column api.dnp_species.photo_url is
  'Photograph of the species. Null until a photograph is held for this survey row; a community contribution stands in while it is.';
comment on column api.dnp_species.photo_source is
  'Publisher / origin of photo_url. Null when there is no photo.';
comment on column api.dnp_species.photo_license is
  'Licence of photo_url as a short code, e.g. "CC BY-NC 4.0". Null when there is no photo.';
comment on column api.dnp_species.photo_credit is
  'Photographer / rights holder credited for photo_url. Null when there is no photo.';
comment on column api.dnp_species.photo_ref is
  'Human-readable source page for photo_url. Null when there is no photo.';

-- ------------------------------------------------- contribute to the survey --
--
-- 220_species_contributions.sql's species_type check named only the three
-- photo-bearing tables, so a contribution to a survey species was refused by
-- the database before it could be recorded. With the column above, the survey
-- is a photo-bearing table too, so it is admitted here. The app mirrors this
-- list in src/lib/contribute.ts (CONTRIBUTABLE_TYPES) and src/lib/dnp.ts
-- (PHOTO_TYPES), and the MCP route in infra/mcp/src/contribute.ts
-- (SPECIES_TYPES); all four lists must agree.
alter table api.species_contributions
  drop constraint if exists species_contributions_species_type_check;
alter table api.species_contributions
  add constraint species_contributions_species_type_check
  check (species_type in ('dnp_plant','dnp_fauna','dnp_wildlife','dnp_species'));
