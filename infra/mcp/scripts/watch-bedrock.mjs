// Watches Bedrock until the account-level hold lifts, then runs the backfill once.
//
// The hold (AWS support case 179122138300151) makes every embed call fail with
// ValidationException "Operation not allowed". Rather than poll by hand, this
// re-probes on an interval and, the moment a probe succeeds, hands straight over
// to scripts/backfill-embeddings.mjs - so the catalogue is seeded as soon as the
// account is allowed to embed, with nobody watching.
//
//   npm run build
//   EMBEDDING_PROVIDER=bedrock \
//   DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree \
//     npm run watch:embeddings
//
// PROBE_INTERVAL_MS overrides the 5-minute cadence (floored at 10 s).
//
// Exit 0: a probe succeeded and the backfill ran cleanly.
// Exit 1: a probe succeeded but the backfill failed (its own message says why).
// Exit 2: EMBEDDING_PROVIDER is not bedrock, so there is no hold to wait on.
// Exit 3: DATABASE_URL is not set, so the backfill would have nowhere to write.
// Ctrl-C: stops watching.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { embedWithUsage, getEmbeddingProvider } from '../dist/embed.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 10 * 1000;

const provider = getEmbeddingProvider();
if (!provider) {
  console.error(
    'EMBEDDING_PROVIDER=none, so there is no hold to wait on.\n' +
      'Set EMBEDDING_PROVIDER=bedrock (with AWS credentials and BEDROCK_REGION) and run again.',
  );
  process.exit(2);
}

const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set, so the backfill would have nowhere to write.\n' +
      'Point it at the migration role, e.g. for the local stack:\n' +
      '  DATABASE_URL=postgres://globietree:globietree@localhost:5434/globietree npm run watch:embeddings',
  );
  process.exit(3);
}

const requested = Number.parseInt(process.env.PROBE_INTERVAL_MS ?? '', 10);
const intervalMs =
  Number.isFinite(requested) && requested > 0 ? Math.max(requested, MIN_INTERVAL_MS) : DEFAULT_INTERVAL_MS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(error) {
  if (!(error instanceof Error)) return String(error);
  const status = error.$metadata?.httpStatusCode;
  return status ? `${error.name} ${status}: ${error.message}` : `${error.name}: ${error.message}`;
}

process.on('SIGINT', () => {
  console.log('\nStopped watching. No rows were written.');
  process.exit(0);
});

console.log(
  `Watching ${provider.model} for the account hold to lift (every ${intervalMs / 1000}s).\n` +
    'The moment a probe succeeds, the catalogue backfill runs.\n',
);

let attempt = 0;
for (;;) {
  attempt += 1;
  try {
    const { vector } = await embedWithUsage('probe');
    if (vector.length !== provider.dims) {
      throw new Error(`the probe returned ${vector.length} numbers, not ${provider.dims}`);
    }
    console.log(`\nprobe ${attempt}: OK (${vector.length} dims). The hold has lifted - running the backfill.\n`);
    break;
  } catch (error) {
    console.log(
      `probe ${attempt} at ${new Date().toISOString()}: ${describe(error)} - retrying in ${intervalMs / 1000}s`,
    );
  }
  await sleep(intervalMs);
}

const backfill = join(dirname(fileURLToPath(import.meta.url)), 'backfill-embeddings.mjs');
const result = spawnSync(process.execPath, [backfill], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
