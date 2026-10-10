// The embedding provider, behind one interface.
//
// api.embeddings.embedding is vector(384) (infra/schema/180_embeddings_local.sql)
// and api.catalog_search takes a *caller-computed* query vector
// (infra/schema/040_functions.sql), so this service is the only place that needs
// to turn text into a vector.
//
// Two providers, each with its own vector space:
//
//   local   - intfloat/multilingual-e5-small through transformers.js (ONNX),
//             384 dims, CPU only. Needs no account and bills nothing, so it is
//             the default and the one that always runs.
//   bedrock - Amazon Titan Text Embeddings V1, 1536 dims. Kept for the AWS
//             Builder story; it needs an AWS account whose Bedrock data plane is
//             not gated, and api.embeddings migrated back to vector(1536).
//
// One rule the code cannot enforce: the catalogue rows must be produced by the
// *same* model as the queries, or cosine similarity is comparing two unrelated
// spaces. 060_seed_catalog.sql deliberately ships no embeddings, so this is a
// fresh choice rather than a swap - and until a backfill runs with this exact
// provider, catalog_search honestly returns nothing.

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * How the text will be used. An e5-class model is trained with an asymmetric
 * prefix - `query: ` for what someone asks, `passage: ` for what is stored -
 * and omitting it measurably hurts retrieval. A model with no such convention
 * (Titan) ignores it.
 */
export type EmbedKind = 'query' | 'passage';

/** The width of api.embeddings.embedding; catalog_search compares against it. */
export const EMBEDDING_DIMS = 384;

/** The local model: multilingual (Thai + English), 384 dims, ~118 MB quantised. */
export const LOCAL_MODEL = 'Xenova/multilingual-e5-small';

/** Titan V1 is fixed at 1536 dimensions. */
const TITAN_V1 = 'amazon.titan-embed-text-v1';
const TITAN_DIMS = 1536;

export interface EmbeddingProvider {
  /** Which provider this is, so /health names the one actually running. */
  readonly name: 'local' | 'bedrock';
  /** The model id, so a stored vector's provenance is never guessed. */
  readonly model: string;
  /** The width the catalogue rows must share. */
  readonly dims: number;
  embed(text: string, kind?: EmbedKind): Promise<number[]>;
}

/** One embedding, plus the input tokens the provider reports (for cost). */
export interface EmbeddingUsage {
  vector: number[];
  /** Input tokens billed for this call, or null when the model bills none. */
  inputTokens: number | null;
}

/** A provider plus the usage-aware call the backfill and the bench measure. */
interface ProviderImpl extends EmbeddingProvider {
  usage(text: string, kind: EmbedKind): Promise<EmbeddingUsage>;
}

// ---------------------------------------------------------------- bedrock ---

/**
 * Bedrock is called with credentials from the container environment.
 *
 * Running off AWS (decision D2) means no instance role can be assumed, so the
 * SDK reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from env, exactly as
 * infra/.env.example documents. An instance role remains the production path.
 */
let client: BedrockRuntimeClient | null = null;

function bedrockClient(): BedrockRuntimeClient {
  // Built lazily so a health check can report the provider without the region
  // being set - the failure belongs to the one call that needs it.
  return (client ??= new BedrockRuntimeClient({
    region: process.env.BEDROCK_REGION?.trim() || process.env.AWS_REGION?.trim() || undefined,
  }));
}

async function bedrockUsage(text: string): Promise<EmbeddingUsage> {
  const response = await bedrockClient().send(
    new InvokeModelCommand({
      modelId: TITAN_V1,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text }),
    }),
  );

  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding?: unknown;
    inputTextTokenCount?: unknown;
  };

  if (
    !Array.isArray(payload.embedding) ||
    payload.embedding.length !== TITAN_DIMS ||
    !payload.embedding.every((value) => typeof value === 'number')
  ) {
    throw new Error(
      `Bedrock returned an embedding that is not ${TITAN_DIMS} numbers, so it ` +
        'cannot be compared against api.embeddings. Check that ' +
        `${TITAN_V1} is enabled in BEDROCK_REGION, and that the schema is still ` +
        'vector(1536) - 180_embeddings_local.sql moved it to 384 for the local model.',
    );
  }

  return {
    vector: payload.embedding as number[],
    inputTokens:
      typeof payload.inputTextTokenCount === 'number' ? payload.inputTextTokenCount : null,
  };
}

function bedrockProvider(): ProviderImpl {
  return {
    name: 'bedrock',
    model: TITAN_V1,
    dims: TITAN_DIMS,

    async embed(text: string): Promise<number[]> {
      return (await bedrockUsage(text)).vector;
    },

    // Titan reports the input tokens it billed, so the count passes straight
    // through to the scripts' cost column. It has no query/passage convention,
    // so `kind` is deliberately ignored.
    usage: (text: string) => bedrockUsage(text),
  };
}

// ------------------------------------------------------------------ local ---

/** The subset of transformers.js this provider uses, so the import stays lazy. */
type TextEmbedder = (
  text: string,
  options: { pooling: 'mean'; normalize: true },
) => Promise<{ data: Float32Array }>;

let embedder: Promise<TextEmbedder> | null = null;

/**
 * The model, loaded once on first use.
 *
 * transformers.js is imported dynamically on purpose: ONNX Runtime is a heavy
 * native module, and the bedrock and none providers must neither pay for it at
 * startup nor depend on it being present.
 */
function localEmbedder(): Promise<TextEmbedder> {
  return (embedder ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Where the quantised weights are cached. The image bakes this directory,
    // so a running container never downloads a model.
    env.cacheDir = process.env.EMBEDDING_CACHE_DIR?.trim() || '.cache';
    const extract = await pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'q8' });
    return extract as unknown as TextEmbedder;
  })());
}

function localProvider(): ProviderImpl {
  const embed = async (text: string, kind: EmbedKind = 'query'): Promise<number[]> => {
    const run = await localEmbedder();
    // e5 wants the prefix as its own word, then a space, then the text.
    const output = await run(`${kind}: ${text}`, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data);
    if (vector.length !== EMBEDDING_DIMS) {
      throw new Error(
        `the local model returned ${vector.length} numbers, not ${EMBEDDING_DIMS}, ` +
          'so it cannot be compared against api.embeddings.',
      );
    }
    return vector;
  };

  return {
    name: 'local',
    model: LOCAL_MODEL,
    dims: EMBEDDING_DIMS,
    embed,
    // A local model bills nothing, so there are no tokens to report.
    usage: async (text: string, kind: EmbedKind) => ({ vector: await embed(text, kind), inputTokens: null }),
  };
}

let resolved: ProviderImpl | null | undefined;

/**
 * The embedding provider, or null when semantic search is switched off.
 *
 * EMBEDDING_PROVIDER=local (the default) runs the model in-process, `bedrock`
 * uses Amazon Titan V1, and `none` switches semantic search off. `none` is a
 * valid configuration, not a broken one: search_forest_knowledge then answers
 * with an explanation and every other tool keeps working.
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (resolved === undefined) {
    const name = (process.env.EMBEDDING_PROVIDER ?? 'local').trim().toLowerCase();
    resolved = name === 'none' ? null : name === 'bedrock' ? bedrockProvider() : localProvider();
  }
  return resolved;
}

/**
 * The provider's raw call: one embedding, plus the input tokens when the model
 * reports them. Shared by scripts/backfill-embeddings.mjs and
 * scripts/bench-embed.mjs - so both measure this exact request and validation
 * rather than a copy that could drift away from it.
 */
export async function embedWithUsage(
  text: string,
  kind: EmbedKind = 'query',
): Promise<EmbeddingUsage> {
  const provider = getEmbeddingProvider();
  if (!provider) {
    throw new Error('EMBEDDING_PROVIDER=none, so there is no model to embed with.');
  }
  return (provider as ProviderImpl).usage(text, kind);
}
