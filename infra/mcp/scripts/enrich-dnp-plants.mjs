// Enriches the DNP plant checklist (api.dnp_plants) from GBIF.
//
// The dnp_plants table stored each plant with its English common name resolved
// from GBIF, GBIF enrichment added three more columns and a Red List / range
// pass added a further four. This fills all of them,
// so a listener can ask about a plant's genus, its synonyms, whether it grows wild
// in Thailand, how threatened it is, and where in Thailand it has been recorded -
// not just what it is called:
//
//   genus           species/<key>.genus
//   synonyms        species/<key>/synonyms, the synonym names comma-joined
//   native_status   species/<key>/distributions, whether the species is recorded
//                   as native/introduced/cultivated in Thailand
//   iucn_status     species/<key>/iucnRedListCategory.code (HTTP 204 => null)
//   th_record_count from ONE faceted occurrence/search over Thailand, the record
//                   count for every Thai taxon at once (no per-key call)
//   th_provinces    occurrence/search?taxonKey=<key>&country=TH stateProvince
//                   facet, the top provinces (a per-key call, best-effort)
//   map_tile_url    the GBIF Maps v2 density-tile template for the species in
//                   Thailand, derived from the key (no call needed)
//
// Every row already carries the GBIF usageKey it was matched to as gbif_key, so
// there is no matching to redo - the importer reads the distinct keys already in
// the table and fetches only the per-key detail endpoints. A key GBIF no longer
// answers for is left untouched (its columns keep their previous values) and
// retried on the next run, so a transient outage never clears good data.
//
//   npm run build
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run enrich:dnp-plants
//
// The run has two passes. Pass 1 fetches the detail facts (genus, synonyms, native
// status, IUCN) at a small concurrency and folds in the free record count, then
// writes them, so those signals are stored before the slow province pass. Pass 2
// fetches the provinces one at a time, spaced, and only after pass 1 has drained -
// GBIF throttles occurrence/search hard when other calls run alongside it.
//
// Responses are cached under scripts/.cache/dnp-plants-enrich.json, keyed by GBIF
// key, so a re-run is cheap and does not re-hit GBIF. The cache is filled per
// field group: a key cached by an earlier version of this script (which stored
// only genus/synonyms/native_status) has its new fields fetched without redoing
// the old lookups. A key whose province lookup has not settled is retried next run
// (its count is refolded from the bulk facet every run either way).
// Delete that file to refetch everything.
//
// Why a direct connection instead of PostgREST: the dnp_plants table revokes
// insert/update/delete from anon, so only the migration role may write, exactly
// as backfill-embeddings.mjs does for api.embeddings.
//
// Idempotent: the update is keyed on gbif_key, the species' stable GBIF identity,
// so a re-run refreshes all seven columns in place.
//
// Exit 0: every key was resolved (or had no data) and written.
// Exit 1: a GBIF lookup or update failed fatally.
// Exit 3: DATABASE_URL is not set.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GBIF_BASE = (process.env.GBIF_BASE ?? 'https://api.gbif.org/v1').replace(/\/+$/, '');

// The occurrence-density tiles live under the Maps v2 API, not v1.
const GBIF_MAP_BASE = (process.env.GBIF_MAP_BASE ?? 'https://api.gbif.org/v2').replace(/\/+$/, '');

// GBIF is a public, generous API, but a burst of parallel calls gets the IP
// throttled across every endpoint, so the detail lookups run in a small pool.
const CONCURRENCY = Number(process.env.DNP_PLANTS_ENRICH_CONCURRENCY ?? 4);

// The per-species province lookup hits occurrence/search, GBIF's rate-sensitive
// endpoint: the docs warn that rapid queries answer HTTP 429. Even a couple of
// concurrent calls trip it, so province lookups are serialized and spaced, one
// starting every OCCURRENCE_INTERVAL_MS. A province lookup still throttled after
// fetchJson's retries leaves the key's count and other facts intact and is
// retried on the next run. Raise the interval if a run reports 429s.
const OCCURRENCE_INTERVAL_MS = Number(process.env.DNP_PLANTS_OCCURRENCE_INTERVAL_MS ?? 1100);

// Keys per UPDATE. Few round-trips, no giant statement.
const BATCH_SIZE = 500;

// A synonym list is search text, not a monograph: the first thirty names are
// ample to match a caller's word, and a cap keeps a polyphyletic species from
// bloating the row. species/<key>/synonyms is asked for its first 100.
const SYNONYM_LIMIT = 30;

// The provinces a caller is most likely to name. occurrence/search's stateProvince
// facet is asked for this many and the names are joined in rank order.
const PROVINCE_LIMIT = 8;

// One faceted occurrence/search answers the Thai record count for every taxon at
// once, which spares ~9k per-key calls to the endpoint GBIF throttles hardest.
// The facet is asked for more buckets than Thailand has distinct taxa (~121k), so
// no species is dropped; a key absent from the facet genuinely has no Thai record.
const COUNT_FACET_LIMIT = Number(process.env.DNP_PLANTS_COUNT_FACET_LIMIT ?? 200000);

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so there is no database to write to.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run enrich:dnp-plants',
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

/** One SQL integer, or NULL for a missing value. */
function sqlInt(value) {
  if (value === null || value === undefined) return 'NULL';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : 'NULL';
}

/** A GET that retries throttling/5xx with backoff, then gives up loudly. */
async function fetchJson(url, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'globie-earth/1.0 (enrich-dnp-plants)' },
      });
      if (response.status === 429 || response.status >= 500) {
        // Record why the attempt failed, or the final throw reports "undefined".
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (response.status === 204) return null; // no content is a real, empty answer
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(300 * 2 ** attempt);
    }
  }
  throw new Error(`GET ${url} failed after ${tries} tries: ${message(lastError)}`);
}

/**
 * A spacer: runs the wrapped fn, but starts each call at least `intervalMs` after
 * the previous one. Unlike a concurrency limiter it never lets two calls overlap,
 * which is what GBIF's occurrence/search throttling needs.
 */
function createSpacer(intervalMs) {
  let nextAt = 0;
  return async function run(fn) {
    const now = Date.now();
    const wait = nextAt - now;
    nextAt = Math.max(now, nextAt) + intervalMs;
    if (wait > 0) await sleep(wait);
    return fn();
  };
}

// -------------------------------------------------------------- the cache ----

const CACHE_FILE = fileURLToPath(new URL('./.cache/dnp-plants-enrich.json', import.meta.url));
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

// ------------------------------------------------------------- the enrich ----

/**
 * Whether GBIF records the species as native/introduced/cultivated in Thailand.
 *
 * Two of GBIF's distribution sources answer differently and both are read:
 *  - Some records are a single country ("Thailand") and carry establishmentMeans
 *    directly (WCVP). That is authoritative, so it is read first.
 *  - Others bundle all their countries into one locality string, tagging each
 *    with "[I]" introduced or "[c]" cultivated (Catalogue of Life):
 *    "...; Myanmar; Thailand; Cambodia; ...". A Thailand without a tag in such a
 *    string is native. A tagged Thailand is an explicit non-native record, so it
 *    is read before an untagged mention. An untagged Thailand anywhere is native.
 *
 * Returns null when no source mentions Thailand at all - a missing fact is stored
 * as missing, never invented.
 */
function thailandStatus(results) {
  for (const row of results) {
    const locality = String(row.locality ?? '').trim().toLowerCase();
    const country = String(row.country ?? '').trim().toLowerCase();
    const onlyThailand = locality === 'thailand' || country === 'thailand' || country === 'th';
    if (onlyThailand && row.establishmentMeans) return normalizeMeans(row.establishmentMeans);
  }

  for (const row of results) {
    const tagged = String(row.locality ?? '').match(/Thailand\s*\[([A-Za-z]+)\]/);
    if (tagged) {
      const tag = tagged[1].toLowerCase();
      if (tag.startsWith('i')) return 'introduced';
      if (tag.startsWith('c')) return 'cultivated';
      return tag;
    }
  }

  for (const row of results) {
    const locality = String(row.locality ?? '').trim();
    if (/(^|[;,\s(])Thailand\s*($|[;,)])/i.test(locality)) return 'native';
  }

  return null;
}

/** GBIF's establishmentMeans values, lowercased to one consistent vocabulary. */
function normalizeMeans(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'naturalized') return 'naturalised';
  return text;
}

/** The synonym names, distinct and comma-joined, capped so a row stays readable. */
function joinSynonyms(results) {
  const names = [];
  const seen = new Set();
  for (const row of results) {
    const name = String(row.canonicalName ?? row.scientificName ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= SYNONYM_LIMIT) break;
  }
  return names.length ? names.join(', ') : null;
}

/** The distribution records for a key, paging in case a species exceeds one page. */
async function fetchDistributions(key) {
  const results = [];
  for (let offset = 0; offset < 3000; offset += 1000) {
    const page = await fetchJson(`${GBIF_BASE}/species/${key}/distributions?limit=1000&offset=${offset}`);
    const batch = page?.results ?? [];
    results.push(...batch);
    if (page?.endOfRecords || batch.length === 0) break;
  }
  return results;
}

/**
 * The IUCN Red List category code for a key. The dedicated endpoint answers with
 * {code,...} for an assessed taxon and HTTP 204 when GBIF serves none (stored as
 * null, never guessed). The non-assessed codes NC/NE/DD are kept as they come:
 * "not yet assessed" is the honest answer, not a missing one.
 */
async function fetchIucnCategory(key) {
  const body = await fetchJson(`${GBIF_BASE}/species/${key}/iucnRedListCategory`);
  const code = body?.code ?? body?.category ?? null;
  const text = String(code ?? '').trim();
  return text || null;
}

/**
 * How many GBIF occurrence records each taxon has in Thailand, in ONE faceted
 * search: limit=0 asks for the facet and no records, and facetLimit is set above
 * the number of distinct Thai taxa so nothing is truncated. The map holds a count
 * for every taxon GBIF has a Thai record for; a key absent from it has none (0).
 */
async function fetchThailandCounts() {
  const body = await fetchJson(
    `${GBIF_BASE}/occurrence/search?country=TH&limit=0` +
      `&facet=taxonKey&facetLimit=${COUNT_FACET_LIMIT}`,
  );
  const facet = (body?.facets ?? []).find(
    (f) => String(f.field ?? '').toUpperCase() === 'TAXON_KEY',
  );
  const counts = new Map();
  for (const entry of facet?.counts ?? []) {
    const key = String(entry?.name ?? '').trim();
    const count = Number(entry?.count);
    if (key && Number.isFinite(count)) counts.set(key, count);
  }
  return counts;
}

/**
 * The provinces in Thailand where the species has been recorded, from the
 * stateProvince facet of a per-key search. This is the endpoint GBIF throttles
 * hardest, so it is called only for a species known to have Thai records and is
 * best-effort: a lookup lost to throttling is retried on the next run.
 */
async function fetchThailandProvinces(key) {
  const body = await fetchJson(
    `${GBIF_BASE}/occurrence/search?taxonKey=${key}&country=TH&limit=0` +
      `&facet=stateProvince&facetLimit=${PROVINCE_LIMIT}`,
  );
  const facet = (body?.facets ?? []).find(
    (f) => String(f.field ?? '').toUpperCase() === 'STATE_PROVINCE',
  );
  const provinces = (facet?.counts ?? [])
    .map((entry) => String(entry?.name ?? '').trim())
    .filter(Boolean)
    .slice(0, PROVINCE_LIMIT)
    .join(', ');
  return provinces || null;
}

/**
 * The GBIF Maps v2 occurrence-density tile URL for the species in Thailand, with
 * {z}/{x}/{y} left for a renderer to fill. Derived from the key alone - no call -
 * but stored so the exact Maps v2 contract (the required @2x suffix, the country
 * filter, the tile style) lives in one place rather than in every consumer.
 */
function mapTileTemplate(key) {
  return (
    `${GBIF_MAP_BASE}/map/occurrence/density/{z}/{x}/{y}@2x.png` +
    `?taxonKey=${key}&country=TH&style=classic.point`
  );
}

// occurrence/search is throttled harder than the rest, so it goes through its own
// spacer; the detail lookups (species, synonyms, distributions, IUCN) stay under
// the outer mapPool's CONCURRENCY.
const runOccurrenceLookup = createSpacer(OCCURRENCE_INTERVAL_MS);

/**
 * Resolves the detail facts for one GBIF key - genus, synonyms, native status,
 * IUCN category and the (free) Thai record count - memoized on disk per field
 * group. The provinces are fetched separately, after this pass, so the throttled
 * search endpoint never competes with the detail pool. Returns false when a
 * detail lookup could not be answered, so the row is left untouched.
 */
async function enrichDetail(key, thCounts) {
  const cacheKey = String(key);
  const cached = cache[cacheKey] ?? {};

  // The Thai record count is free - it comes from the one bulk facet, not a call -
  // so it is folded in every run, keeping a stale cached count fresh.
  const result = { ...cached, thRecordCount: thCounts.get(cacheKey) ?? 0 };

  // A taxon GBIF holds no Thai record for has no provinces to fetch: settle it as
  // null here so the province pass skips it.
  if (result.thRecordCount === 0) result.thProvinces = null;

  if (!('genus' in cached) || !('iucnStatus' in cached)) {
    try {
      // The base facts, unless a key cached by an earlier run already holds them.
      if (!('genus' in result)) {
        const species = await fetchJson(`${GBIF_BASE}/species/${key}`);
        const synonyms = await fetchJson(`${GBIF_BASE}/species/${key}/synonyms?limit=100`);
        const distributions = await fetchDistributions(key);
        result.genus = species?.genus ?? null;
        result.synonyms = joinSynonyms(synonyms?.results ?? []);
        result.nativeStatus = thailandStatus(distributions);
      }

      if (!('iucnStatus' in result)) {
        result.iucnStatus = await fetchIucnCategory(key);
      }
    } catch (error) {
      // A key GBIF cannot answer for is not fatal and, unlike a real answer, is not
      // cached: the row keeps its previous values and the key is retried next run.
      process.stdout.write(`  GBIF lookup failed for key ${key}: ${message(error)}\n`);
      return false;
    }
  }

  result.mapTileUrl = mapTileTemplate(key);
  cache[cacheKey] = result;
  cacheDirty += 1;
  if (cacheDirty >= 250) {
    saveCache();
    process.stdout.write(`  GBIF: ${Object.keys(cache).length} keys cached\n`);
  }
  return true;
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

// -------------------------------------------------------------- the write ----

/**
 * The multi-row UPDATE for one batch, joined to the table on gbif_key. A VALUES
 * list is used so every row is one statement; Postgres resolves the all-NULL
 * text columns to text, so no explicit cast is needed.
 */
function updateSql(entries) {
  const values = entries
    .map(
      (entry) =>
        `  (${entry.key}, ${sqlText(entry.genus)}, ${sqlText(entry.synonyms)}, ` +
        `${sqlText(entry.nativeStatus)}, ${sqlText(entry.iucnStatus)}, ` +
        `${sqlInt(entry.thRecordCount)}, ${sqlText(entry.thProvinces)}, ${sqlText(entry.mapTileUrl)})`,
    )
    .join(',\n');

  return `update api.dnp_plants as p set
  genus           = v.genus,
  synonyms        = v.synonyms,
  native_status   = v.native_status,
  iucn_status     = v.iucn_status,
  th_record_count = v.th_record_count,
  th_provinces    = v.th_provinces,
  map_tile_url    = v.map_tile_url
from (values
${values}
) as v(gbif_key, genus, synonyms, native_status, iucn_status, th_record_count, th_provinces, map_tile_url)
where p.gbif_key = v.gbif_key;`;
}

/** Writes the rows in batches and returns how many were written. Consumes `rows`. */
function flush(rows) {
  let written = 0;
  while (rows.length) {
    const batch = rows.splice(0, BATCH_SIZE);
    try {
      psql(['-v', 'ON_ERROR_STOP=1', '-q'], updateSql(batch));
    } catch (error) {
      console.error(`The update failed: ${message(error)}`);
      process.exit(1);
    }
    written += batch.length;
    process.stdout.write(`  ${written} row(s) written\n`);
  }
  return written;
}

/** The distinct GBIF keys already stored on the plant rows. */
function readKeys() {
  const out = psql([
    '-A',
    '-t',
    '-c',
    'select distinct gbif_key from api.dnp_plants where gbif_key is not null order by gbif_key;',
  ]).trim();
  return out ? out.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

try {
  const keys = readKeys();
  process.stdout.write(`  ${keys.length} distinct GBIF key(s) to enrich\n`);

  // One faceted search answers the Thai record count for every key, so the count
  // is guaranteed and no key is asked for it individually.
  process.stdout.write('  fetching the Thailand record counts (one faceted search) ...\n');
  const thCounts = await fetchThailandCounts();
  process.stdout.write(`  ${thCounts.size} taxon key(s) have Thai records\n`);

  // Pass 1: the detail facts and the free record count, at a small concurrency.
  const enriched = [];
  await mapPool(keys, CONCURRENCY, async (key, index) => {
    if (await enrichDetail(key, thCounts)) enriched.push(key);
    if ((index + 1) % 1000 === 0) {
      process.stdout.write(`  GBIF: ${index + 1}/${keys.length} detail lookups done\n`);
    }
  });
  saveCache();

  // Write pass 1 now, so the IUCN category, the Thai record count and the tile URL
  // are stored even if the slower province pass below is stopped part-way.
  const detailRows = enriched.map((key) => ({ key, ...cache[key] }));
  const detailWritten = flush(detailRows);

  // Pass 2: the provinces, ONE at a time and spaced, and only after the detail
  // pool has drained - GBIF throttles occurrence/search hard when detail calls run
  // alongside it. Most-recorded species first, so a stopped run has covered the
  // ones a listener is most likely to ask about; the rest are retried next run.
  const pending = enriched
    .filter((key) => cache[key].thRecordCount > 0 && !('thProvinces' in cache[key]))
    .sort((a, b) => cache[b].thRecordCount - cache[a].thRecordCount);
  process.stdout.write(`  ${pending.length} key(s) need a province lookup\n`);

  const provinceKeys = [];
  for (const key of pending) {
    try {
      cache[key].thProvinces = await runOccurrenceLookup(() => fetchThailandProvinces(key));
      provinceKeys.push(key);
      cacheDirty += 1;
      if (cacheDirty >= 50) {
        saveCache();
        process.stdout.write(`  provinces: ${provinceKeys.length}/${pending.length} looked up\n`);
      }
    } catch (error) {
      process.stdout.write(`  province lookup failed for key ${key}: ${message(error)}\n`);
    }
  }
  saveCache();

  const provinceRows = provinceKeys.map((key) => ({ key, ...cache[key] }));
  const provinceWritten = flush(provinceRows);

  // Counters, over the keys written, read back from the cache.
  const resolved = enriched.length;
  const withGenus = enriched.filter((key) => cache[key].genus).length;
  const withSynonyms = enriched.filter((key) => cache[key].synonyms).length;
  const withNative = enriched.filter((key) => cache[key].nativeStatus).length;
  const withIucn = enriched.filter((key) => cache[key].iucnStatus).length;
  const withOccurrence = enriched.filter((key) => cache[key].thRecordCount > 0).length;
  const withProvinces = provinceKeys.filter((key) => cache[key].thProvinces).length;

  const stored = psql(['-A', '-t', '-c', 'select count(*) from api.dnp_plants;']).trim();
  const genused = psql(['-A', '-t', '-c', 'select count(*) from api.dnp_plants where genus is not null;']).trim();
  const synonymised = psql(['-A', '-t', '-c', 'select count(*) from api.dnp_plants where synonyms is not null;']).trim();
  const natived = psql(['-A', '-t', '-c', 'select count(*) from api.dnp_plants where native_status is not null;']).trim();
  const coded = psql(['-A', '-t', '-c', 'select count(*) from api.dnp_plants where iucn_status is not null;']).trim();
  const counted = psql(['-A', '-t', '-c', 'select count(*) from api.dnp_plants where th_record_count is not null;']).trim();
  const placed = psql(['-A', '-t', '-c', 'select count(*) from api.dnp_plants where th_provinces is not null;']).trim();

  console.log('');
  console.log(`  keys resolved    ${resolved} of ${keys.length}`);
  console.log(`  rows written     ${detailWritten + provinceWritten} (${detailWritten} detail, ${provinceWritten} province)`);
  console.log(`  genus            ${withGenus} of ${resolved} resolved (${genused}/${stored} rows stored)`);
  console.log(`  synonyms         ${withSynonyms} of ${resolved} resolved (${synonymised}/${stored} rows stored)`);
  console.log(`  native_status    ${withNative} of ${resolved} resolved (${natived}/${stored} rows stored)`);
  console.log(`  iucn_status      ${withIucn} of ${resolved} resolved (${coded}/${stored} rows stored)`);
  console.log(`  th_record_count  ${withOccurrence} of ${resolved} resolved (${counted}/${stored} rows stored)`);
  console.log(`  th_provinces     ${withProvinces} of ${pending.length} looked up (${placed}/${stored} rows stored)`);
  console.log('');
  console.log('Done. Run `npm run backfill:embeddings -- dnp_plant` to fold these into search.');
} catch (error) {
  saveCache();
  console.error(`The enrichment failed: ${message(error)}`);
  process.exit(1);
}
