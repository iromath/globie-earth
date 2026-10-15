// Read-only catalogue resources: species, guardians, sites, and the forest datasets.
//
// The resources half of the MCP surface - the same catalogue rows the app
// renders, addressed by URI and (for the small tables) discoverable through each
// template's list callback. None of these tables is device-scoped: the RLS
// policies, the dnp_species table and the dnp_plants table make them
// world-readable, so the caller's
// identity does not narrow what comes back. The payloads mirror src/lib/api.ts's
// own row-to-view mapping rather than re-inventing field names, so a host reads
// the same shape the screens do. The four forest datasets (the biodiversity
// survey, the national plant checklist, the national-park fauna observations and
// the national wildlife checklist) are Globie Earth's own reference data, and all
// four are too large to enumerate.
//
// URIs carry the globie:// scheme because the MCP SDK parses a resource uri
// with `new URL()` before it dispatches, so a bare relative uri such as
// `species/kae-na` throws and surfaces as JSON-RPC -32603. `globie://species/{id}`
// is absolute, matches the same template, and round-trips through URL.href.

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { Caller } from '../identity.js';
import { get } from '../postgrest.js';
import { fetchWikiSummary, type WikiSummary } from '../wiki.js';

/** One api.species row (the species table). */
interface SpeciesRow {
  id: string;
  name: string;
  botanical: string;
  tagline: string;
  need_badge: string;
  need_color: string;
  image: string;
  description: string;
  adopted_count: number;
  total_quota: number;
  pledge_usd: number | string;
  stages: string[];
  current_stage_index: number;
}

/** One api.guardians row. */
interface GuardianRow {
  id: string;
  name: string;
  thai_name: string;
  scientific_name: string;
  title: string;
  rarity: string;
  image: string;
  epithet: string;
  quote: string;
  traits: string[];
  metrics: unknown;
  locked: boolean;
  unlock_requirement: string | null;
}

/** One api.sites row. */
interface SiteRow {
  id: number;
  title: string;
  sub_sector: string;
  image: string;
  video_url: string | null;
  badge: string | null;
  gps_coords: string;
  telemetry: string;
  description: string;
  additional_photos: unknown[];
}

/** One api.dnp_species row (the dnp_species table) - external survey data. */
interface DnpRow {
  id: number;
  resource_id: string;
  source_id: string;
  source_url: string;
  license: string;
  group_type: string;
  protected_area: string;
  forest_type: string | null;
  survey_year_be: number | null;
  thai_name: string | null;
  scientific_name: string | null;
  family: string | null;
  synonyms: string | null;
  imported_at: string;
}

/** One api.dnp_plants row (the dnp_plants table) - external checklist. */
interface DnpPlantRow {
  id: number;
  resource_id: string;
  source_id: string;
  source_url: string;
  license: string;
  thai_name: string | null;
  scientific_name: string;
  family: string | null;
  english_name: string | null;
  english_source: string | null;
  gbif_key: number | null;
  gbif_match_type: string | null;
  gbif_confidence: number | null;
  // Enriched from GBIF: the genus, the accepted-name
  // synonyms, and whether the species is native/introduced/cultivated in Thailand.
  genus: string | null;
  synonyms: string | null;
  native_status: string | null;
  // Enriched from GBIF: the Red List category,
  // the number of Thai occurrence records, the provinces they fall in, and the
  // Maps v2 density-tile template for the species in Thailand.
  iucn_status: string | null;
  th_record_count: number | null;
  th_provinces: string | null;
  map_tile_url: string | null;
  // Enriched from GBIF occurrence media: a photograph of the
  // species (iNaturalist-preferred) and its provenance, so a reader can show -
  // and correctly credit - what the plant looks like.
  photo_url: string | null;
  photo_source: string | null;
  photo_license: string | null;
  photo_credit: string | null;
  photo_ref: string | null;
  imported_at: string;
}

/** One api.dnp_fauna row (the dnp_fauna table) - national-park fauna. */
interface DnpFaunaRow {
  id: number;
  resource_id: string;
  source_id: string;
  source_url: string;
  license: string;
  group_type: string | null;
  protected_area: string;
  protected_area_en: string | null;
  thai_name: string | null;
  thai_name_alt: string | null;
  scientific_name: string | null;
  order_name: string | null;
  family: string | null;
  genus: string | null;
  iucn_status: string | null;
  onep_status: string | null;
  cites_status: string | null;
  habitat: string | null;
  distribution: string | null;
  location: string | null;
  location_en: string | null;
  province: string | null;
  latitude: number | null;
  longitude: number | null;
  // Enriched from GBIF occurrence media: the GBIF usageKey resolved from scientific_name,
  // and a photograph of the species (GBIF occurrence media, iNaturalist-
  // preferred) with its provenance.
  gbif_key: number | null;
  photo_url: string | null;
  photo_source: string | null;
  photo_license: string | null;
  photo_credit: string | null;
  photo_ref: string | null;
  imported_at: string;
}

/** One api.dnp_wildlife row (the dnp_wildlife table) - national checklist. */
interface DnpWildlifeRow {
  id: number;
  resource_id: string;
  source_id: string;
  source_url: string;
  license: string;
  group_type: string;
  thai_name: string | null;
  scientific_name: string;
  english_name: string | null;
  order_name: string | null;
  family: string | null;
  legal_status: string | null;
  is_reserved: boolean;
  is_protected: boolean;
  onep_2548: string | null;
  onep_2560: string | null;
  onep_2565: string | null;
  iucn_status: string | null;
  cites_status: string | null;
  seasonal_status: string | null;
  note: string | null;
  // Enriched from GBIF occurrence media: the GBIF usageKey resolved from scientific_name,
  // and a photograph of the species (GBIF occurrence media, iNaturalist-
  // preferred) with its provenance.
  gbif_key: number | null;
  photo_url: string | null;
  photo_source: string | null;
  photo_license: string | null;
  photo_credit: string | null;
  photo_ref: string | null;
  imported_at: string;
}

/** The JSON text a resource read returns, keyed by the URI it was read at. */
function asResource(uri: URL, value: unknown): ReadResourceResult {
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
  };
}

/** A URI variable is one value for these single-segment templates. */
function scalar(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

/** The first row of a filtered read, or undefined when nothing matched. */
async function first<T>(query: string, caller: Caller): Promise<T | undefined> {
  return (await get<T[]>(query, caller))[0];
}

/** A missing id is a not-found read, not an empty result, so it raises. */
function missing(uri: URL, kind: string, id: string): never {
  throw new Error(`No ${kind} with id "${id}" (${uri.href}).`);
}

/**
 * The Wikipedia lead for a species, or undefined when the row names no species
 * or Wikipedia has no article. External reference text (CC BY-SA 4.0) attached
 * to the resource so a reader gets the encyclopaedic summary alongside the
 * record - never fabricated, so a missing lookup leaves the field off entirely.
 */
async function wikipediaFor(name: string | null | undefined): Promise<WikiSummary | undefined> {
  if (!name) return undefined;
  return (await fetchWikiSummary(name)) ?? undefined;
}

export function registerCatalogResources(server: McpServer, caller: Caller): void {
  server.registerResource(
    'species',
    new ResourceTemplate('globie://species/{id}', {
      list: async () => {
        const rows = await get<{ id: string; name: string }[]>(
          'species?select=id,name&order=sort_order',
          caller,
        );
        return {
          resources: rows.map((row) => ({
            uri: `globie://species/${row.id}`,
            name: row.name,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Species',
      description: 'A native species in the Globie Earth catalogue, by its id.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = scalar(variables.id);
      const row = await first<SpeciesRow>(
        `species?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
        caller,
      );
      if (!row) missing(uri, 'species', id);
      // The catalogue row carries the scientific name in `botanical`; the
      // Wikipedia lead is external context for it.
      const wikipedia = await wikipediaFor(row.botanical);
      return asResource(uri, {
        id: row.id,
        name: row.name,
        botanical: row.botanical,
        tagline: row.tagline,
        needBadge: row.need_badge,
        needColor: row.need_color,
        image: row.image,
        description: row.description,
        adoptedCount: row.adopted_count,
        totalQuota: row.total_quota,
        pledgeUsd: Number(row.pledge_usd),
        stages: row.stages,
        currentStageIndex: row.current_stage_index,
        wikipedia,
      });
    },
  );

  server.registerResource(
    'guardian',
    new ResourceTemplate('globie://guardian/{id}', {
      list: async () => {
        const rows = await get<{ id: string; name: string }[]>(
          'guardians?select=id,name&order=sort_order',
          caller,
        );
        return {
          resources: rows.map((row) => ({
            uri: `globie://guardian/${row.id}`,
            name: row.name,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Guardian',
      description: 'A guardian of the sanctuary - its lore, rarity and traits - by its id.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = scalar(variables.id);
      const row = await first<GuardianRow>(
        `guardians?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
        caller,
      );
      if (!row) missing(uri, 'guardian', id);
      // A guardian's bond is per-device and lives in api.guardian_pledges, so
      // it is deliberately not part of this world-readable catalogue resource.
      return asResource(uri, {
        id: row.id,
        name: row.name,
        thaiName: row.thai_name,
        scientificName: row.scientific_name,
        title: row.title,
        rarity: row.rarity,
        image: row.image,
        epithet: row.epithet,
        quote: row.quote,
        traits: row.traits,
        metrics: row.metrics,
        locked: row.locked || undefined,
        unlockRequirement: row.unlock_requirement ?? undefined,
      });
    },
  );

  server.registerResource(
    'site',
    new ResourceTemplate('globie://site/{id}', {
      list: async () => {
        const rows = await get<{ id: number; title: string }[]>(
          'sites?select=id,title&order=sort_order',
          caller,
        );
        return {
          resources: rows.map((row) => ({
            uri: `globie://site/${row.id}`,
            name: row.title,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Site',
      description: 'A stop on the sanctuary trail, by its numeric id.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = scalar(variables.id);
      // id is an integer column, so a non-numeric segment can never match and is
      // reported as not-found rather than sent on to PostgREST to error.
      if (!/^\d+$/.test(id)) missing(uri, 'site', id);
      const row = await first<SiteRow>(`sites?select=*&id=eq.${id}&limit=1`, caller);
      if (!row) missing(uri, 'site', id);
      return asResource(uri, {
        id: row.id,
        title: row.title,
        subSector: row.sub_sector,
        image: row.image,
        // Both null columns stay off the object entirely, as api.ts does, so
        // `videoUrl &&` style guards keep working.
        videoUrl: row.video_url ?? undefined,
        badge: row.badge ?? undefined,
        gpsCoords: row.gps_coords,
        telemetry: row.telemetry,
        description: row.description,
        additionalPhotos: row.additional_photos?.length ? row.additional_photos : undefined,
      });
    },
  );

  // The biodiversity survey is ~61k rows, so this template deliberately has no list
  // callback (the SDK requires it be passed explicitly, even as undefined): the
  // resources/list surface stays small, and a record is read by the id a search
  // hit already returned. The id is an integer column (bigserial), so a
  // non-numeric segment can never match and is reported as not-found rather than
  // sent on to PostgREST to error.
  server.registerResource(
    'dnp-species',
    new ResourceTemplate('globie://dnp/{id}', { list: undefined }),
    {
      title: 'Biodiversity survey record',
      description:
        'One surveyed species record from the protected-area biodiversity survey, by its ' +
        'numeric id.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = scalar(variables.id);
      if (!/^\d+$/.test(id)) missing(uri, 'survey record', id);
      const row = await first<DnpRow>(`dnp_species?select=*&id=eq.${id}&limit=1`, caller);
      if (!row) missing(uri, 'survey record', id);
      const wikipedia = await wikipediaFor(row.scientific_name);
      return asResource(uri, {
        id: row.id,
        scientificName: row.scientific_name ?? undefined,
        thaiName: row.thai_name ?? undefined,
        family: row.family ?? undefined,
        synonyms: row.synonyms ?? undefined,
        groupType: row.group_type,
        protectedArea: row.protected_area,
        forestType: row.forest_type ?? undefined,
        surveyYearBe: row.survey_year_be ?? undefined,
        // External Wikipedia context for the species, when it has an article.
        wikipedia,
        // Provenance, so a reader can trace the record to the exact upstream row.
        resourceId: row.resource_id,
        sourceId: row.source_id,
        sourceUrl: row.source_url,
        license: row.license,
        importedAt: row.imported_at,
      });
    },
  );

  // The plant checklist is ~9k rows, so - exactly like the survey - this
  // template has no list callback (the SDK requires it be passed explicitly,
  // even as undefined): the resources/list surface stays small, and a record is
  // read by the id a search hit already returned. The id is a bigserial, so a
  // non-numeric segment can never match and is reported as not-found rather than
  // sent on to PostgREST to error.
  server.registerResource(
    'dnp-plant',
    new ResourceTemplate('globie://dnp-plant/{id}', { list: undefined }),
    {
      title: 'Plant checklist record',
      description:
        'One species from the national plant checklist (species recorded in Thailand), by ' +
        'its numeric id, with an English common name resolved from GBIF where one exists.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = scalar(variables.id);
      if (!/^\d+$/.test(id)) missing(uri, 'plant checklist record', id);
      const row = await first<DnpPlantRow>(`dnp_plants?select=*&id=eq.${id}&limit=1`, caller);
      if (!row) missing(uri, 'plant checklist record', id);
      const wikipedia = await wikipediaFor(row.scientific_name);
      return asResource(uri, {
        id: row.id,
        scientificName: row.scientific_name,
        thaiName: row.thai_name ?? undefined,
        family: row.family ?? undefined,
        // Enriched from GBIF: the genus, the accepted
        // synonyms and how the species relates to Thailand. Each stays off the
        // object when GBIF documents nothing for it.
        genus: row.genus ?? undefined,
        synonyms: row.synonyms ?? undefined,
        nativeStatus: row.native_status ?? undefined,
        // Enriched from GBIF: how threatened the
        // species is, how many records GBIF holds for it in Thailand and where,
        // and the Maps v2 density-tile template for it (with {z}/{x}/{y} for the
        // reader to fill). thRecordCount keeps a real 0; each field stays off the
        // object when GBIF documents nothing for it.
        iucnStatus: row.iucn_status ?? undefined,
        thRecordCount: row.th_record_count ?? undefined,
        thProvinces: row.th_provinces ?? undefined,
        mapTileUrl: row.map_tile_url ?? undefined,
        // External Wikipedia context for the species, when it has an article.
        wikipedia,
        // Enriched from GBIF occurrence media: a photograph of the species (GBIF
        // occurrence media, iNaturalist-preferred) with the provenance needed to
        // display it and credit it. Each stays off the object when GBIF holds no
        // image for the species.
        photoUrl: row.photo_url ?? undefined,
        photoSource: row.photo_source ?? undefined,
        photoLicense: row.photo_license ?? undefined,
        photoCredit: row.photo_credit ?? undefined,
        photoRef: row.photo_ref ?? undefined,
        // The English common name and how it was resolved. Both stay off the
        // object when GBIF documents no English name for the species.
        englishName: row.english_name ?? undefined,
        englishSource: row.english_source ?? undefined,
        gbifKey: row.gbif_key ?? undefined,
        gbifMatchType: row.gbif_match_type ?? undefined,
        gbifConfidence: row.gbif_confidence ?? undefined,
        // Provenance, so a reader can trace the record to the exact upstream row.
        resourceId: row.resource_id,
        sourceId: row.source_id,
        sourceUrl: row.source_url,
        license: row.license,
        importedAt: row.imported_at,
      });
    },
  );

  // The fauna observations are ~5k rows, so exactly like the survey and the
  // checklist this template has no list callback (the SDK requires it be passed
  // explicitly, even as undefined): the resources/list surface stays small, and a
  // record is read by the id a search hit already returned. The id is a
  // bigserial, so a non-numeric segment can never match and is reported as
  // not-found rather than sent on to PostgREST to error.
  server.registerResource(
    'dnp-fauna',
    new ResourceTemplate('globie://dnp-fauna/{id}', { list: undefined }),
    {
      title: 'National-park fauna observation',
      description:
        'One fauna record from the survey of species observed inside protected areas, by ' +
        'its numeric id - with the park, taxonomy and IUCN/ONEP/CITES conservation status.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = scalar(variables.id);
      if (!/^\d+$/.test(id)) missing(uri, 'fauna record', id);
      const row = await first<DnpFaunaRow>(`dnp_fauna?select=*&id=eq.${id}&limit=1`, caller);
      if (!row) missing(uri, 'fauna record', id);
      const wikipedia = await wikipediaFor(row.scientific_name);
      return asResource(uri, {
        id: row.id,
        scientificName: row.scientific_name ?? undefined,
        thaiName: row.thai_name ?? undefined,
        thaiNameAlt: row.thai_name_alt ?? undefined,
        groupType: row.group_type ?? undefined,
        protectedArea: row.protected_area,
        protectedAreaEn: row.protected_area_en ?? undefined,
        orderName: row.order_name ?? undefined,
        family: row.family ?? undefined,
        genus: row.genus ?? undefined,
        iucnStatus: row.iucn_status ?? undefined,
        onepStatus: row.onep_status ?? undefined,
        citesStatus: row.cites_status ?? undefined,
        habitat: row.habitat ?? undefined,
        distribution: row.distribution ?? undefined,
        location: row.location ?? undefined,
        locationEn: row.location_en ?? undefined,
        province: row.province ?? undefined,
        latitude: row.latitude ?? undefined,
        longitude: row.longitude ?? undefined,
        // External Wikipedia context for the species, when it has an article.
        wikipedia,
        // Enriched from GBIF occurrence media: the resolved GBIF usageKey and a photograph
        // of the species (GBIF occurrence media, iNaturalist-preferred) with its
        // provenance. Each stays off the object when GBIF holds no image.
        gbifKey: row.gbif_key ?? undefined,
        photoUrl: row.photo_url ?? undefined,
        photoSource: row.photo_source ?? undefined,
        photoLicense: row.photo_license ?? undefined,
        photoCredit: row.photo_credit ?? undefined,
        photoRef: row.photo_ref ?? undefined,
        // Provenance, so a reader can trace the record to the exact upstream row.
        resourceId: row.resource_id,
        sourceId: row.source_id,
        sourceUrl: row.source_url,
        license: row.license,
        importedAt: row.imported_at,
      });
    },
  );

  // The national wildlife checklist is ~2k rows, so exactly like the other three
  // forest datasets this template has no list callback (the SDK requires it be passed
  // explicitly, even as undefined): the resources/list surface stays small, and a
  // record is read by the id a search hit already returned. The id is a
  // bigserial, so a non-numeric segment can never match and is reported as
  // not-found rather than sent on to PostgREST to error.
  server.registerResource(
    'dnp-wildlife',
    new ResourceTemplate('globie://dnp-wildlife/{id}', { list: undefined }),
    {
      title: 'National wildlife checklist record',
      description:
        'One species from the national wildlife checklist (birds, mammals, reptiles, ' +
        'amphibians), by its numeric id, with the statutory protected/reserved flags and ' +
        'ONEP/IUCN/CITES status.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = scalar(variables.id);
      if (!/^\d+$/.test(id)) missing(uri, 'wildlife record', id);
      const row = await first<DnpWildlifeRow>(`dnp_wildlife?select=*&id=eq.${id}&limit=1`, caller);
      if (!row) missing(uri, 'wildlife record', id);
      const wikipedia = await wikipediaFor(row.scientific_name);
      return asResource(uri, {
        id: row.id,
        scientificName: row.scientific_name,
        thaiName: row.thai_name ?? undefined,
        englishName: row.english_name ?? undefined,
        groupType: row.group_type,
        orderName: row.order_name ?? undefined,
        family: row.family ?? undefined,
        // The row's own legal-status code, plus the authoritative statutory flags
        // matched from the protected/reserved lists. Both flags are always
        // present so a reader can branch on them without null checks.
        legalStatus: row.legal_status ?? undefined,
        isReserved: row.is_reserved,
        isProtected: row.is_protected,
        onep2548: row.onep_2548 ?? undefined,
        onep2560: row.onep_2560 ?? undefined,
        onep2565: row.onep_2565 ?? undefined,
        iucnStatus: row.iucn_status ?? undefined,
        citesStatus: row.cites_status ?? undefined,
        seasonalStatus: row.seasonal_status ?? undefined,
        note: row.note ?? undefined,
        // External Wikipedia context for the species, when it has an article.
        wikipedia,
        // Enriched from GBIF occurrence media: the resolved GBIF usageKey and a
        // photograph of the species (GBIF occurrence media, iNaturalist-preferred)
        // with its provenance. Each stays off the object when GBIF holds no image.
        gbifKey: row.gbif_key ?? undefined,
        photoUrl: row.photo_url ?? undefined,
        photoSource: row.photo_source ?? undefined,
        photoLicense: row.photo_license ?? undefined,
        photoCredit: row.photo_credit ?? undefined,
        photoRef: row.photo_ref ?? undefined,
        // Provenance, so a reader can trace the record to the exact upstream row.
        resourceId: row.resource_id,
        sourceId: row.source_id,
        sourceUrl: row.source_url,
        license: row.license,
        importedAt: row.imported_at,
      });
    },
  );
}
