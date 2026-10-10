// Imports the DNP biodiversity survey into api.dnp_species.
//
// The upstream is a CKAN portal (https://catalog.dnp.go.th, package
// biodiversity-survey-species, Forest Research Office, "Open Data Common"
// licence). Its master resource is datastore_active, so the rows are read
// straight from the CKAN DataStore API as typed JSON - no XLSX to download and
// parse, no CSV to split. Only the columns 120_dnp.sql declares are kept.
//
//   npm run build
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run import:dnp
//
// Why a direct connection instead of PostgREST: 120_dnp.sql revokes
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

// The master resource spanning BE 2554-2564, i.e. the 61k-row survey the task
// links. Override to import another resource (e.g. a per-year CSV) instead.
const RESOURCE_ID =
  process.env.DNP_RESOURCE_ID ?? 'e3a979c4-f7f9-4b0d-a071-2fac60fd449e';

// CKAN's default page size. Datastore_search caps `limit` server-side, so this
// stays well inside it; paging is by offset until the reported total is reached.
const PAGE_SIZE = 5000;

// Rows per INSERT. Large enough to keep round-trips down, small enough to stay
// clear of any statement-size surprise.
const BATCH_SIZE = 500;

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so there is no database to write to.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run import:dnp',
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

/** A survey year is either an integer or NULL, never a quoted string. */
function sqlInt(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : 'NULL';
}

/** The upstream resource page, for the provenance URL stored on every row. */
const SOURCE_URL = `${CKAN_BASE}/dataset/biodiversity-survey-species/resource/${RESOURCE_ID}`;

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

/** Maps one upstream record to the columns 120_dnp.sql declares. */
function toRow(record) {
  const scientific = record['ชื่อวิทยาศาสตร์'];
  const thai = record['ชื่อไทย'];
  // A row with neither name carries no searchable text, so it is dropped rather
  // than embedded as an empty string.
  if (!String(scientific ?? '').trim() && !String(thai ?? '').trim()) return null;

  return {
    sourceId: String(record._id),
    groupType: String(record['ประเภท'] ?? '').trim(),
    protectedArea: String(record['พื้นที่อนุรักษ์'] ?? '').trim(),
    forestType: record['สังคมป่า'],
    surveyYearBe: record['ปีที่สำรวจ'],
    thaiName: thai,
    scientificName: scientific,
    family: record['ชื่อวงศ์'],
    synonyms: record['ชื่อพ้อง'],
  };
}

/** The multi-row upsert for one batch, keyed on the upstream row's identity. */
function upsertSql(rows) {
  const values = rows
    .map(
      (row) =>
        `  (${sqlText(RESOURCE_ID)}, ${sqlText(row.sourceId)}, ${sqlText(SOURCE_URL)}, ` +
        `${sqlText(row.groupType)}, ${sqlText(row.protectedArea)}, ${sqlText(row.forestType)}, ` +
        `${sqlInt(row.surveyYearBe)}, ${sqlText(row.thaiName)}, ${sqlText(row.scientificName)}, ` +
        `${sqlText(row.family)}, ${sqlText(row.synonyms)})`,
    )
    .join(',\n');

  return `insert into api.dnp_species (
  resource_id, source_id, source_url, group_type, protected_area, forest_type,
  survey_year_be, thai_name, scientific_name, family, synonyms
) values
${values}
on conflict (resource_id, source_id) do update set
  source_url      = excluded.source_url,
  group_type      = excluded.group_type,
  protected_area  = excluded.protected_area,
  forest_type     = excluded.forest_type,
  survey_year_be  = excluded.survey_year_be,
  thai_name       = excluded.thai_name,
  scientific_name = excluded.scientific_name,
  family          = excluded.family,
  synonyms        = excluded.synonyms,
  imported_at     = now();`;
}

process.stdout.write(`Importing DNP resource ${RESOURCE_ID}\n  from ${CKAN_BASE}\n\n`);

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
  `select count(*) from api.dnp_species where resource_id = ${sqlText(RESOURCE_ID)};`,
]).trim();

console.log('');
console.log(`  pages fetched  ${fetched} upstream row(s) read`);
console.log(`  upserted       ${inserted} row(s)`);
console.log(`  api.dnp_species ${stored} row(s) for this resource`);
console.log('');
console.log('Done. Run `npm run backfill:embeddings -- dnp_species` to make these searchable.');
