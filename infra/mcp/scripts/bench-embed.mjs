// Measures whatever embedding provider the server is configured with - the local
// model by default, Amazon Bedrock Titan V1 when EMBEDDING_PROVIDER=bedrock - so
// the latency in PRODUCT-FEEDBACK.md is measured, not guessed.
//
// It imports the same embedWithUsage() the server calls, so the latency below
// belongs to the production request, its validation and its token count - not
// to a copy of them that could drift.
//
//   npm run build
//   node scripts/bench-embed.mjs        # 20 measured calls (default)
//   node scripts/bench-embed.mjs 50     # 50 measured calls
//
// EMBEDDING_PROVIDER=bedrock additionally needs AWS credentials with Bedrock
// access (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or an instance role) and
// amazon.titan-embed-text-v1 enabled in BEDROCK_REGION. The first call is a
// warm-up - it pays model/client construction and TLS - and is excluded from the
// statistics.
//
// Exit 0: every call returned a vector of the provider's own width.
// Exit 1: a call failed (the message says why).
// Exit 2: EMBEDDING_PROVIDER=none, so there is nothing to measure.

import { getEmbeddingProvider, embedWithUsage } from '../dist/embed.js';

// The published on-demand price for Titan Text Embeddings V1: $0.10 per 1M
// input tokens (https://aws.amazon.com/bedrock/pricing/, checked 2026-10-05).
// Applied to the inputTextTokenCount Bedrock itself returns, so the cost is
// from billed tokens rather than a character-count estimate.
const PRICE_PER_MILLION_TOKENS = 0.1;

const RUNS = Math.min(Math.max(Number.parseInt(process.argv[2] ?? '20', 10) || 20, 1), 200);

// Representative voice questions - the kind of query search_forest_knowledge
// receives - cycled so every call embeds real catalogue-ish text.
const QUERIES = [
  'which native tree fixes nitrogen in paddy soil',
  'how does adopting a tree work',
  'what is a living deed',
  'tell me about the mother tree',
  'restoring a wetland basin',
  'guardian lore of the sacred grove',
];

/** The value at percentile p (0-100) of an ascending array. */
function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const provider = getEmbeddingProvider();
if (!provider) {
  console.error(
    'EMBEDDING_PROVIDER=none, so semantic search is switched off and there is nothing to measure.\n' +
      'Set EMBEDDING_PROVIDER=bedrock (with AWS credentials and BEDROCK_REGION) and run again.',
  );
  process.exit(2);
}

const model = provider.model;
const dims = provider.dims;

process.stdout.write(`Measuring ${model} (${dims} dims)\n\n`);

// Warm-up: pays client construction and the first TLS handshake, so it is not
// counted. A failure here is a credentials/region/access problem, reported
// plainly rather than buried in the statistics.
try {
  await embedWithUsage(QUERIES[0]);
} catch (error) {
  console.error(`Warm-up call failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const latencies = [];
let totalTokens = 0;
let tokenReads = 0;

for (let i = 0; i < RUNS; i += 1) {
  const query = QUERIES[i % QUERIES.length];
  const started = performance.now();
  let usage;
  try {
    usage = await embedWithUsage(query);
  } catch (error) {
    console.error(`Call ${i + 1} failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  latencies.push(performance.now() - started);

  if (usage.vector.length !== dims) {
    console.error(`Call ${i + 1} returned ${usage.vector.length} numbers, not ${dims}.`);
    process.exit(1);
  }
  if (usage.inputTokens !== null) {
    totalTokens += usage.inputTokens;
    tokenReads += 1;
  }
}

const sorted = [...latencies].sort((a, b) => a - b);
const mean = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
const fmt = (value) => value.toFixed(0);

console.log(`  model          ${model}`);
console.log(`  dims           ${dims}`);
console.log(`  calls          ${RUNS} measured (+1 warm-up, excluded)`);
console.log(`  queries        ${QUERIES.length} representative questions, cycled`);
console.log('');
console.log(
  `  latency (ms)   min ${fmt(sorted[0])}  ·  p50 ${fmt(percentile(sorted, 50))}  ·  ` +
    `p95 ${fmt(percentile(sorted, 95))}  ·  max ${fmt(sorted[sorted.length - 1])}  ·  mean ${fmt(mean)}`,
);

if (tokenReads === RUNS) {
  const avgTokens = totalTokens / tokenReads;
  const costPerQuery = (avgTokens / 1_000_000) * PRICE_PER_MILLION_TOKENS;
  console.log(
    `  input tokens   ${totalTokens} total  ·  ${avgTokens.toFixed(1)} per query  (reported by Bedrock)`,
  );
  console.log(
    `  cost           $${costPerQuery.toExponential(2)} per query  ·  ` +
      `$${(costPerQuery * 1_000_000).toFixed(2)} per 1M queries`,
  );
  console.log(`                 at $${PRICE_PER_MILLION_TOKENS.toFixed(2)} per 1M input tokens`);
} else if (tokenReads === 0) {
  console.log('  input tokens   not reported by the response - latency measured, cost not');
} else {
  console.log(
    `  input tokens   reported on ${tokenReads}/${RUNS} calls - cost not computed from a partial count`,
  );
}

console.log('');
console.log(`Done. Every call returned a ${dims}-wide vector.`);
