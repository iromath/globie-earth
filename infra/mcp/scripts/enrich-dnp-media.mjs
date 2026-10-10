// Gives every DNP plant, wildlife and fauna row a photograph.
//
// 200_dnp_media.sql added photo_url/photo_source/photo_license/photo_credit/
// photo_ref to the three DNP layers (and a gbif_key to the two animal ones).
// This fills them, so a reader can see what a species looks like - not just read
// its name, family and IUCN status:
//
//   photo_url      the image. GBIF's first StillImage for the taxon is taken
//                  under a licence that permits reuse (see below), preferring
//                  the iNaturalist open-data dataset (live observation
//                  photographs rather than herbarium sheets):
//                    occurrence/search?taxonKey=<key>&mediaType=StillImage
//                      &datasetKey=50c9509d-22c7-4a22-a47d-8c48425ef4a7
//                      &license=CC0_1_0&license=CC_BY_4_0
//                  and falling back to any GBIF publisher when iNaturalist has
//                  none. When GBIF holds no freely reusable image at all, the
//                  taxon's Wikimedia Commons photograph is used instead, found
//                  through Wikidata (P846 GBIF taxon ID -> P18 image -> that
//                  file's imageinfo, licence-checked the same way). An
//                  iNaturalist open-data original is rewritten to its `large`
//                  (1024px) variant and a Commons original to a 1024px
//                  thumbnail, so a card does not pull a full-resolution
//                  original; another publisher's URL is kept exactly as served.
//   photo_source   the publisher, e.g. "iNaturalist", "Wikimedia Commons", or
//                  "GBIF" when GBIF names no publisher.
//   photo_license  the licence as a short code, e.g. "CC BY 4.0" or "CC0 1.0".
//   photo_credit   the photographer / rights holder, for attribution.
//   photo_ref      the human-readable source page (GBIF media.references).
//
// Only a freely reusable image is stored: public domain / CC0, or a Creative
// Commons licence that is neither NonCommercial nor NoDerivatives. That is the
// same rule infra/mcp/src/wiki.ts applies to a Wikipedia image (freeLicense),
// so the Field Guide never shows a photo whose licence forbids reuse. Both the
// occurrence/search query (GBIF's own licence facet) and pickMedia (each media
// entry's licence) enforce it, because a photograph can be licensed differently
// from the observation it is attached to. This is why the iNaturalist dataset -
// mostly CC BY-NC by default - contributes only the photos its observers chose
// to relicense, and why the Wikimedia Commons fallback checks each file's own
// extmetadata rather than trusting the taxon.
//
// The plants already carry the GBIF usageKey they were matched to as gbif_key
// (130_dnp_plants.sql), so their photo is fetched by that key with no matching
// to redo. The animals have no key, so each distinct scientific_name is first
// resolved once via species/match (EXACT, confidence 99 for the sampled Thai
// names) and stored as gbif_key, then the photo is fetched by that key. Names
// shared by the wildlife checklist and the fauna observations are matched once.
//
//   npm run build
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run enrich:dnp-media
//
// To write only what the cache already holds - no GBIF call at all - add
// DNP_MEDIA_FLUSH_ONLY=1. That is the quick way to land photos an earlier run
// collected without waiting on the keys it has not looked up yet.
//
// Both passes are cheap to re-run. Responses are cached under
// scripts/.cache/dnp-media-enrich.json, keyed by name (the match) and by GBIF
// key (the photo), so a re-run skips every taxon already looked up and only
// asks about new ones. A cached null means a settled "GBIF holds none" - unlike
// a lookup that failed, which is not cached and is retried next run, so a
// transient outage never clears a good photo. Delete that file to refetch
// everything. The write re-runs over every settled taxon, not just the ones
// fetched this run, so the rows are refreshed in place either way.
//
// occurrence/search is GBIF's rate-sensitive endpoint, so the photo pass is
// serialized and spaced, one request starting every DNP_MEDIA_INTERVAL_MS
// (default 400ms; raise it if a run reports 429s - a lookup still throttled
// after the retries is left for the next run). The Wikidata and Commons calls
// of the fallback are spaced the same way, under DNP_MEDIA_WIKIMEDIA_INTERVAL_MS
// (default 350ms). The species/match pass is not that endpoint and runs under a
// small pool.
//
// Why a direct connection instead of PostgREST: 130/140/150 revoke
// insert/update/delete from anon, so only the migration role may write, exactly
// as enrich-dnp-plants.mjs does.
//
// Idempotent: plants are updated in place on gbif_key, the animals on
// scientific_name (carrying their resolved gbif_key), so a re-run refreshes the
// media columns without duplicating or clearing rows.
//
// Exit 0: every taxon was resolved (or had no image) and written.
// Exit 1: a GBIF lookup or update failed fatally.
// Exit 3: DATABASE_URL is not set.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GBIF_BASE = (process.env.GBIF_BASE ?? 'https://api.gbif.org/v1').replace(/\/+$/, '');

// The iNaturalist open-data dataset on GBIF: live observations, openly licensed,
// which is a far better illustration of a species than a pressed herbarium sheet.
// Photos are taken from it first and from any publisher only as a fallback.
const INAT_DATASET = '50c9509d-22c7-4a22-a47d-8c48425ef4a7';

// The licences that permit reuse: public domain / CC0 and CC BY. GBIF's
// occurrence/search `license` facet carries exactly these three values
// (CC0_1_0, CC_BY_4_0, CC_BY_NC_4_0), so asking for the first two filters out
// every NonCommercial record before it reaches us. The iNaturalist dataset is
// mostly CC BY-NC, so this is what keeps its photos out unless an observer
// relicensed them.
const FREE_LICENSE_QUERY = 'license=CC0_1_0&license=CC_BY_4_0';

// Wikimedia Commons, reached through Wikidata: a taxon item is found by its
// GBIF taxon ID (P846) and its image statement (P18) names a Commons file. A
// Commons photograph is licensed per file, so the file's own imageinfo is read
// and checked with the same rule as a GBIF image before it is stored. Both
// endpoints are keyless.
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

// The Commons source image is bounded to this width, so a card never pulls an
// original multi-megabyte upload.
const COMMONS_THUMB_PX = 1024;

// Wikidata and Commons have their own rate limits and ask for serial requests,
// so a Commons lookup - two Wikidata calls then one Commons call - is spaced the
// same way occurrence/search is, under its own interval.
const WIKIMEDIA_INTERVAL_MS = Number(process.env.DNP_MEDIA_WIKIMEDIA_INTERVAL_MS ?? 350);

// The cache schema: which sources a cached entry has already been checked
// against. A null cached before `wikimedia` was added means only "GBIF holds
// none", so it is re-checked once to give Commons a chance.
const CACHE_SOURCES = ['gbif', 'wikimedia'];

// species/match is not the throttled endpoint, so the name pass runs in a small
// pool like enrich-dnp-plants.mjs's detail pass.
const CONCURRENCY = Number(process.env.DNP_MEDIA_CONCURRENCY ?? 4);

// occurrence/search answers HTTP 429 under rapid use, so the photo pass is
// serialized and spaced: one request starts every DNP_MEDIA_INTERVAL_MS. A
// lookup still throttled after fetchJson's retries is left for the next run.
const OCCURRENCE_INTERVAL_MS = Number(process.env.DNP_MEDIA_INTERVAL_MS ?? 400);

// Keys per UPDATE. Few round-trips, no giant statement.
const BATCH_SIZE = 500;

// Writing what the cache already holds needs no GBIF call at all. Setting
// DNP_MEDIA_FLUSH_ONLY=1 skips both lookup passes and runs only the final
// write - the fast way to land photos an earlier run already collected,
// without waiting on the pending keys it has not looked up yet.
const FLUSH_ONLY = ['1', 'true', 'yes'].includes(
  String(process.env.DNP_MEDIA_FLUSH_ONLY ?? '').trim().toLowerCase(),
);

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so there is no database to write to.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run enrich:dnp-media',
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

// When GBIF answers 429 it is penalizing the whole client, not this one call, so
// every in-flight and queued request is sick. A per-call backoff cannot ride
// that out - the other workers keep hammering and re-arm the penalty. So a 429
// (or a 5xx) sets one shared wall-clock gate: no request starts before it, and a
// longer penalty pushes it further out. This is what lets a run pause for the
// ~90s window and then carry on by itself instead of burning its retries.
let notBefore = 0;

/** Waits out any active GBIF cooldown gate before a request is allowed to start. */
async function awaitGate() {
  const wait = notBefore - Date.now();
  if (wait > 0) await sleep(wait);
}

/** A GET that retries throttling/5xx with backoff, then gives up loudly. */
async function fetchJson(url, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await awaitGate();
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'globie-earth/1.0 (enrich-dnp-media)' },
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        // Hold everyone off, not just this attempt. 429 gets the long gate
        // (GBIF's penalty window); a 5xx just needs the next slot to slip.
        const backoff = response.status === 429 ? 30_000 * (attempt + 1) : 500 * 2 ** attempt;
        notBefore = Math.max(notBefore, Date.now() + backoff);
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
 * A spacer: runs the wrapped fn, but starts each call at least `intervalMs`
 * after the previous one. Unlike a concurrency limiter it never lets two calls
 * overlap, which is what GBIF's occurrence/search throttling needs.
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

const CACHE_FILE = fileURLToPath(new URL('./.cache/dnp-media-enrich.json', import.meta.url));
let cache = {};
let hadCommons = false;
try {
  const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  cache = { match: parsed.match ?? {}, media: parsed.media ?? {} };
  hadCommons = Array.isArray(parsed.sources) && parsed.sources.includes('wikimedia');
} catch {
  cache = { match: {}, media: {} };
}
let cacheDirty = 0;

// Drop any cached photo whose licence does not permit reuse. An earlier run
// stored whatever GBIF returned first, and those keys must be looked up again
// under the allow-list rather than rewritten from a stale copy. A cached null
// (a settled "no photo") carries no licence and is kept as it is.
for (const key of Object.keys(cache.media)) {
  const photo = cache.media[key];
  if (photo && !mediaIsFree(photo.license)) {
    delete cache.media[key];
    cacheDirty += 1;
  }
}
// A null cached before the Wikimedia Commons fallback existed means only "GBIF
// holds none", so it is dropped once to let Commons be tried; from then on a
// null settles both sources and is kept.
if (!hadCommons) {
  for (const key of Object.keys(cache.media)) {
    if (cache.media[key] === null) {
      delete cache.media[key];
      cacheDirty += 1;
    }
  }
}
cache.sources = CACHE_SOURCES;
if (!hadCommons) cacheDirty += 1;
saveCache();

function saveCache() {
  if (!cacheDirty) return;
  mkdirSync(fileURLToPath(new URL('./.cache/', import.meta.url)), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache));
  cacheDirty = 0;
}

// --------------------------------------------------------------- the photo ----

/**
 * iNaturalist's open-data images are served from Amazon S3 in named variants
 * (square/small/medium/large/original). The one GBIF points at is `original` -
 * a multi-megabyte upload - so it is rewritten to `large` (1024px) for display.
 * Any other host (a herbarium, a museum, another aggregator) is left untouched:
 * its URL scheme is not ours to guess.
 */
function photoUrl(identifier) {
  const match = identifier.match(
    /^(https:\/\/inaturalist-open-data\.s3[^/]*\.amazonaws\.com\/photos\/\d+\/)original(\.[a-z]+)$/i,
  );
  return match ? `${match[1]}large${match[2]}` : identifier;
}

/**
 * A Creative Commons licence URL as the short code a caption shows
 * ("CC BY-NC 4.0", "CC0 1.0"). An unrecognised value (some publishers put a
 * plain string there) is kept verbatim rather than dropped.
 */
function licenseCode(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const zero = text.match(/creativecommons\.org\/publicdomain\/zero\/([\d.]+)/i);
  if (zero) return `CC0 ${zero[1]}`;
  const mark = text.match(/creativecommons\.org\/publicdomain\/mark\/([\d.]+)/i);
  if (mark) return `CC PDM ${mark[1]}`;
  const by = text.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i);
  if (by) return `CC ${by[1].toUpperCase()} ${by[2]}`;
  return text;
}

/**
 * Whether a licence permits reuse here: public domain / CC0, or a Creative
 * Commons licence that is neither NonCommercial nor NoDerivatives - the same
 * rule the MCP server applies to a Wikipedia image (freeLicense in
 * infra/mcp/src/wiki.ts). It accepts a licence URL (as GBIF serves it) and the
 * short code licenseCode stores, so it can judge a fresh response and a cached
 * value alike.
 */
function mediaIsFree(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return false;
  // NC and ND forbid the reuse we need. Their names contain the "by" stem the
  // allow-list below matches on, so they are refused first.
  if (/by-nc|by-nd|noncommercial|non-commercial|no derivativ/.test(text)) return false;
  if (/\bcc0\b|\bcc-?pdm\b|\bpdm\b|public[\s-]?domain|\bpd-/.test(text)) return true;
  if (/creativecommons\.org\/licenses\/by(-sa)?\/|\bcc[ -]by(-sa)?\b/.test(text)) return true;
  return false;
}

/** The first StillImage GBIF holds under a reusable licence, or null. */
function pickMedia(body) {
  for (const occurrence of body?.results ?? []) {
    for (const media of occurrence?.media ?? []) {
      if (String(media?.type ?? '').toLowerCase() !== 'stillimage' || !media?.identifier) {
        continue;
      }
      if (!mediaIsFree(media.license)) continue;
      return media;
    }
  }
  return null;
}

/** The stored photo for one GBIF media entry, or null when it is not usable. */
function toPhoto(media) {
  if (!media?.identifier) return null;
  return {
    url: photoUrl(String(media.identifier)),
    source: String(media.publisher ?? '').trim() || 'GBIF',
    license: licenseCode(media.license),
    credit: String(media.rightsHolder ?? media.creator ?? '').trim() || null,
    ref: String(media.references ?? '').trim() || null,
  };
}

// occurrence/search is throttled harder than the rest, so every call to it -
// the iNaturalist-preferred lookup and its fallback - goes through one spacer.
const runOccurrence = createSpacer(OCCURRENCE_INTERVAL_MS);

/** One spaced occurrence/search request. */
function searchOccurrences(query) {
  return runOccurrence(() => fetchJson(`${GBIF_BASE}/occurrence/search?${query}`));
}

// Wikidata and Commons calls go through their own spacer, so a Commons lookup
// never bursts more than one request at a time at either host.
const runWikimedia = createSpacer(WIKIMEDIA_INTERVAL_MS);

/**
 * The photo for one GBIF key: the iNaturalist dataset first, then any GBIF
 * publisher, but only under a reusable licence in both. When GBIF holds no
 * freely reusable StillImage at all, Wikimedia Commons is tried through
 * Wikidata. The page is widened past the strict minimum so a first result that
 * fails the licence check does not hide a usable image further down. Returns
 * null when neither source has a freely reusable image - a settled answer that
 * is cached so the key is not asked about again.
 */
async function fetchPhoto(key) {
  const preferred = await searchOccurrences(
    `taxonKey=${key}&mediaType=StillImage&datasetKey=${INAT_DATASET}&${FREE_LICENSE_QUERY}&limit=20`,
  );
  const chosen = pickMedia(preferred);
  if (chosen) return toPhoto(chosen);

  const fallback = await searchOccurrences(
    `taxonKey=${key}&mediaType=StillImage&${FREE_LICENSE_QUERY}&limit=20`,
  );
  const anyPublisher = toPhoto(pickMedia(fallback));
  if (anyPublisher) return anyPublisher;

  return fetchCommonsPhoto(key);
}

/**
 * A Wikimedia extmetadata value as plain text: HTML tags stripped, the handful
 * of entities a licence/credit field actually uses decoded.
 */
function plainText(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The Commons file a taxon item points at, via Wikidata: P846 (GBIF taxon ID)
 * finds the item, P18 (image) names a Commons file. Returns the file name
 * without the "File:" prefix, or null when Wikidata has no such item or image.
 */
async function fetchWikidataImageName(key) {
  const search = await runWikimedia(() =>
    fetchJson(
      `${WIKIDATA_API}?action=query&format=json&list=search&srlimit=5&srsearch=${encodeURIComponent(
        `haswbstatement:P846=${key}`,
      )}`,
    ),
  );
  const ids = (search?.query?.search ?? []).map((hit) => hit?.title).filter(Boolean);
  if (!ids.length) return null;

  const entities = await runWikimedia(() =>
    fetchJson(
      `${WIKIDATA_API}?action=wbgetentities&format=json&props=claims&ids=${encodeURIComponent(
        ids.join('|'),
      )}`,
    ),
  );
  for (const id of ids) {
    for (const claim of entities?.entities?.[id]?.claims?.P18 ?? []) {
      const name = claim?.mainsnak?.datavalue?.value;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  }
  return null;
}

/**
 * One Commons file's imageinfo: its licensed URL and extmetadata. A 1024px
 * thumbnail is requested (iiurlwidth) so the stored url is never the original.
 */
async function fetchCommonsImage(fileName) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: String(COMMONS_THUMB_PX),
    titles: `File:${fileName}`,
  });
  const data = await runWikimedia(() => fetchJson(`${COMMONS_API}?${params.toString()}`));
  const pages = data?.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  return page?.imageinfo?.[0] ?? null;
}

/**
 * The stored photo for one Commons file, or null when its licence is not
 * provably free. The licence is read from the file's extmetadata three ways
 * (short name, usage terms, deed URL) and checked with the same rule as a GBIF
 * image, so a non-free "fair use" file or an unreadable one is refused.
 */
function toCommonsPhoto(info) {
  const meta = info?.extmetadata ?? {};
  const shortName = plainText(meta.LicenseShortName?.value);
  const usageTerms = plainText(meta.UsageTerms?.value);
  const licenseUrl = String(meta.LicenseUrl?.value ?? '').trim();
  if (!mediaIsFree(`${shortName} ${usageTerms} ${licenseUrl}`)) return null;

  const url = String(info?.thumburl ?? info?.url ?? '').trim();
  if (!url) return null;

  return {
    url,
    source: 'Wikimedia Commons',
    license: shortName || licenseCode(licenseUrl) || 'Wikimedia Commons',
    credit: plainText(meta.Artist?.value ?? meta.Credit?.value) || null,
    ref: String(info?.descriptionurl ?? '').trim() || null,
  };
}

/** The Commons photo for one GBIF key, or null when it has none free. */
async function fetchCommonsPhoto(key) {
  const fileName = await fetchWikidataImageName(key);
  if (!fileName) return null;
  return toCommonsPhoto(await fetchCommonsImage(fileName));
}

/**
 * The GBIF usageKey for one scientific name, from species/match. Only an EXACT
 * or FUZZY match is accepted: a HIGHERRANK answer (a genus or family) would put
 * a photo of some other species on the row. Returns null when GBIF cannot place
 * the name; that is cached, because it is a real answer, not a failure.
 */
async function fetchMatch(name) {
  const body = await fetchJson(`${GBIF_BASE}/species/match?name=${encodeURIComponent(name)}`);
  const key = body?.usageKey;
  const matchType = String(body?.matchType ?? '').toUpperCase();
  if (!key || (matchType !== 'EXACT' && matchType !== 'FUZZY')) return null;
  return { key: Number(key) };
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

/** The multi-row UPDATE that fills the plant media columns, joined on gbif_key. */
function updatePlantsSql(entries) {
  const values = entries
    .map(
      (entry) =>
        `  (${sqlInt(entry.key)}, ${sqlText(entry.url)}, ${sqlText(entry.source)}, ` +
        `${sqlText(entry.license)}, ${sqlText(entry.credit)}, ${sqlText(entry.ref)})`,
    )
    .join(',\n');

  return `update api.dnp_plants as p set
  photo_url     = v.photo_url,
  photo_source  = v.photo_source,
  photo_license = v.photo_license,
  photo_credit  = v.photo_credit,
  photo_ref     = v.photo_ref
from (values
${values}
) as v(gbif_key, photo_url, photo_source, photo_license, photo_credit, photo_ref)
where p.gbif_key = v.gbif_key;`;
}

/**
 * The multi-row UPDATE for one animal table, joined on scientific_name and
 * carrying the resolved gbif_key. VALUES entries are keyed by the distinct name,
 * so no target row is assigned twice.
 */
function updateAnimalSql(table, entries) {
  const values = entries
    .map(
      (entry) =>
        `  (${sqlText(entry.name)}, ${sqlInt(entry.key)}, ${sqlText(entry.url)}, ` +
        `${sqlText(entry.source)}, ${sqlText(entry.license)}, ${sqlText(entry.credit)}, ` +
        `${sqlText(entry.ref)})`,
    )
    .join(',\n');

  return `update api.${table} as t set
  gbif_key      = v.gbif_key,
  photo_url     = v.photo_url,
  photo_source  = v.photo_source,
  photo_license = v.photo_license,
  photo_credit  = v.photo_credit,
  photo_ref     = v.photo_ref
from (values
${values}
) as v(scientific_name, gbif_key, photo_url, photo_source, photo_license, photo_credit, photo_ref)
where t.scientific_name = v.scientific_name;`;
}

/** Writes the rows in batches with the given builder. Consumes `rows`. */
function flush(rows, buildSql) {
  let written = 0;
  while (rows.length) {
    const batch = rows.splice(0, BATCH_SIZE);
    try {
      psql(['-v', 'ON_ERROR_STOP=1', '-q'], buildSql(batch));
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
function readPlantKeys() {
  const out = psql([
    '-A',
    '-t',
    '-c',
    'select distinct gbif_key from api.dnp_plants where gbif_key is not null order by gbif_key;',
  ]).trim();
  return out ? out.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

/** The distinct scientific names on one animal table. */
function readNames(table) {
  const out = psql([
    '-A',
    '-t',
    '-c',
    `select distinct scientific_name from api.${table} where scientific_name is not null;`,
  ]).trim();
  return out ? out.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

/** The media columns for a cached photo, or all-null fields when there is none. */
function photoFields(key) {
  const photo = cache.media[String(key)] ?? null;
  return {
    url: photo?.url ?? null,
    source: photo?.source ?? null,
    license: photo?.license ?? null,
    credit: photo?.credit ?? null,
    ref: photo?.ref ?? null,
  };
}

try {
  const plantKeys = readPlantKeys();
  const wildlifeNames = readNames('dnp_wildlife');
  const faunaNames = readNames('dnp_fauna');
  const animalNames = [...new Set([...wildlifeNames, ...faunaNames])];
  process.stdout.write(
    `  ${plantKeys.length} plant key(s), ${wildlifeNames.length} wildlife and ` +
      `${faunaNames.length} fauna name(s) (${animalNames.length} distinct animal name(s))\n`,
  );

  // Pass 1: resolve a GBIF key for every animal name not already matched. The
  // plants already carry theirs, so they are not touched here.
  if (FLUSH_ONLY) {
    process.stdout.write('  DNP_MEDIA_FLUSH_ONLY=1 - skipping all GBIF lookups\n');
  } else {
    const unmatched = animalNames.filter((name) => !(name in cache.match));
    process.stdout.write(`  resolving ${unmatched.length} unmatched animal name(s) ...\n`);
    await mapPool(unmatched, CONCURRENCY, async (name) => {
      try {
        cache.match[name] = await fetchMatch(name);
        cacheDirty += 1;
      } catch (error) {
        // Not cached: a failed lookup is retried next run, unlike a real "no match".
        process.stdout.write(`  GBIF match failed for "${name}": ${message(error)}\n`);
      }
    });
    saveCache();
  }

  // Every key that needs a photo: the plants' own keys plus the keys the animal
  // names resolved to. Deduplicated, so a name shared by both animal tables and
  // a plant sharing a key are each fetched once.
  const needed = new Set(plantKeys.map(String));
  for (const name of animalNames) {
    const match = cache.match[name];
    if (match?.key) needed.add(String(match.key));
  }

  // Pass 2: the photo, one key at a time and spaced - occurrence/search is
  // throttled hard and a burst of parallel calls trips HTTP 429.
  if (!FLUSH_ONLY) {
    const pending = [...needed].filter((key) => !(key in cache.media));
    process.stdout.write(`  ${pending.length} key(s) need a photo lookup\n`);
    let lookedUp = 0;
    for (const key of pending) {
      try {
        cache.media[key] = await fetchPhoto(key);
        lookedUp += 1;
        cacheDirty += 1;
        if (cacheDirty >= 50) {
          saveCache();
          process.stdout.write(`  photos: ${lookedUp}/${pending.length} looked up\n`);
        }
      } catch (error) {
        process.stdout.write(`  photo lookup failed for key ${key}: ${message(error)}\n`);
      }
    }
    saveCache();
  }

  // Write every settled key - freshly fetched or cached by an earlier run - so a
  // re-run refreshes the rows in place without re-hitting GBIF.
  const plantEntries = plantKeys
    .filter((key) => String(key) in cache.media)
    .map((key) => ({ key, ...photoFields(key) }));
  const plantWritten = flush(plantEntries, updatePlantsSql);

  const wildlifeEntries = wildlifeNames
    .filter((name) => cache.match[name]?.key && String(cache.match[name].key) in cache.media)
    .map((name) => ({ name, key: cache.match[name].key, ...photoFields(cache.match[name].key) }));
  const wildlifeWritten = flush(wildlifeEntries, (rows) => updateAnimalSql('dnp_wildlife', rows));

  const faunaEntries = faunaNames
    .filter((name) => cache.match[name]?.key && String(cache.match[name].key) in cache.media)
    .map((name) => ({ name, key: cache.match[name].key, ...photoFields(cache.match[name].key) }));
  const faunaWritten = flush(faunaEntries, (rows) => updateAnimalSql('dnp_fauna', rows));

  // Counters, read back from the tables so they reflect what is actually stored.
  const count = (sql) => psql(['-A', '-t', '-c', sql]).trim();
  const plantRows = count('select count(*) from api.dnp_plants;');
  const plantWith = count('select count(*) from api.dnp_plants where photo_url is not null;');
  const wildlifeRows = count('select count(*) from api.dnp_wildlife;');
  const wildlifeWith = count('select count(*) from api.dnp_wildlife where photo_url is not null;');
  const faunaRows = count('select count(*) from api.dnp_fauna;');
  const faunaWith = count('select count(*) from api.dnp_fauna where photo_url is not null;');
  const matchedNames = animalNames.filter((name) => cache.match[name]?.key).length;

  console.log('');
  console.log(`  keys with a photo ${[...needed].filter((key) => cache.media[key]).length} of ${needed.size} looked up`);
  console.log(`  animal names matched ${matchedNames} of ${animalNames.length}`);
  console.log(`  rows written      ${plantWritten + wildlifeWritten + faunaWritten} (${plantWritten} plant, ${wildlifeWritten} wildlife, ${faunaWritten} fauna)`);
  console.log(`  plants            ${plantWith}/${plantRows} rows have a photo`);
  console.log(`  wildlife          ${wildlifeWith}/${wildlifeRows} rows have a photo`);
  console.log(`  fauna             ${faunaWith}/${faunaRows} rows have a photo`);
  console.log('');
  console.log('Done. Usage is per the image licence on each row; attribute photo_credit.');
} catch (error) {
  saveCache();
  console.error(`The enrichment failed: ${message(error)}`);
  process.exit(1);
}
