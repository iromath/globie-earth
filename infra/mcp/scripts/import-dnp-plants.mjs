// Imports the DNP plant checklist into api.dnp_plants, with English common names.
//
// The upstream is a CKAN portal (https://catalog.dnp.go.th, package
// plant-species, Forest and Plant Conservation Research Office, "Open Data
// Common" licence). Unlike the survey (import-dnp.mjs), none of its resources is
// datastore_active, so there is no DataStore API to page: the CSV has to be
// downloaded and parsed. The resource URL is resolved live from package_show, so
// a re-uploaded file is picked up without editing this script.
//
//   npm run build
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run import:dnp-plants
//
// English: the checklist carries no English field. Each species' scientific name
// is matched against GBIF (the citable botanical authority) and, where GBIF
// documents an English vernacular name, that name is stored as english_name with
// its GBIF key and match provenance. Species GBIF has no English name for keep
// english_name = null - a missing translation is reported as missing, never
// invented. Matches are cached under scripts/.cache/ so a re-run is cheap.
//
// Set DNP_PLANTS_SKIP_GBIF=1 to import the checklist alone (fast, no English),
// and DNP_PLANTS_CSV=<path> to import a local file instead of downloading.
//
// Why a direct connection instead of PostgREST: 130_dnp_plants.sql revokes
// insert/update/delete from anon, so only the migration role may write, exactly
// as backfill-embeddings.mjs does for api.embeddings.
//
// Idempotent: the upsert is keyed on (resource_id, scientific_name), the
// species' stable identity, so a re-run refreshes rows instead of duplicating.
//
// Exit 0: every row was read and upserted.
// Exit 1: a download, parse, GBIF lookup, or upsert failed.
// Exit 3: DATABASE_URL is not set.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CKAN_BASE = (process.env.DNP_CKAN_BASE ?? 'https://catalog.dnp.go.th').replace(/\/+$/, '');
const PACKAGE_NAME = process.env.DNP_PLANTS_PACKAGE ?? 'plant-species';

// The CSV resource (format CSV, the complete checklist). The XLSX resource holds
// the same rows; the CSV is the one to parse. Override to import another file.
const RESOURCE_ID =
  process.env.DNP_PLANTS_RESOURCE_ID ?? 'be9eae79-4852-4017-959d-63b95341b6ef';

const GBIF_BASE = (process.env.GBIF_BASE ?? 'https://api.gbif.org/v1').replace(/\/+$/, '');
const SKIP_GBIF = process.env.DNP_PLANTS_SKIP_GBIF === '1';
const CSV_PATH = process.env.DNP_PLANTS_CSV ?? '';

// GBIF is a public, generous API; a small pool keeps the ~9k species lookups
// quick without opening a flood of sockets.
const CONCURRENCY = Number(process.env.DNP_PLANTS_CONCURRENCY ?? 6);

// Rows per INSERT. Same size as import-dnp.mjs: few round-trips, no giant statement.
const BATCH_SIZE = 500;

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so there is no database to write to.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run import:dnp-plants',
  );
  process.exit(3);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** A numeric column is either an integer or NULL, never a quoted string. */
function sqlInt(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : 'NULL';
}

/** A GET that retries throttling/5xx with backoff, then gives up loudly. */
async function fetchJson(url, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'globie-earth/1.0 (import-dnp-plants)' },
      });
      if (response.status === 429 || response.status >= 500) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(300 * 2 ** attempt);
    }
  }
  throw new Error(`GET ${url} failed after ${tries} tries: ${message(lastError)}`);
}

// --------------------------------------------------------------- the CSV ----

/**
 * RFC 4180 CSV, sufficient for this export: quoted fields (the botanical names
 * carry citation commas inside quotes), escaped quotes, CRLF or LF, UTF-8 BOM.
 */
function parseCsv(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The resource's own download URL, resolved live so a re-upload is picked up. */
async function resolveCsvUrl() {
  const payload = await fetchJson(
    `${CKAN_BASE}/api/3/action/package_show?id=${encodeURIComponent(PACKAGE_NAME)}`,
  );
  const resources = payload?.result?.resources;
  if (!Array.isArray(resources)) {
    throw new Error('package_show returned no resources array.');
  }
  const resource = resources.find((r) => r.id === RESOURCE_ID) ?? resources.find((r) => r.format === 'CSV');
  if (!resource?.url) {
    throw new Error(`No downloadable resource (id ${RESOURCE_ID} or CSV) in package ${PACKAGE_NAME}.`);
  }
  return { url: resource.url, packageId: payload.result.id };
}

/** The checklist rows, from a local file when given, else the CKAN download. */
async function loadCsv() {
  if (CSV_PATH) {
    process.stdout.write(`Reading local CSV ${CSV_PATH}\n`);
    return { text: readFileSync(CSV_PATH, 'utf8'), url: '', packageId: null };
  }
  const { url, packageId } = await resolveCsvUrl();
  process.stdout.write(`Downloading ${url}\n`);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'globie-earth/1.0 (import-dnp-plants)' },
  });
  if (!response.ok) throw new Error(`CSV download returned HTTP ${response.status}.`);
  return { text: await response.text(), url, packageId };
}

// -------------------------------------------------------------- the GBIF ----

const CACHE_FILE = fileURLToPath(new URL('./.cache/dnp-plants-gbif.json', import.meta.url));
let cache = {};
try {
  cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
} catch {
  cache = {};
}
let cacheDirty = 0;

function saveCache() {
  if (!cacheDirty) return;
  mkdirSync(fileURLToPath(new URL('./.cache/', import.meta.url)), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache));
  cacheDirty = 0;
}

/** The genus is the first word of the binomial, used to reject a genus echo. */
function genusOf(scientificName) {
  return String(scientificName).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/**
 * The best English vernacular name among GBIF's candidates. GBIF often lists the
 * bare genus and lowercased auto-forms alongside real common names, so a genus
 * echo and a bare lowercase token are pushed down, proper-noun multiword names
 * up. Deterministic: ties break alphabetically.
 */
function pickEnglish(names, genus) {
  const distinct = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  if (!distinct.length) return null;
  const scored = distinct.map((name) => {
    const lower = name.toLowerCase();
    let score = 0;
    if (lower === genus) score -= 100; // "Acanthus" is not a common name for Acanthus
    if (/^[A-Z]/.test(name)) score += 10; // proper-noun casing reads as a real name
    if (/\s/.test(name)) score += 5; // multiword beats a single token
    if (/^[a-z]+$/.test(name)) score -= 5; // bare lowercase auto-form
    score -= name.length * 0.01; // mild preference for the concise
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored[0].name;
}

/** Resolves one species to its English common name via GBIF, memoized on disk. */
async function enrich(scientificName) {
  if (cache[scientificName]) return cache[scientificName];

  let result = { key: null, matchType: null, confidence: null, english: null };
  try {
    const match = await fetchJson(
      `${GBIF_BASE}/species/match?name=${encodeURIComponent(scientificName)}`,
    );
    const key = match.acceptedUsageKey ?? match.usageKey ?? null;
    result = {
      key: key ?? null,
      matchType: match.matchType ?? null,
      confidence: match.confidence ?? null,
      english: null,
    };
    if (key) {
      const vernacular = await fetchJson(`${GBIF_BASE}/species/${key}/vernacularNames?limit=100`);
      const english = (vernacular?.results ?? [])
        .filter((row) => row.language === 'eng')
        .map((row) => row.vernacularName);
      result.english = pickEnglish(english, genusOf(scientificName));
    }
  } catch (error) {
    // A single species that GBIF cannot answer for is not fatal: it imports with
    // no English name, exactly like one GBIF has no name for. The reason is said
    // once so a systemic failure (auth, outage) is visible, not silently eaten.
    process.stdout.write(`  GBIF lookup failed for "${scientificName}": ${message(error)}\n`);
  }

  cache[scientificName] = result;
  cacheDirty += 1;
  if (cacheDirty >= 250) {
    saveCache();
    process.stdout.write(`  GBIF: ${Object.keys(cache).length} species cached\n`);
  }
  return result;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ------------------------------------------------------------- the import ----

/** The multi-row upsert for one batch, keyed on the species' stable identity. */
function upsertSql(rows) {
  const values = rows
    .map(
      (row) =>
        `  (${sqlText(row.resourceId)}, ${sqlText(row.sourceId)}, ${sqlText(row.sourceUrl)}, ` +
        `${sqlText(row.thaiName)}, ${sqlText(row.scientificName)}, ${sqlText(row.family)}, ` +
        `${sqlText(row.englishName)}, ${sqlText(row.englishName ? 'gbif' : null)}, ` +
        `${sqlInt(row.gbifKey)}, ${sqlText(row.gbifMatchType)}, ${sqlInt(row.gbifConfidence)})`,
    )
    .join(',\n');

  return `insert into api.dnp_plants (
  resource_id, source_id, source_url, thai_name, scientific_name, family,
  english_name, english_source, gbif_key, gbif_match_type, gbif_confidence
) values
${values}
on conflict (resource_id, scientific_name) do update set
  source_id       = excluded.source_id,
  source_url      = excluded.source_url,
  thai_name       = excluded.thai_name,
  family          = excluded.family,
  english_name    = excluded.english_name,
  english_source  = excluded.english_source,
  gbif_key        = excluded.gbif_key,
  gbif_match_type = excluded.gbif_match_type,
  gbif_confidence = excluded.gbif_confidence,
  imported_at     = now();`;
}

let imported = 0;
let withEnglish = 0;

function flush(rows) {
  while (rows.length) {
    const batch = rows.splice(0, BATCH_SIZE);
    try {
      psql(['-v', 'ON_ERROR_STOP=1', '-q'], upsertSql(batch));
    } catch (error) {
      console.error(`The upsert failed: ${message(error)}`);
      process.exit(1);
    }
    imported += batch.length;
    process.stdout.write(`  ${imported} row(s) upserted\n`);
  }
}

try {
  const { text } = await loadCsv();
  const table = parseCsv(text);
  const header = table.shift()?.map((h) => h.trim()) ?? [];
  const column = (name) => header.indexOf(name);
  for (const required of ['No.', 'LocalName_Thai', 'Botanical_Name', 'Family_Name']) {
    if (column(required) === -1) {
      throw new Error(`The CSV is missing the "${required}" column (found: ${header.join(', ')}).`);
    }
  }

  const sourceUrl = CSV_PATH
    ? `file://${CSV_PATH}`
    : `${CKAN_BASE}/dataset/${PACKAGE_NAME}/resource/${RESOURCE_ID}`;

  const rows = [];
  for (const fields of table) {
    const scientificName = String(fields[column('Botanical_Name')] ?? '').trim();
    // A checklist row with no scientific name carries no searchable identity.
    if (!scientificName) continue;
    rows.push({
      resourceId: RESOURCE_ID,
      sourceId: String(fields[column('No.')] ?? '').trim(),
      sourceUrl,
      thaiName: String(fields[column('LocalName_Thai')] ?? '').trim(),
      scientificName,
      family: String(fields[column('Family_Name')] ?? '').trim(),
      englishName: null,
      gbifKey: null,
      gbifMatchType: null,
      gbifConfidence: null,
    });
  }

  process.stdout.write(`  parsed ${rows.length} species from ${table.length} CSV row(s)\n`);

  if (SKIP_GBIF) {
    process.stdout.write('  DNP_PLANTS_SKIP_GBIF=1: importing without English names\n');
  } else {
    process.stdout.write(`  resolving English names from GBIF (${CONCURRENCY} at a time)\n`);
    await mapPool(rows, CONCURRENCY, async (row, index) => {
      const found = await enrich(row.scientificName);
      row.englishName = found.english;
      row.gbifKey = found.key;
      row.gbifMatchType = found.matchType;
      row.gbifConfidence = found.confidence;
      if (found.english) withEnglish += 1;
      if ((index + 1) % 1000 === 0) {
        process.stdout.write(`  GBIF: ${index + 1}/${rows.length} resolved\n`);
      }
    });
    saveCache();
  }

  // Captured before flush(), which consumes `rows` a batch at a time.
  const parsed = rows.length;
  flush(rows);

  const stored = psql([
    '-A',
    '-t',
    '-c',
    `select count(*) from api.dnp_plants where resource_id = ${sqlText(RESOURCE_ID)};`,
  ]).trim();
  const named = psql([
    '-A',
    '-t',
    '-c',
    `select count(*) from api.dnp_plants where resource_id = ${sqlText(RESOURCE_ID)} and english_name is not null;`,
  ]).trim();

  console.log('');
  console.log(`  parsed          ${parsed} species`);
  console.log(`  upserted        ${imported} row(s)`);
  console.log(`  english names   ${named} of ${stored} (GBIF)`);
  console.log(`  api.dnp_plants  ${stored} row(s) for this resource`);
  console.log('');
  console.log('Done. Run `npm run backfill:embeddings -- dnp_plant` to make these searchable.');
} catch (error) {
  saveCache();
  console.error(`The import failed: ${message(error)}`);
  process.exit(1);
}
