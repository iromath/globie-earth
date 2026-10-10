// Imports the DNP national wildlife checklist into api.dnp_wildlife.
//
// The upstream is the CKAN package "wildlife" (https://catalog.dnp.go.th,
// package b0bfe867-6ef1-4d00-982d-fbc902ae9283, Forest and Plant Conservation
// Research Office, "Open Data Common" licence). It is a national checklist of
// Thai wildlife split into four class PDFs - birds, mammals, reptiles,
// amphibians - with each species' Thai/scientific/English name, its conservation
// status (ONEP 2548/2560/2565, IUCN 2022, CITES) and, for birds, its seasonal
// status. None of the resources is datastore_active, so the four PDFs are
// downloaded and parsed from their rendered table grid.
//
// Two statutory lists are merged in by scientific name, because a species'
// legal standing is a decision the checklist does not carry:
//   * บัญชีสัตว์ป่าคุ้มครอง (protected wildlife), package dnp09_data21_02,
//     datastore_active, read through the CKAN DataStore API;
//   * บัญชีสัตว์ป่าสงวน (reserved wildlife), package dnp09_data21_01, a CSV.
// A species named only on a statutory list (e.g. the whale shark) still gets a
// row; its class is unknown, so it is recorded as group_type 'other' rather than
// guessed.
//
//   npm run build
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run import:dnp-wildlife
//
// Set DNP_WILDLIFE_PDFS=<dir> to parse local PDFs instead of downloading them,
// and DNP_WILDLIFE_PACKAGE / DNP_WILDLIFE_DATASET to point at other packages.
//
// Why a direct connection instead of PostgREST: the dnp_wildlife table revokes
// insert/update/delete from anon, so only the migration role may write, exactly
// as backfill-embeddings.mjs does for api.embeddings.
//
// Idempotent: the upsert is keyed on scientific_name, the species' stable
// identity, so a re-run refreshes rows instead of duplicating them.
//
// Exit 0: every checklist row and statutory species was read and upserted.
// Exit 1: a download, parse, or upsert failed.
// Exit 3: DATABASE_URL is not set.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CKAN_BASE = (process.env.DNP_CKAN_BASE ?? 'https://catalog.dnp.go.th').replace(/\/+$/, '');

// The national-checklist package. Its uuid (not its slug) is what the download
// URLs are built from.
const WILDLIFE_PACKAGE = process.env.DNP_WILDLIFE_PACKAGE ?? 'wildlife';
const WILDLIFE_DATASET =
  process.env.DNP_WILDLIFE_DATASET ?? 'b0bfe867-6ef1-4d00-982d-fbc902ae9283';

// The two statutory lists.
const PROTECTED_PACKAGE = process.env.DNP_WILDLIFE_PROTECTED_PACKAGE ?? 'dnp09_data21_02';
const PROTECTED_RESOURCE =
  process.env.DNP_WILDLIFE_PROTECTED_RESOURCE ?? '75545279-52ae-4894-9d6c-cf6fc4d756a4';
const RESERVED_PACKAGE = process.env.DNP_WILDLIFE_RESERVED_PACKAGE ?? 'dnp09_data21_01';
const RESERVED_RESOURCE =
  process.env.DNP_WILDLIFE_RESERVED_RESOURCE ?? '19ed5635-d95c-45b8-867a-42232d3a75fb';
const RESERVED_CSV_URL =
  process.env.DNP_WILDLIFE_RESERVED_CSV ??
  `${CKAN_BASE}/dataset/4bbe2d1a-592f-4f46-99cc-21b47ae9c962/resource/${RESERVED_RESOURCE}/download/untitled.csv`;

// The four class PDFs, by resource id. Override the directory to parse local
// copies instead of downloading.
const PDF_RESOURCES = [
  { rid: '7872e08b-c6a3-4faa-a2ed-56c0b2aec232', file: 'birds.pdf', class: 'birds' },
  { rid: '0de81bc9-eccf-4113-afea-2aabce4163a1', file: 'mammals.pdf', class: 'mammals' },
  { rid: 'eacf433e-95ac-4433-a02d-bbfc133da2a5', file: 'reptiles.pdf', class: 'reptiles' },
  { rid: '8ecd2bab-2d9c-4112-a0bb-c5afffca2a58', file: 'amphibians.pdf', class: 'amphibians' },
];

const PDFS_DIR = process.env.DNP_WILDLIFE_PDFS ?? '';
const PDF_CACHE = fileURLToPath(new URL('./.cache/dnp-wildlife/', import.meta.url));

// The rendered table grid of each PDF, in PDF points. Columns were located once
// from the header labels and the per-column x histogram of every data page, then
// validated against known rows (Asian Elephant = ค/EN/EN/I, Dugong = ส/CR/VU/I,
// Indotestudo elongata = ค/EN/NT/NT/CR/II). Name fields are cut at the midpoints
// between their neighbouring columns; status fields are assigned to the nearest
// column centre. The 2548 column is genuinely sparse on the mammal sheet (36 of
// its rows carry a value), which is why its centre is kept even though it looks
// empty.
const PDF_LAYOUT = {
  mammals: {
    seasonal: false,
    seqMax: 62, thaiMax: 198, sciMax: 336, engMax: 508,
    cols: [
      ['legal_status', 529], ['onep_2548', 566], ['onep_2560', 599],
      ['onep_2565', 631], ['iucn_status', 662], ['cites_status', 698],
    ],
  },
  reptiles: {
    seasonal: false,
    seqMax: 42, thaiMax: 180, sciMax: 312, engMax: 478,
    cols: [
      ['legal_status', 490], ['onep_2548', 531], ['onep_2560', 567],
      ['onep_2565', 603], ['iucn_status', 639], ['cites_status', 679],
    ],
  },
  amphibians: {
    seasonal: false,
    seqMax: 57, thaiMax: 202, sciMax: 352, engMax: 495,
    cols: [
      ['legal_status', 512], ['onep_2548', 554], ['onep_2560', 589],
      ['onep_2565', 625], ['iucn_status', 661], ['cites_status', 701],
    ],
  },
  birds: {
    seasonal: true,
    seqMax: 42, thaiMax: 182, sciMax: 322, engMax: 470,
    cols: [
      ['legal_status', 495], ['onep_2548', 539], ['onep_2560', 572],
      ['onep_2565', 608], ['iucn_status', 644], ['cites_status', 685],
      ['seasonal_status', 740],
    ],
  },
};

// Rows per INSERT. Same size as the other importers.
const BATCH_SIZE = 500;

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so there is no database to write to.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run import:dnp-wildlife',
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

/** A boolean column, always spelled true/false. */
function sqlBool(value) {
  return value ? 'true' : 'false';
}

/** A GET that retries throttling/5xx with backoff, then gives up loudly. */
async function fetchJson(url, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'globie-earth/1.0 (import-dnp-wildlife)' },
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

// ----------------------------------------------------------- the PDF grid ----

const WORD_RE =
  /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
const PAGE_RE = /<page [^>]*>([\s\S]*?)<\/page>/g;

/** Minimal XML entity decoding; PDF text carries &amp; in a few English names. */
function decode(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Every word of a PDF, split by page, as { x, y, text }. */
function pdfPages(path) {
  let xml;
  try {
    xml = execFileSync('pdftotext', ['-bbox-layout', path, '-'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('pdftotext was not found on PATH (poppler-utils).');
      process.exit(1);
    }
    throw error;
  }

  const pages = [];
  for (const page of xml.matchAll(PAGE_RE)) {
    const words = [];
    for (const word of page[1].matchAll(WORD_RE)) {
      const text = decode(word[5]).trim();
      if (text) {
        words.push({ x: Number(word[1]), x2: Number(word[3]), y: Number(word[2]), text });
      }
    }
    pages.push(words);
  }
  return pages;
}

/** Groups a page's words into visual rows (same baseline, y within 3pt). */
function pageRows(words) {
  const rows = [];
  for (const word of [...words].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - word.y) <= 3);
    if (row) row.words.push(word);
    else rows.push({ y: word.y, words: [word] });
  }
  return rows.sort((a, b) => a.y - b.y);
}

const THAI_RE = /[\u0e00-\u0e7f]/;
const IUCN_RE = /^(EX|EW|CR|EN|VU|NT|LC|DD|NE|RE|LR|NA)$/;
const CITES_RE = /^(I|II|III)$/;

/** The status value for one column, or null when it is a placeholder/absent. */
function statusValue(column, text) {
  const value = text.trim();
  if (!value || value === '-') return null;
  if (column === 'legal_status') return /^[คส]$/.test(value) ? value : null;
  // Any Thai here is wrapped text from a neighbouring cell, never a status code.
  if (THAI_RE.test(value)) return null;
  if (column === 'cites_status') return CITES_RE.test(value) ? value : null;
  if (column === 'iucn_status' || column.startsWith('onep_')) {
    return IUCN_RE.test(value.toUpperCase()) ? value.toUpperCase() : null;
  }
  // seasonal_status: codes like "R (N?)", "N", "B".
  return value.length <= 12 ? value : null;
}

/**
 * Joins the Thai-name words of one row back into a single string. pdftotext
 * splits a Thai name into two boxes wherever the renderer began a new glyph run
 * - at a tone mark, or at a sara am. Such boxes abut (a gap of ~0pt), so
 * contiguous boxes are spliced with no separator while a real gap - the space
 * an author typed around "หรือ" - keeps one. A fragment that opens with a lone
 * sara aa (optionally under its tone mark) right after a splice is the sara am
 * the PDF's text layer lost (U+0E33 does not survive extraction from these
 * files), so it is restored in place, which is the only position the loss is
 * unambiguous: a real sara aa there would have kept the name in one box.
 */
function joinThai(words) {
  const sorted = [...words].sort((a, b) => a.x - b.x);
  let out = '';
  let prevEnd = null;

  for (const word of sorted) {
    const spliced = prevEnd !== null && word.x - prevEnd <= 1.5;
    if (prevEnd !== null && !spliced) out += ' ';
    out += spliced
      ? word.text.replace(/^([\u0e48-\u0e4b])?\u0e32/u, (_, tone) => `${tone ?? ''}\u0e33`)
      : word.text;
    prevEnd = word.x2;
  }
  return out;
}

/**
 * Normalises a Thai name for storage: the "หรือ" that joins the primary and the
 * alternate name becomes a separator, since the two are one species the schema
 * names once. Whitespace is collapsed; the empty result is null.
 */
function cleanThai(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const parts = text
    .split(/\s*หรือ\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.join(' ') || null;
}

/**
 * Parses one class PDF into checklist entries `{ order, family, words }`. A
 * taxonomy "Order …"/"Family …" label sets the running order/family for the rows
 * that follow, and each data row records the taxonomy in force when it is
 * emitted. A blank label (the first page of the birds sheet) leaves it null
 * rather than carrying the previous page's.
 */
function parsePdf(path) {
  const entries = [];
  let order = null;
  let family = null;

  for (const words of pdfPages(path)) {
    for (const row of pageRows(words)) {
      const sorted = [...row.words].sort((a, b) => a.x - b.x);
      const first = sorted[0];

      // Taxonomy labels sit in the sequence column and carry their value on the
      // same line. The birds sheet prints "Family" split as "Famil" + "y" across
      // two header lines, so a short "Famil*" label is matched as well.
      if (first.x < 60 && /^Order\b/i.test(first.text)) {
        order = sorted.slice(1).map((w) => w.text).join(' ').trim() || null;
        continue;
      }
      if (first.x < 60 && /^Famil/i.test(first.text) && first.text.length <= 6) {
        family = sorted.slice(1).map((w) => w.text).join(' ').trim() || null;
        continue;
      }
      // A data row starts with its checklist number.
      if (!/^\d+$/.test(first.text)) continue;

      entries.push({ order, family, words: sorted });
    }
  }
  return entries;
}

/** Maps one parsed entry's words to the columns of the layout. */
function toChecklistRow(entry, layout, klass, seq) {
  const thai = [];
  const sci = [];
  const eng = [];
  const status = new Map();

  for (const word of entry.words) {
    if (word.x < layout.seqMax) continue;
    if (word.x < layout.thaiMax) thai.push(word);
    else if (word.x < layout.sciMax) sci.push(word.text);
    else if (word.x < layout.engMax) eng.push(word.text);
    else {
      let best = null;
      let bestDistance = Infinity;
      for (const [column, centre] of layout.cols) {
        const distance = Math.abs(word.x - centre);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = column;
        }
      }
      if (best && bestDistance <= 22) {
        status.set(best, `${status.get(best) ?? ''} ${word.text}`.trim());
      }
    }
  }

  const scientific = sci.join(' ').trim();
  if (!scientific) return null;

  const row = {
    seq: String(seq),
    groupType: klass,
    thaiName: cleanThai(joinThai(thai)),
    scientificName: scientific,
    englishName: eng.join(' ').trim() || null,
    orderName: entry.order,
    family: entry.family,
    legalStatus: null,
    onep2548: null,
    onep2560: null,
    onep2565: null,
    iucnStatus: null,
    citesStatus: null,
    seasonalStatus: null,
    isProtected: false,
    isReserved: false,
  };

  for (const [column, raw] of status) {
    const value = statusValue(column, raw);
    if (!value) continue;
    if (column === 'legal_status') {
      row.legalStatus = value;
      if (value === 'ค') row.isProtected = true;
      if (value === 'ส') row.isReserved = true;
    } else if (column === 'seasonal_status') row.seasonalStatus = value;
    else row[toCamel(column)] = value;
  }
  return row;
}

function toCamel(column) {
  return {
    onep_2548: 'onep2548',
    onep_2560: 'onep2560',
    onep_2565: 'onep2565',
    iucn_status: 'iucnStatus',
    cites_status: 'citesStatus',
  }[column];
}

// --------------------------------------------------------- statutory lists ----

/** Splits "A หรือ B หรือ C ชื่อพ้อง" into its distinct scientific names. */
function splitNames(value) {
  return String(value ?? '')
    .replace(/\s*ชื่อพ้อง\s*$/u, '')
    .split(/\s+หรือ\s+/u)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** The matching key for a scientific name: case/space-insensitive, no citation. */
function normName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The animal class implied by a statutory category, or null when unnamed. */
function classOfCategory(category) {
  const text = String(category ?? '');
  if (/เลี้ยงลูกด้วยนม|mammal/i.test(text)) return 'mammals';
  if (/สะเทินน้ำสะเทินบก|amphibian/i.test(text)) return 'amphibians';
  if (/เลื้อยคลาน|reptile/i.test(text)) return 'reptiles';
  if (/นก|bird/i.test(text)) return 'birds';
  if (/ปลา|fish/i.test(text)) return 'fish';
  if (/แมลง|insect/i.test(text)) return 'insects';
  return null;
}

/** Every row of a datastore_active CKAN resource. */
async function datastoreAll(resourceId) {
  const records = [];
  let offset = 0;
  for (;;) {
    const payload = await fetchJson(
      `${CKAN_BASE}/api/3/action/datastore_search` +
        `?resource_id=${encodeURIComponent(resourceId)}&limit=5000&offset=${offset}`,
    );
    if (!payload?.success) throw new Error(`datastore_search failed: ${JSON.stringify(payload?.error)}`);
    const page = payload.result?.records;
    if (!Array.isArray(page) || page.length === 0) break;
    records.push(...page);
    offset += page.length;
    if (offset >= Number(payload.result.total ?? offset)) break;
  }
  return records;
}

/** RFC 4180 CSV, as import-dnp-plants.mjs parses the plant checklist. */
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
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------ the download ----

/** The four checklist PDFs on disk, downloaded into .cache once. */
async function localPdfs() {
  const out = [];
  for (const resource of PDF_RESOURCES) {
    const cached = join(PDFS_DIR || PDF_CACHE, resource.file);
    if (existsSync(cached)) {
      out.push({ ...resource, path: cached });
      continue;
    }
    if (PDFS_DIR) {
      throw new Error(`${cached} not found under DNP_WILDLIFE_PDFS.`);
    }
    mkdirSync(PDF_CACHE, { recursive: true });
    const url = `${CKAN_BASE}/dataset/${WILDLIFE_DATASET}/resource/${resource.rid}/download/.pdf`;
    process.stdout.write(`Downloading ${resource.file}\n`);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'globie-earth/1.0 (import-dnp-wildlife)' },
    });
    if (!response.ok) throw new Error(`PDF download returned HTTP ${response.status} for ${resource.file}.`);
    writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
    out.push({ ...resource, path: cached });
  }
  return out;
}

/** The protected list rows, with the statutory category kept for its class. */
async function loadProtected() {
  const records = await datastoreAll(PROTECTED_RESOURCE);
  return records
    .map((record) => ({
      thai: String(record['ชื่อไทย'] ?? '').trim() || null,
      english: null,
      names: splitNames(record['ชื่อวิทยาศาสตร์']),
      category: record['บัญชีสัตว์คุ้มครอง'],
      sourceId: String(record['_id'] ?? ''),
    }))
    .filter((row) => row.names.length);
}

/** The reserved list rows, read from the CSV (its Thai name cell wraps). */
async function loadReserved() {
  process.stdout.write(`Downloading ${RESERVED_CSV_URL}\n`);
  const response = await fetch(RESERVED_CSV_URL, {
    headers: { 'User-Agent': 'globie-earth/1.0 (import-dnp-wildlife)' },
  });
  if (!response.ok) throw new Error(`Reserved CSV returned HTTP ${response.status}.`);
  const table = parseCsv(await response.text());
  const header = table.shift()?.map((h) => h.trim()) ?? [];
  const column = (name) => header.indexOf(name);
  for (const required of ['ชื่อไทย', 'ชื่อวิทยาศาสตร์']) {
    if (column(required) === -1) throw new Error(`The reserved CSV is missing "${required}".`);
  }
  return table
    .map((fields) => ({
      thai: String(fields[column('ชื่อไทย')] ?? '').replace(/\s+/g, ' ').trim() || null,
      english: String(fields[column('ชื่อสามัญ')] ?? '').replace(/\s+/g, ' ').trim() || null,
      names: splitNames(fields[column('ชื่อวิทยาศาสตร์')]),
      category: null,
      sourceId: String(fields[0] ?? '').trim(),
    }))
    .filter((row) => row.names.length);
}

// ------------------------------------------------------------- the import ----

/** The multi-row upsert for one batch, keyed on the species' stable identity. */
function upsertSql(rows) {
  const values = rows
    .map(
      (row) =>
        `  (${sqlText(row.resourceId)}, ${sqlText(row.sourceId)}, ${sqlText(row.sourceUrl)}, ` +
        `${sqlText(row.groupType)}, ${sqlText(row.thaiName)}, ${sqlText(row.scientificName)}, ` +
        `${sqlText(row.englishName)}, ${sqlText(row.orderName)}, ${sqlText(row.family)}, ` +
        `${sqlText(row.legalStatus)}, ${sqlBool(row.isReserved)}, ${sqlBool(row.isProtected)}, ` +
        `${sqlText(row.onep2548)}, ${sqlText(row.onep2560)}, ${sqlText(row.onep2565)}, ` +
        `${sqlText(row.iucnStatus)}, ${sqlText(row.citesStatus)}, ${sqlText(row.seasonalStatus)})`,
    )
    .join(',\n');

  return `insert into api.dnp_wildlife (
  resource_id, source_id, source_url, group_type, thai_name, scientific_name,
  english_name, order_name, family, legal_status, is_reserved, is_protected,
  onep_2548, onep_2560, onep_2565, iucn_status, cites_status, seasonal_status
) values
${values}
on conflict (scientific_name) do update set
  resource_id      = excluded.resource_id,
  source_id        = excluded.source_id,
  source_url       = excluded.source_url,
  group_type       = excluded.group_type,
  thai_name        = coalesce(excluded.thai_name, api.dnp_wildlife.thai_name),
  english_name     = coalesce(excluded.english_name, api.dnp_wildlife.english_name),
  order_name       = coalesce(excluded.order_name, api.dnp_wildlife.order_name),
  family           = coalesce(excluded.family, api.dnp_wildlife.family),
  legal_status     = coalesce(excluded.legal_status, api.dnp_wildlife.legal_status),
  is_reserved      = api.dnp_wildlife.is_reserved or excluded.is_reserved,
  is_protected     = api.dnp_wildlife.is_protected or excluded.is_protected,
  onep_2548        = coalesce(excluded.onep_2548, api.dnp_wildlife.onep_2548),
  onep_2560        = coalesce(excluded.onep_2560, api.dnp_wildlife.onep_2560),
  onep_2565        = coalesce(excluded.onep_2565, api.dnp_wildlife.onep_2565),
  iucn_status      = coalesce(excluded.iucn_status, api.dnp_wildlife.iucn_status),
  cites_status     = coalesce(excluded.cites_status, api.dnp_wildlife.cites_status),
  seasonal_status  = coalesce(excluded.seasonal_status, api.dnp_wildlife.seasonal_status),
  imported_at      = now();`;
}

let imported = 0;

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
  // 1. The four class checklists, one row per species keyed by scientific name.
  const pdfs = await localPdfs();
  const rows = [];
  const keyed = new Map();
  let checklistTotal = 0;

  for (const pdf of pdfs) {
    const layout = PDF_LAYOUT[pdf.class];
    if (!layout) throw new Error(`No layout for class ${pdf.class}.`);
    const sourceUrl = `${CKAN_BASE}/dataset/${WILDLIFE_PACKAGE}/resource/${pdf.rid}`;
    const entries = parsePdf(pdf.path);
    let kept = 0;
    for (const entry of entries) {
      const row = toChecklistRow(entry, layout, pdf.class, kept + 1);
      if (!row) continue;
      const key = normName(row.scientificName);
      // A species is named once across all four classes; the first wins.
      if (keyed.has(key)) continue;
      kept += 1;
      row.resourceId = pdf.rid;
      row.sourceId = String(kept);
      row.sourceUrl = sourceUrl;
      keyed.set(key, row);
      rows.push(row);
    }
    checklistTotal += kept;
    process.stdout.write(`  ${pdf.file}: ${entries.length} row(s), ${kept} with a scientific name\n`);
  }

  // 2. The two statutory lists. Their standing is authoritative, so they set the
  //    flags by scientific name; a species named only on a list still gets a row.
  const lists = [
    {
      label: 'protected',
      flag: 'isProtected',
      code: 'ค',
      resource: PROTECTED_RESOURCE,
      url: `${CKAN_BASE}/dataset/${PROTECTED_PACKAGE}/resource/${PROTECTED_RESOURCE}`,
      entries: await loadProtected(),
    },
    {
      label: 'reserved',
      flag: 'isReserved',
      code: 'ส',
      resource: RESERVED_RESOURCE,
      url: `${CKAN_BASE}/dataset/${RESERVED_PACKAGE}/resource/${RESERVED_RESOURCE}`,
      entries: await loadReserved(),
    },
  ];

  for (const list of lists) {
    let matched = 0;
    for (const entry of list.entries) {
      const hit = entry.names.map((name) => keyed.get(normName(name))).find(Boolean);
      if (hit) {
        hit[list.flag] = true;
        if (!hit.thaiName && entry.thai) hit.thaiName = cleanThai(entry.thai);
        if (!hit.englishName && entry.english) hit.englishName = entry.english;
        matched += 1;
        continue;
      }
      const scientificName = entry.names[0];
      const key = normName(scientificName);
      if (keyed.has(key)) continue;
      const row = {
        resourceId: list.resource,
        sourceId: entry.sourceId,
        sourceUrl: list.url,
        groupType: classOfCategory(entry.category) ?? 'other',
        thaiName: cleanThai(entry.thai),
        scientificName,
        englishName: entry.english,
        orderName: null,
        family: null,
        legalStatus: list.code,
        onep2548: null,
        onep2560: null,
        onep2565: null,
        iucnStatus: null,
        citesStatus: null,
        seasonalStatus: null,
        isProtected: list.flag === 'isProtected',
        isReserved: list.flag === 'isReserved',
      };
      keyed.set(key, row);
      rows.push(row);
    }
    process.stdout.write(`  ${list.label}: ${list.entries.length} listed, ${matched} matched the checklist\n`);
  }

  flush(rows);
  const total = imported;

  const stored = psql(['-A', '-t', '-c', 'select count(*) from api.dnp_wildlife;']).trim();

  console.log('');
  console.log(`  checklist rows   ${checklistTotal}`);
  console.log(`  total rows       ${total}`);
  console.log(`  upserted         ${imported} row(s)`);
  console.log(`  api.dnp_wildlife ${stored} row(s)`);
  console.log('');
  console.log('Done. Run `npm run backfill:embeddings -- dnp_wildlife` to make these searchable.');
} catch (error) {
  console.error(`The import failed: ${message(error)}`);
  process.exit(1);
}
