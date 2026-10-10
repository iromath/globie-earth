// Imports the DNP national-park fauna into api.dnp_fauna.
//
// The upstream is a CKAN portal (https://catalog.dnp.go.th, package
// animalnationalpark, Forest and Plant Conservation Research Office, "Open Data
// Common" licence). Its resource is datastore_active, so the rows are read
// straight from the CKAN DataStore API as typed JSON - no file to download and
// parse, exactly like import-dnp.mjs does for the biodiversity survey. Only the
// columns 140_dnp_fauna.sql declares are kept.
//
//   npm run build
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run import:dnp-fauna
//
// Why a direct connection instead of PostgREST: 140_dnp_fauna.sql revokes
// insert/update/delete from anon, so only the migration role may write, exactly
// as backfill-embeddings.mjs does for api.embeddings.
//
// Idempotent: the upsert is keyed on (resource_id, source_id), the upstream
// row's own identity, so a re-run refreshes rows instead of duplicating them.
//
// Exit 0: every page was fetched and upserted.
// Exit 1: an upstream fetch, a bad payload, or the upsert failed.
// Exit 3: DATABASE_URL is not set.

import { execFileSync } from 'node:child_process';

const CKAN_BASE = (process.env.DNP_CKAN_BASE ?? 'https://catalog.dnp.go.th').replace(/\/+$/, '');

// The fauna-in-national-parks resource (5,112 observations across 43 parks).
// Override to import another resource instead.
const RESOURCE_ID =
  process.env.DNP_FAUNA_RESOURCE_ID ?? '70bd7063-d6ea-4efb-9987-dd9b67435a20';

const PACKAGE_NAME = process.env.DNP_FAUNA_PACKAGE ?? 'animalnationalpark';

// CKAN's default page size. Datastore_search caps `limit` server-side, so this
// stays well inside it; paging is by offset until the reported total is reached.
const PAGE_SIZE = 5000;

// Rows per INSERT. Same size as the other importers: few round-trips, no giant
// statement.
const BATCH_SIZE = 500;

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so there is no database to write to.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run import:dnp-fauna',
  );
  process.exit(3);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Runs psql against DATABASE_URL, optionally feeding SQL on stdin. */
function psql(args, input) {
  try {
    return execFileSync('psql', [databaseUrl, '-w', '-X', ...args], {
      input,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('psql was not found on PATH. It is the client maintenance/run.sh already uses.');
      process.exit(1);
    }
    throw error;
  }
}

/** One line of SQL text, or NULL for a missing/blank value. */
function sqlText(value) {
  if (value === null || value === undefined) return 'NULL';
  const text = String(value).trim();
  if (!text) return 'NULL';
  return `'${text.replace(/'/g, "''")}'`;
}

/** A numeric column is either a number or NULL, never a quoted string. */
function sqlNum(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

/** The upstream resource page, for the provenance URL stored on every row. */
const SOURCE_URL = `${CKAN_BASE}/dataset/${PACKAGE_NAME}/resource/${RESOURCE_ID}`;

/** One page of datastore_search, as JSON records plus the grand total. */
async function fetchPage(offset) {
  const url =
    `${CKAN_BASE}/api/3/action/datastore_search` +
    `?resource_id=${encodeURIComponent(RESOURCE_ID)}&limit=${PAGE_SIZE}&offset=${offset}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CKAN returned HTTP ${response.status} for offset ${offset}.`);
  }
  const payload = await response.json();
  if (!payload?.success) {
    throw new Error(`CKAN reported failure: ${JSON.stringify(payload?.error ?? payload)}`);
  }
  const records = payload.result?.records;
  if (!Array.isArray(records)) {
    throw new Error('datastore_search returned no records array.');
  }
  return { records, total: Number(payload.result.total ?? records.length) };
}

/**
 * Maps one upstream record to the columns 140_dnp_fauna.sql declares. Names are
 * trimmed (the park Thai name arrives trailing-padded); every absent value is
 * stored as NULL rather than an empty string.
 */
function toRow(record) {
  const scientific = record.SCI_N_E;
  const thai = record.COM_NAME_T;
  // A row with neither name carries no searchable text, so it is dropped rather
  // than embedded as an empty string.
  if (!String(scientific ?? '').trim() && !String(thai ?? '').trim()) return null;

  return {
    sourceId: String(record._id),
    groupType: record.MBIO_DES_T_EDIT,
    protectedArea: record.PTA_NAM_T,
    protectedAreaEn: record.PTA_NAM_E,
    thaiName: thai,
    thaiNameAlt: record.COM_NAME_T1,
    scientificName: scientific,
    orderName: record.ORD_N_E,
    family: record.FAM_N_E,
    genus: record.GN_N_E,
    iucnStatus: record.IUCN2004,
    onepStatus: record.ONEP2005,
    citesStatus: record.CITES,
    habitat: record.HABITAT,
    distribution: record.DISTRIBUTI,
    location: record.LOC_N_T,
    locationEn: record.LOC_N_E,
    province: record.IN_PROV,
    // The upstream stores Indian 1975 grid coordinates: X is easting (longitude),
    // Y is northing (latitude).
    latitude: record.Y_INDIAN75,
    longitude: record.X_INDIAN75,
  };
}

/** The multi-row upsert for one batch, keyed on the upstream row's identity. */
function upsertSql(rows) {
  const values = rows
    .map(
      (row) =>
        `  (${sqlText(RESOURCE_ID)}, ${sqlText(row.sourceId)}, ${sqlText(SOURCE_URL)}, ` +
        `${sqlText(row.groupType)}, ${sqlText(row.protectedArea)}, ${sqlText(row.protectedAreaEn)}, ` +
        `${sqlText(row.thaiName)}, ${sqlText(row.thaiNameAlt)}, ${sqlText(row.scientificName)}, ` +
        `${sqlText(row.orderName)}, ${sqlText(row.family)}, ${sqlText(row.genus)}, ` +
        `${sqlText(row.iucnStatus)}, ${sqlText(row.onepStatus)}, ${sqlText(row.citesStatus)}, ` +
        `${sqlText(row.habitat)}, ${sqlText(row.distribution)}, ` +
        `${sqlText(row.location)}, ${sqlText(row.locationEn)}, ${sqlText(row.province)}, ` +
        `${sqlNum(row.latitude)}, ${sqlNum(row.longitude)})`,
    )
    .join(',\n');

  return `insert into api.dnp_fauna (
  resource_id, source_id, source_url, group_type, protected_area, protected_area_en,
  thai_name, thai_name_alt, scientific_name, order_name, family, genus,
  iucn_status, onep_status, cites_status, habitat, distribution,
  location, location_en, province, latitude, longitude
) values
${values}
on conflict (resource_id, source_id) do update set
  source_url        = excluded.source_url,
  group_type        = excluded.group_type,
  protected_area    = excluded.protected_area,
  protected_area_en = excluded.protected_area_en,
  thai_name         = excluded.thai_name,
  thai_name_alt     = excluded.thai_name_alt,
  scientific_name   = excluded.scientific_name,
  order_name        = excluded.order_name,
  family            = excluded.family,
  genus             = excluded.genus,
  iucn_status       = excluded.iucn_status,
  onep_status       = excluded.onep_status,
  cites_status      = excluded.cites_status,
  habitat           = excluded.habitat,
  distribution      = excluded.distribution,
  location          = excluded.location,
  location_en       = excluded.location_en,
  province          = excluded.province,
  latitude          = excluded.latitude,
  longitude         = excluded.longitude,
  imported_at       = now();`;
}

process.stdout.write(`Importing DNP fauna resource ${RESOURCE_ID}\n  from ${CKAN_BASE}\n\n`);

let offset = 0;
let fetched = 0;
let inserted = 0;
let total = null;
let pending = [];

/** Flushes `pending` to Postgres in BATCH_SIZE chunks, then clears it. */
function flush() {
  while (pending.length) {
    const batch = pending.splice(0, BATCH_SIZE);
    try {
      psql(['-v', 'ON_ERROR_STOP=1', '-q'], upsertSql(batch));
    } catch (error) {
      console.error(`The upsert failed at offset ${offset}: ${message(error)}`);
      process.exit(1);
    }
    inserted += batch.length;
    process.stdout.write(`  ${inserted} row(s) upserted\n`);
  }
}

try {
  do {
    const { records, total: reported } = await fetchPage(offset);
    if (total === null) total = reported;
    if (records.length === 0) break;

    fetched += records.length;
    for (const record of records) {
      const row = toRow(record);
      if (row) pending.push(row);
    }
    if (pending.length >= BATCH_SIZE * 4) flush();

    offset += records.length;
  } while (total === null || offset < total);

  flush();
} catch (error) {
  console.error(`The import failed: ${message(error)}`);
  process.exit(1);
}

const stored = psql([
  '-A',
  '-t',
  '-c',
  `select count(*) from api.dnp_fauna where resource_id = ${sqlText(RESOURCE_ID)};`,
]).trim();

console.log('');
console.log(`  rows fetched   ${fetched} upstream row(s) read`);
console.log(`  upserted       ${inserted} row(s)`);
console.log(`  api.dnp_fauna  ${stored} row(s) for this resource`);
console.log('');
console.log('Done. Run `npm run backfill:embeddings -- dnp_fauna` to make these searchable.');
