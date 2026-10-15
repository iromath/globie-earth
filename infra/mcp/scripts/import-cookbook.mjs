// Imports the project's own Thai cookbook into api.cookbook_recipes.
//
// The upstream is the book the project publishes - "Cookbook Version Kai & Shea"
// by Openmind Projects (Dev-Docs/Amazon/Skills-Knowlage/Openmind-Kitchen-Cookbook.pdf).
// It is transcribed by hand, once, into scripts/data/cookbook-recipes.json: a
// checked-in, curated dataset, so the import never has to parse a PDF and a
// dish's wording is reviewable in a diff.
//
//   npm run build
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run import:cookbook
//
// Why a direct connection instead of PostgREST: 254_cookbook.sql revokes
// insert/update/delete from anon, so only the migration role may write, exactly
// as backfill-embeddings.mjs does for api.embeddings.
//
// Idempotent: the upsert is keyed on slug, the dish's stable identity, so a
// re-run refreshes rows instead of duplicating them.
//
// Exit 0: every recipe in the dataset was read and upserted.
// Exit 1: the dataset could not be read or the upsert failed.
// Exit 3: DATABASE_URL is not set.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATASET = fileURLToPath(new URL('./data/cookbook-recipes.json', import.meta.url));

// Rows per INSERT. Same size as the other importers.
const BATCH_SIZE = 500;

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so there is no database to write to.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run import:cookbook',
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

/** An integer column, or NULL for a missing value. */
function sqlInt(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : 'NULL';
}

/** A jsonb column, always spelled as a quoted JSON literal. */
function sqlJson(value) {
  const json = JSON.stringify(value ?? []);
  return `'${json.replace(/'/g, "''")}'::jsonb`;
}

// ------------------------------------------------------------- the import ----

/** The multi-row upsert for one batch, keyed on the dish's stable identity. */
function upsertSql(rows) {
  const values = rows
    .map(
      (row) =>
        `  (${sqlText(row.slug)}, ${sqlText(row.nameEn)}, ${sqlText(row.nameLocal)}, ` +
        `${sqlText(row.nameThai)}, ${sqlText(row.region)}, ${sqlText(row.category)}, ` +
        `${sqlText(row.servings)}, ${sqlInt(row.totalMinutes)}, ${sqlText(row.description)}, ` +
        `${sqlJson(row.ingredients)}, ${sqlJson(row.steps)}, ${sqlJson(row.tips)}, ` +
        `${sqlText(row.source)}, ${sqlText(row.sourceUrl)}, ${sqlText(row.license)})`,
    )
    .join(',\n');

  return `insert into api.cookbook_recipes (
  slug, name_en, name_local, name_thai, region, category, servings,
  total_minutes, description, ingredients, steps, tips, source, source_url, license
) values
${values}
on conflict (slug) do update set
  name_en       = excluded.name_en,
  name_local    = excluded.name_local,
  name_thai     = excluded.name_thai,
  region        = excluded.region,
  category      = excluded.category,
  servings      = excluded.servings,
  total_minutes = excluded.total_minutes,
  description   = excluded.description,
  ingredients   = excluded.ingredients,
  steps         = excluded.steps,
  tips          = excluded.tips,
  source        = excluded.source,
  source_url    = excluded.source_url,
  license       = excluded.license,
  imported_at   = now();`;
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
  const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  const recipes = Array.isArray(dataset.recipes) ? dataset.recipes : [];
  if (!recipes.length) throw new Error(`${DATASET} carries no recipes.`);

  const rows = recipes.map((recipe) => ({
    slug: recipe.slug,
    nameEn: recipe.name_en,
    nameLocal: recipe.name_local,
    nameThai: recipe.name_thai,
    region: recipe.region,
    category: recipe.category,
    servings: recipe.servings,
    totalMinutes: recipe.total_minutes,
    description: recipe.description,
    ingredients: recipe.ingredients ?? [],
    steps: recipe.steps ?? [],
    tips: recipe.tips ?? [],
    source: recipe.source ?? dataset.source,
    sourceUrl: recipe.source_url ?? null,
    license: recipe.license ?? dataset.license,
  }));

  for (const row of rows) {
    if (!row.slug || !row.nameEn || !row.category || !row.description) {
      throw new Error(`A recipe is missing a required field (slug/name_en/category/description).`);
    }
  }

  const byRegion = {};
  for (const row of rows) {
    const key = row.region ?? 'base paste';
    byRegion[key] = (byRegion[key] ?? 0) + 1;
  }
  for (const [region, count] of Object.entries(byRegion)) {
    process.stdout.write(`  ${region}: ${count} recipe(s)\n`);
  }

  // flush() drains rows in place, so keep the count for the summary first.
  const total = rows.length;

  flush(rows);

  const stored = psql(['-A', '-t', '-c', 'select count(*) from api.cookbook_recipes;']).trim();

  console.log('');
  console.log(`  dataset          ${DATASET}`);
  console.log(`  recipes          ${total}`);
  console.log(`  upserted         ${imported} row(s)`);
  console.log(`  cookbook_recipes ${stored} row(s)`);
  console.log('');
  console.log('Done. Run `npm run backfill:embeddings -- recipe` to make these searchable.');
} catch (error) {
  console.error(`The import failed: ${message(error)}`);
  process.exit(1);
}
