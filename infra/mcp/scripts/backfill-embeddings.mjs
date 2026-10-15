// Backfills api.embeddings from the seeded catalogue.
//
// The catalog seed deliberately ships no embeddings, so search_forest_knowledge
// and recommend_species honestly return nothing until the catalogue rows have
// vectors. This script produces them with the *same* provider the server uses at
// query time (`getEmbeddingProvider`: the local model by default, Amazon Titan
// V1 when EMBEDDING_PROVIDER=bedrock), because a vector only means anything next
// to another vector from the same model.
//
//   npm run build
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run backfill:embeddings
//
// Why a direct connection instead of PostgREST: the RLS policies revoke all on
// api.embeddings from anon, so only the migration role may write it - the tools
// still read and write everything else through PostgREST and the caller's own
// X-Device-Id, exactly as before. The catalogue vectors are global, not
// device-scoped, so this write belongs to migration, not to a listener.
//
// The default provider needs nothing: the local model is fetched from the
// Hugging Face hub once and cached. EMBEDDING_PROVIDER=bedrock instead needs AWS
// credentials with Bedrock access (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or
// an instance role) and amazon.titan-embed-text-v1 enabled in BEDROCK_REGION. The
// stored vectors must also match the column: the embeddings column is 384
// wide for the local model, and Titan writes 1536.
//
// Exit 0: every entity was embedded and upserted.
// Exit 1: an embedding or the upsert failed (the message says what).
// Exit 2: EMBEDDING_PROVIDER=none, so there is no vector space to write into.
// Exit 3: DATABASE_URL is not set, so there is no database to write to.

import { execFileSync } from 'node:child_process';

import { getEmbeddingProvider, embedWithUsage } from '../dist/embed.js';

// The published on-demand price for Titan Text Embeddings V1: $0.10 per 1M input
// tokens (https://aws.amazon.com/bedrock/pricing/, checked 2026-10-05). Only
// meaningful for EMBEDDING_PROVIDER=bedrock - the local model reports no tokens,
// so the cost lines below stay silent.
const PRICE_PER_MILLION_TOKENS = 0.1;

/** What psql prints as one line of JSON per query, from the seeded tables. */
const SOURCE_SQL = {
  species: `select coalesce(json_agg(json_build_object(
      'id', id, 'name', name, 'botanical', botanical, 'tagline', tagline,
      'need_badge', need_badge, 'description', description
    ) order by sort_order, id), '[]'::json) from api.species;`,

  guardian: `select coalesce(json_agg(json_build_object(
      'id', id, 'name', name, 'thai_name', thai_name, 'scientific_name', scientific_name,
      'title', title, 'rarity', rarity, 'epithet', epithet, 'quote', quote, 'traits', traits
    ) order by sort_order, id), '[]'::json) from api.guardians;`,

  site: `select coalesce(json_agg(json_build_object(
      'id', id, 'title', title, 'sub_sector', sub_sector, 'badge', badge,
      'description', description, 'telemetry', telemetry
    ) order by sort_order, id), '[]'::json) from api.sites;`,

  // External reference data (the dnp_species table). Every survey row is
  // embedded, so the catalog_search space is as complete as the imported
  // survey; the provenance fields ride along in the content so a hit can state
  // where it came from.
  dnp_species: `select coalesce(json_agg(json_build_object(
      'id', id, 'scientific_name', scientific_name, 'thai_name', thai_name,
      'family', family, 'group_type', group_type, 'protected_area', protected_area,
      'forest_type', forest_type, 'survey_year_be', survey_year_be, 'synonyms', synonyms
    ) order by id), '[]'::json) from api.dnp_species;`,

  // A second DNP artefact (the dnp_plants table, enriched from GBIF):
  // the national plant checklist, one row per species with a GBIF-resolved English
  // common name plus its genus, synonyms, native status, Red List category and Thai
  // occurrence signal. Every row is embedded so an English question lands on the
  // same cosine space as the rest.
  dnp_plant: `select coalesce(json_agg(json_build_object(
      'id', id, 'scientific_name', scientific_name, 'thai_name', thai_name,
      'family', family, 'english_name', english_name,
      'genus', genus, 'synonyms', synonyms, 'native_status', native_status,
      'iucn_status', iucn_status, 'th_record_count', th_record_count,
      'th_provinces', th_provinces
    ) order by id), '[]'::json) from api.dnp_plants;`,

  // A third DNP artefact (the dnp_fauna table): fauna observed inside national parks,
  // one row per (park, species) observation, with taxonomy and conservation status.
  // The park and province ride along so "what lives in Khao Yai?" lands here.
  dnp_fauna: `select coalesce(json_agg(json_build_object(
      'id', id, 'scientific_name', scientific_name, 'thai_name', thai_name,
      'group_type', group_type, 'protected_area', protected_area, 'protected_area_en', protected_area_en,
      'order_name', order_name, 'family', family, 'genus', genus,
      'iucn_status', iucn_status, 'onep_status', onep_status, 'cites_status', cites_status,
      'habitat', habitat, 'distribution', distribution, 'province', province
    ) order by id), '[]'::json) from api.dnp_fauna;`,

  // A fourth DNP artefact (the dnp_wildlife table): the national wildlife checklist
  // merged with the statutory protected/reserved lists. The English common name is
  // written first in the content so an English query lands on this row.
  dnp_wildlife: `select coalesce(json_agg(json_build_object(
      'id', id, 'scientific_name', scientific_name, 'thai_name', thai_name, 'english_name', english_name,
      'group_type', group_type, 'order_name', order_name, 'family', family,
      'legal_status', legal_status, 'is_reserved', is_reserved, 'is_protected', is_protected,
      'onep_2548', onep_2548, 'onep_2560', onep_2560, 'onep_2565', onep_2565,
      'iucn_status', iucn_status, 'cites_status', cites_status, 'seasonal_status', seasonal_status
    ) order by id), '[]'::json) from api.dnp_wildlife;`,

  // The project's own cookbook (254_cookbook.sql, imported by import-cookbook.mjs):
  // one row per Thai dish, with the English name first so an English query lands
  // on it, plus the romanised and Thai names, the region and category, and the
  // whole ingredient list and method so a cooking question reaches the recipe.
  recipe: `select coalesce(json_agg(json_build_object(
      'id', id, 'slug', slug, 'name_en', name_en, 'name_local', name_local, 'name_thai', name_thai,
      'region', region, 'category', category, 'servings', servings, 'total_minutes', total_minutes,
      'description', description, 'ingredients', ingredients, 'steps', steps, 'tips', tips
    ) order by id), '[]'::json) from api.cookbook_recipes;`,
};

/**
 * The numbered method of one dish as a single string: "Method: 1. … 2. …", each
 * step carrying the book's own time where it gave one. `steps` is jsonb, so a
 * step arrives as { step, detail, minutes } - and `minutes` may be a number or a
 * range the book wrote as a string ("20-25"). Empty where the book printed none.
 */
function recipeMethod(steps) {
  const list = (steps ?? []).filter((step) => step && step.detail);
  if (!list.length) return '';
  const rendered = list.map((step, index) => {
    const number = step.step ?? index + 1;
    const minutes =
      step.minutes === null || step.minutes === undefined || step.minutes === ''
        ? ''
        : ` (${step.minutes} min)`;
    return `${number}. ${step.detail}${minutes}`;
  });
  return ` Method: ${rendered.join(' ')}`;
}

/**
 * The text stored as this entity's embedding content, and the text the model
 * actually reads. It blends the fields a listener would ask about, because
 * catalog_search hands this string straight back as the answer.
 */
const CONTENT = {
  species: (row) =>
    `${row.name} (${row.botanical}) — ${row.tagline}. Need: ${row.need_badge}. ${row.description}`,

  guardian: (row) =>
    `${row.name} (${row.thai_name}), ${row.scientific_name}. Title: ${row.title}. ` +
    `Rarity: ${row.rarity}. ${row.epithet}. "${row.quote}" Traits: ${(row.traits ?? []).join(', ')}.`,

  site: (row) =>
    `${row.title} — ${row.sub_sector}${row.badge ? ` (${row.badge})` : ''}. ` +
    `${row.description} ${row.telemetry}.`,

  // The surveyed facts, phrased so a natural-language question ("what grows in
  // Khao Yai?") lands on this text. The survey year is shown in the Buddhist
  // Era the source uses, so the stored content matches the upstream record.
  dnp_species: (row) => {
    const names = [row.scientific_name, row.thai_name && `(${row.thai_name})`]
      .filter(Boolean)
      .join(' ');
    const where = row.protected_area ? `Found in ${row.protected_area}` : '';
    const forest = row.forest_type ? `, ${row.forest_type} forest` : '';
    const family = row.family ? ` Family: ${row.family}.` : '';
    const year = row.survey_year_be ? ` Surveyed BE ${row.survey_year_be}.` : '';
    const group = row.group_type ? ` Group: ${row.group_type}.` : '';
    const synonyms = row.synonyms ? ` Synonyms: ${row.synonyms}.` : '';
    return `${names}${group}${where}${forest}.${family}${year}${synonyms}`;
  },

  // The checklist has no location or year, only a name in each of three
  // languages. The English common name is written first when GBIF has one, so
  // an English query matches this row; the Latin and Thai names follow so the
  // same species is reachable whichever name a listener knows it by.
  dnp_plant: (row) => {
    const names = [row.scientific_name, row.thai_name && `(${row.thai_name})`]
      .filter(Boolean)
      .join(' ');
    const english = row.english_name ? ` English: ${row.english_name}.` : '';
    const genus = row.genus ? ` Genus: ${row.genus}.` : '';
    const family = row.family ? ` Family: ${row.family}.` : '';
    const native = row.native_status ? ` In Thailand: ${row.native_status}.` : '';
    const iucn = row.iucn_status ? ` IUCN: ${row.iucn_status}.` : '';
    const records =
      row.th_record_count != null ? ` GBIF records in Thailand: ${row.th_record_count}.` : '';
    const provinces = row.th_provinces ? ` Provinces: ${row.th_provinces}.` : '';
    const synonyms = row.synonyms ? ` Synonyms: ${row.synonyms}.` : '';
    return `${names}.${english}${genus}${family}${native}${iucn}${records}${provinces}${synonyms}`;
  },

  // The observed facts: which animal, in which park and province, with the
  // taxonomy a listener may ask by and the conservation status. Phrased so a
  // natural-language question ("what birds live in Doi Inthanon?") lands here.
  dnp_fauna: (row) => {
    const names = [row.scientific_name, row.thai_name && `(${row.thai_name})`]
      .filter(Boolean)
      .join(' ');
    const group = row.group_type ? `Group: ${row.group_type}. ` : '';
    const place = row.protected_area
      ? `Found in ${row.protected_area}${row.protected_area_en ? ` (${row.protected_area_en})` : ''}` +
        `${row.province ? `, ${row.province}` : ''}. `
      : '';
    const taxonomy = [
      row.order_name && `Order: ${row.order_name}`,
      row.family && `Family: ${row.family}`,
      row.genus && `Genus: ${row.genus}`,
    ]
      .filter(Boolean)
      .join('. ');
    const status = [
      row.iucn_status && `IUCN: ${row.iucn_status}`,
      row.onep_status && `ONEP: ${row.onep_status}`,
      row.cites_status && `CITES: ${row.cites_status}`,
    ]
      .filter(Boolean)
      .join(', ');
    const habitat = row.habitat ? `Habitat: ${row.habitat}. ` : '';
    const distribution = row.distribution ? `Distribution: ${row.distribution}.` : '';
    return `${names}. ${group}${place}${taxonomy ? taxonomy + '. ' : ''}${status ? status + '. ' : ''}${habitat}${distribution}`.trim();
  },

  // The national checklist row: English name first so an English query matches,
  // then the Latin and Thai names, the class and taxonomy, whether the species is
  // legally reserved/protected, and the ONEP/IUCN/CITES/seasonal statuses.
  dnp_wildlife: (row) => {
    const names = [row.english_name, row.scientific_name, row.thai_name && `(${row.thai_name})`]
      .filter(Boolean)
      .join(' ');
    const group = row.group_type ? `Group: ${row.group_type}. ` : '';
    const taxonomy = [row.order_name && `Order: ${row.order_name}`, row.family && `Family: ${row.family}`]
      .filter(Boolean)
      .join('. ');
    const protection = row.is_reserved
      ? 'Legally reserved wildlife. '
      : row.is_protected
        ? 'Legally protected wildlife. '
        : '';
    const onep = [
      row.onep_2548 && `ONEP 2548: ${row.onep_2548}`,
      row.onep_2560 && `ONEP 2560: ${row.onep_2560}`,
      row.onep_2565 && `ONEP 2565: ${row.onep_2565}`,
    ]
      .filter(Boolean)
      .join(', ');
    const status = [
      row.iucn_status && `IUCN: ${row.iucn_status}`,
      onep,
      row.cites_status && `CITES: ${row.cites_status}`,
      row.seasonal_status && `Seasonal: ${row.seasonal_status}`,
    ]
      .filter(Boolean)
      .join(', ');
    return `${names}. ${group}${taxonomy ? taxonomy + '. ' : ''}${protection}${status ? status + '.' : ''}`.trim();
  },

  // The cookbook dish: English name first so an English cooking question lands
  // on it, then the romanised and Thai names, the region and category, a one-
  // line description, the whole ingredient list so "what goes in green curry?"
  // reaches the right recipe, and the numbered method so "how do I cook it?"
  // does too - catalog_search returns this string itself, so the steps a
  // listener hears are the ones stored here.
  recipe: (row) => {
    const names = [row.name_en, row.name_local && `(${row.name_local})`, row.name_thai && `(${row.name_thai})`]
      .filter(Boolean)
      .join(' ');
    const where = row.region ? ` ${row.region} Thai` : ' Thai';
    const time = row.total_minutes != null ? ` About ${row.total_minutes} minutes.` : '';
    const ingredients = (row.ingredients ?? []).length
      ? ` Ingredients: ${(row.ingredients ?? []).join(', ')}.`
      : '';
    const method = recipeMethod(row.steps);
    const tips = (row.tips ?? []).length ? ` Tips: ${(row.tips ?? []).join(' ')}` : '';
    return `${names} — ${row.category}${where}. ${row.description}${time}${ingredients}${method}${tips}`.trim();
  },
};

const ENTITY_TYPES = ['species', 'guardian', 'site', 'dnp_species', 'dnp_plant', 'dnp_fauna', 'dnp_wildlife', 'recipe'];

// Optional args narrow the run to named entity types, e.g.
//   npm run backfill:embeddings -- dnp_species dnp_plant
// so the ~61k-row DNP survey and the ~9k-row plant checklist can be embedded
// without re-embedding the seeded catalogue. No args means all eight, exactly as
// before.
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const selected = requested.length ? requested : ENTITY_TYPES;
for (const entityType of selected) {
  if (!ENTITY_TYPES.includes(entityType)) {
    console.error(`Unknown entity type "${entityType}". Known types: ${ENTITY_TYPES.join(', ')}.`);
    process.exit(1);
  }
}

const provider = getEmbeddingProvider();
if (!provider) {
  console.error(
    'EMBEDDING_PROVIDER=none, so there is no vector space to write into.\n' +
      'Set EMBEDDING_PROVIDER=local (the default, no credentials needed) or ' +
      'EMBEDDING_PROVIDER=bedrock (with AWS credentials and BEDROCK_REGION), then run again.',
  );
  process.exit(2);
}

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so there is no database to write to.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run backfill:embeddings',
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
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('psql was not found on PATH. It is the client maintenance/run.sh already uses.');
      process.exit(1);
    }
    throw error;
  }
}

/** One line of SQL text, safe to embed in a statement. */
function sqlLiteral(text) {
  return `'${text.replace(/'/g, "''")}'`;
}

/** pgvector accepts the '[1,2,3]' text form for a vector column. */
function vectorLiteral(vector) {
  return `'[${vector.join(',')}]'::vector`;
}

/** The catalogue rows of one entity type, or [] when the table is empty. */
function loadRows(entityType) {
  const output = psql(['-A', '-t', '-c', SOURCE_SQL[entityType]]);
  const rows = JSON.parse(output.trim() || '[]');
  if (!Array.isArray(rows)) {
    throw new Error(`Expected ${entityType} rows as a JSON array, got ${typeof rows}.`);
  }
  return rows;
}

const model = provider.model;
const dims = provider.dims;

process.stdout.write(`Backfilling api.embeddings with ${model} (${dims} dims)\n\n`);

const jobs = [];
for (const entityType of selected) {
  for (const row of loadRows(entityType)) {
    jobs.push({ entityType, entityId: String(row.id), content: CONTENT[entityType](row) });
  }
}

if (jobs.length === 0) {
  console.log('Those entity types are empty, so there is nothing to embed.');
  process.exit(0);
}

/** Rows per upsert. Keeps each statement small while limiting round-trips. */
const BATCH_SIZE = 500;

/** The ANN index over `embedding`, named as the embeddings schema creates it. */
const HNSW_INDEX = 'api.embeddings_hnsw_idx';

/**
 * The load runs with the ANN index absent and rebuilds it once at the end.
 *
 * pgvector maintains HNSW on every INSERT, and that graph repair is the
 * memory-heavy part: a 500-vector batch was enough to make the OOM killer
 * terminate the backend on the ~1 GB local Docker VM (Postgres crash-recovered
 * and stayed up, but the run died). Loading first and indexing once is also
 * pgvector's own bulk-load guidance and is considerably faster. The index is
 * restored however the run ends, so catalog_search is never left without it.
 */
function dropHnswIndex() {
  psql(['-v', 'ON_ERROR_STOP=1', '-q', '-c', `drop index if exists ${HNSW_INDEX};`]);
}

function buildHnswIndex() {
  // Single-worker build on purpose. A parallel maintenance worker asks for a
  // dynamic shared-memory segment, and the production container's /dev/shm is
  // too small for it: a plain `create index` there fails with "could not resize
  // shared memory segment ... No space left on device" after loading every row
  // (seen on the 77,744-row run). With zero parallel workers the build allocates
  // no such segment. The SETs and the CREATE share one psql session (-c sends
  // them as one simple query) so the settings apply to the build.
  psql([
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-c',
    'set max_parallel_maintenance_workers = 0; ' +
      "set maintenance_work_mem = '256MB'; " +
      'create index if not exists embeddings_hnsw_idx ' +
      'on api.embeddings using hnsw (embedding vector_cosine_ops);',
  ]);
}

/**
 * Upserts `batch` in one statement. One chunk per entity: the texts are short,
 * and the unique key (entity_type, entity_id, chunk_index) makes a re-run an
 * update, not a duplicate. Batched rather than one statement for the whole run
 * because the DNP survey is ~61k rows: a single INSERT of that many vectors is
 * tens of megabytes of SQL, which Postgres and psql both choke on.
 *
 * Throws rather than exiting, so the caller's `finally` can rebuild the index.
 */
function flush(batch) {
  const values = batch
    .map(
      (job) =>
        `  (${sqlLiteral(job.entityType)}, ${sqlLiteral(job.entityId)}, 0, ` +
        `${sqlLiteral(job.content)}, ${vectorLiteral(job.vector)}, ${sqlLiteral(model)})`,
    )
    .join(',\n');

  const upsert = `insert into api.embeddings (entity_type, entity_id, chunk_index, content, embedding, model)
values
${values}
on conflict (entity_type, entity_id, chunk_index)
do update set content = excluded.content,
              embedding = excluded.embedding,
              model = excluded.model,
              created_at = now();`;

  try {
    psql(['-v', 'ON_ERROR_STOP=1', '-q'], upsert);
  } catch (error) {
    throw new Error(`The upsert failed: ${message(error)}`);
  }
}

// The batch load runs with the ANN index absent and rebuilds it once at the end
// (see dropHnswIndex/buildHnswIndex): pgvector maintains HNSW on every INSERT
// and that graph repair is exactly what OOM-killed a 500-vector batch on the
// ~1 GB local VM. The index is rebuilt however the run ends, so catalog_search
// is never left without it.
dropHnswIndex();

let totalTokens = 0;
let tokenReads = 0;
let embedded = 0;
let pending = [];
let failed = false;

try {
  for (const job of jobs) {
    let usage;
    try {
      // `passage` marks this as the stored side of the pair: e5-class models
      // embed a question and a stored passage with different prefixes.
      usage = await embedWithUsage(job.content, 'passage');
    } catch (error) {
      throw new Error(`Embedding ${job.entityType} ${job.entityId} failed: ${message(error)}`);
    }
    if (usage.vector.length !== dims) {
      throw new Error(
        `Embedding ${job.entityType} ${job.entityId} returned ${usage.vector.length} numbers, not ${dims}.`,
      );
    }
    job.vector = usage.vector;
    if (usage.inputTokens !== null) {
      totalTokens += usage.inputTokens;
      tokenReads += 1;
    }

    pending.push(job);
    embedded += 1;
    if (pending.length >= BATCH_SIZE) {
      flush(pending);
      pending = [];
      // One line per batch, not per row: the DNP run is ~61k rows and a line
      // each would bury the summary and slow the run down.
      process.stdout.write(`  ${embedded}/${jobs.length} embedded and upserted\n`);
    }
  }
  if (pending.length) {
    flush(pending);
    process.stdout.write(`  ${embedded}/${jobs.length} embedded and upserted\n`);
  }
} catch (error) {
  console.error(message(error));
  failed = true;
} finally {
  process.stdout.write('  rebuilding the api.embeddings ANN index\n');
  buildHnswIndex();
}

if (failed) {
  process.exit(1);
}

const stored = psql(['-A', '-t', '-c', 'select count(*) from api.embeddings;']).trim();

console.log('');
console.log(`  model          ${model}`);
console.log(`  entities       ${jobs.length} embedded and upserted`);
console.log(`  api.embeddings ${stored} row(s) now stored`);

if (tokenReads === jobs.length) {
  const cost = (totalTokens / 1_000_000) * PRICE_PER_MILLION_TOKENS;
  console.log(`  input tokens   ${totalTokens} total  (reported by Bedrock)`);
  console.log(`  cost           $${cost.toFixed(4)} at $${PRICE_PER_MILLION_TOKENS.toFixed(2)} per 1M input tokens`);
} else if (tokenReads === 0) {
  console.log('  input tokens   not reported by the response - cost not computed');
} else {
  console.log(`  input tokens   reported on ${tokenReads}/${jobs.length} calls - cost not computed from a partial count`);
}

console.log('');
console.log('Done. search_forest_knowledge and recommend_species can now return rows.');
