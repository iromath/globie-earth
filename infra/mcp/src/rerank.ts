// Listwise rerank for search_forest_knowledge (infra/mcp plan §16, decision D6).
//
// The retrieval path is deliberately LLM-free up to this point: the query is
// embedded by the small self-hosted model (Xenova/multilingual-e5-small, 384
// dims) and api.catalog_search returns the nearest passages, with a title-only
// lexical lift added by the catalog search ranking. But a 384-dim e5 model's
// cosine floor is high and its near-neighbours differ by ~0.01, so the *order*
// of the top rows is often wrong even when the right passage is present in the
// pool - the answer's first line is the wrong passage, not a missing one.
//
// This module adds one narrow, optional step - a cross-encoder-style listwise
// rerank over the candidate pool - on the same server-side model key the router
// and the vision tool already use (llm.ts; DeepSeek by default, Amazon Bedrock
// Nova when RERANK_PROVIDER=nova). It never invents content: it only *reorders*
// the rows the database returned, so a rerank can improve the answer but can
// never fabricate one (the honesty house rule, plan §1.1).
//
// Any failure - no key, timeout, non-200, malformed JSON, or an `order` that is
// not a usable permutation - returns null, and the caller keeps the cosine
// order. That is the same graceful-degradation rule the embedding provider
// follows (EMBEDDING_PROVIDER=none stays a valid configuration).

import { chat, providerConfigured, rerankTarget } from './llm.js';

// How long the rerank model may take before the search falls back to cosine.
// 20s matches the router's TIMEOUT_MS: a live production call from the VPS to
// DeepSeek measured ~9s (and the router was already tuned to 20s for the same
// path), so an 8s cap aborted every real rerank and silently kept the cosine
// order. Observed on 2026-10-11 - see plan §16.
const DEFAULT_TIMEOUT_MS = 20_000;

/** How many candidate rows are fetched before reranking, unless overridden. */
const DEFAULT_POOL = 20;

/**
 * The default latency *ceiling* for a whole search, in milliseconds. 0 = no
 * ceiling, so the rerank runs whenever it is enabled (the web client's case).
 * The Alexa+ platform requires a round-trip of **under 500 ms** (plan §20.3 gap
 * 4), which the remote rerank - measured at ~21 s end-to-end on 2026-10-15, the
 * 20 s timeout expiring and falling back to cosine - cannot possibly meet. An
 * Alexa-facing deployment therefore sets SEARCH_LATENCY_BUDGET_MS, and any
 * rerank whose own cap does not fit inside that ceiling is skipped outright, so
 * the answer comes from the in-process local-embed path instead.
 */
const DEFAULT_BUDGET_MS = 0;

/** Per-candidate content shown to the model; long passages are truncated. */
const MAX_CONTENT_CHARS = 400;

/** One passage the reranker may reorder. `HitRow` satisfies this shape. */
export interface RankableHit {
  title: string;
  content: string;
}

/** A reorder of the candidate array, always a full permutation of `0..n-1`. */
export interface RerankOutcome {
  /** Indices into the candidate array, best first. */
  order: number[];
  /** The model that produced the order, for the response's honesty field. */
  model: string;
}

/** Whether the stage is on, and the pool/timeout/budget it runs with. Read per call. */
export function rerankConfig(): {
  enabled: boolean;
  pool: number;
  timeoutMs: number;
  budgetMs: number;
} {
  const flag = (process.env.RERANK_ENABLED ?? 'true').trim().toLowerCase();
  return {
    enabled: !['false', '0', 'no', 'off'].includes(flag),
    pool: positiveInt(process.env.RERANK_POOL, DEFAULT_POOL, 2),
    timeoutMs: positiveInt(process.env.RERANK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1),
    budgetMs: positiveInt(process.env.SEARCH_LATENCY_BUDGET_MS, DEFAULT_BUDGET_MS, 0),
  };
}

function positiveInt(raw: string | undefined, fallback: number, min: number): number {
  const value = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SYSTEM_PROMPT = [
  "You rank passages by how directly each answers a listener's question, for a",
  'regenerative agroforestry site in Isaan, Thailand.',
  'You are given the question and a numbered list of candidate passages.',
  'Reply with JSON only, of the form {"order": [<candidate numbers, best first>]}.',
  'Include every candidate number exactly once.',
  'Rank by usefulness to the question: a passage that names the exact thing asked',
  'comes first, and a passage that merely shares a topic is demoted.',
  'Never add any text outside the JSON.',
].join(' ');

function userMessage(query: string, hits: RankableHit[]): string {
  const candidates = hits
    .map((hit, index) => {
      const content = hit.content.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
      return `[${index}] ${hit.title} — ${content}`;
    })
    .join('\n');
  return `Question: ${query}\n\nCandidates:\n${candidates}`;
}

/** Reads a JSON object out of the model's reply, tolerating a fenced block. */
function extractJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Turns the model's reply into a full permutation of `0..count-1`, or null when
 * the reply carries no usable order.
 *
 * A number the model repeats is ignored, a number out of range is ignored, and
 * any candidate it omitted is appended in its original position - so a rerank
 * reorders but never drops a passage, and the pool stays whole.
 */
function parseOrder(content: string, count: number): number[] | null {
  const parsed = extractJson(content);
  const raw = isRecord(parsed) && Array.isArray(parsed.order) ? parsed.order : null;
  if (!raw) return null;

  const seen = new Set<number>();
  const order: number[] = [];
  for (const value of raw) {
    const index = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) continue;
    seen.add(index);
    order.push(index);
  }
  for (let index = 0; index < count; index += 1) {
    if (!seen.has(index)) order.push(index);
  }
  return order;
}

/**
 * Reorders `hits` by how directly each answers `query`, or returns null so the
 * caller keeps the cosine order. Never throws: this stage is an enhancement, not
 * a dependency, so its failure must be invisible to the tool.
 *
 * `budgetMsOverride` is a front door's own deadline for this one call - the
 * Alexa Skill sets it from `Caller.latencyBudgetMs` - and it takes precedence
 * over the deployment-wide SEARCH_LATENCY_BUDGET_MS. That is what keeps the
 * browser host reranking while the voice front door, which Alexa abandons after
 * ~8s, skips the stage and answers from the local-embed path instead. The two
 * share one process, so the decision has to travel on the request rather than
 * on the environment.
 */
export async function rerankHits(
  query: string,
  hits: RankableHit[],
  budgetMsOverride?: number,
): Promise<RerankOutcome | null> {
  const { enabled, timeoutMs, budgetMs } = rerankConfig();
  const { provider, model } = rerankTarget();
  if (!enabled || !providerConfigured(provider) || hits.length < 2) return null;

  // Fast-path for a latency-bounded caller (the Alexa+ round-trip budget, plan
  // §20.3 gap 4 / §21 Phase 3, and now the Skill's own Caller.latencyBudgetMs).
  // The rerank is a remote model call whose hard cap is `timeoutMs`, so if that
  // cap does not fit inside the caller's ceiling the stage cannot be allowed to
  // run at all: skipping it here returns the in-process cosine order
  // immediately, instead of burning the whole ceiling and falling back anyway
  // (the ~21 s worst case reproduced live on 2026-10-15, and again on
  // 2026-10-16 when the Skill's forest answers timed out at Alexa and the
  // server returned 200 twenty seconds later). A RERANK_TIMEOUT_MS at or below
  // the budget re-enables it.
  const ceiling = budgetMsOverride ?? budgetMs;
  if (ceiling > 0 && timeoutMs > ceiling) return null;

  try {
    const result = await chat({
      provider,
      model,
      request: {
        system: SYSTEM_PROMPT,
        parts: [{ type: 'text', text: userMessage(query, hits) }],
        temperature: 0,
      },
      timeoutMs,
    });

    const order = parseOrder(result.text, hits.length);
    return order ? { order, model: result.model } : null;
  } catch {
    return null;
  }
}
