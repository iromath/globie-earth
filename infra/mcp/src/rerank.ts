// Listwise rerank for search_forest_knowledge (infra/mcp plan §16, decision D6).
//
// The retrieval path is deliberately LLM-free up to this point: the query is
// embedded by the small self-hosted model (Xenova/multilingual-e5-small, 384
// dims) and api.catalog_search returns the nearest passages, with a title-only
// lexical lift added by 247_catalog_search_ranking.sql. But a 384-dim e5 model's
// cosine floor is high and its near-neighbours differ by ~0.01, so the *order*
// of the top rows is often wrong even when the right passage is present in the
// pool - the answer's first line is the wrong passage, not a missing one.
//
// This module adds one narrow, optional step - a cross-encoder-style listwise
// rerank over the candidate pool - on the same server-side DeepSeek key the
// router and the vision tool already use. It never invents content: it only
// *reorders* the rows the database returned, so a rerank can improve the answer
// but can never fabricate one (the honesty house rule, plan §1.1).
//
// Any failure - no key, timeout, non-200, malformed JSON, or an `order` that is
// not a usable permutation - returns null, and the caller keeps the cosine
// order. That is the same graceful-degradation rule the embedding provider
// follows (EMBEDDING_PROVIDER=none stays a valid configuration).

import { deepseekConfig } from './deepseek.js';

// How long the rerank model may take before the search falls back to cosine.
// 20s matches the router's TIMEOUT_MS: a live production call from the VPS to
// DeepSeek measured ~9s (and the router was already tuned to 20s for the same
// path), so an 8s cap aborted every real rerank and silently kept the cosine
// order. Observed on 2026-10-11 - see plan §16.
const DEFAULT_TIMEOUT_MS = 20_000;

/** How many candidate rows are fetched before reranking, unless overridden. */
const DEFAULT_POOL = 20;

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

/** Whether the stage is on, and the pool/timeout it runs with. Read per call. */
export function rerankConfig(): { enabled: boolean; pool: number; timeoutMs: number } {
  const flag = (process.env.RERANK_ENABLED ?? 'true').trim().toLowerCase();
  return {
    enabled: !['false', '0', 'no', 'off'].includes(flag),
    pool: positiveInt(process.env.RERANK_POOL, DEFAULT_POOL, 2),
    timeoutMs: positiveInt(process.env.RERANK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1),
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
  'reforestation sanctuary in Isaan, Thailand.',
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
 */
export async function rerankHits(
  query: string,
  hits: RankableHit[],
): Promise<RerankOutcome | null> {
  const { enabled, timeoutMs } = rerankConfig();
  const { baseUrl, model: defaultModel, apiKey } = deepseekConfig();
  if (!enabled || !apiKey || hits.length < 2) return null;

  const model = process.env.DEEPSEEK_RERANK_MODEL?.trim() || defaultModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage(query, hits) },
        ],
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) return null;
    const payload = (await upstream.json().catch(() => null)) as
      | { choices?: { message?: unknown }[] }
      | null;
    const message = payload?.choices?.[0]?.message;
    if (!isRecord(message) || typeof message.content !== 'string') return null;

    const order = parseOrder(message.content, hits.length);
    return order ? { order, model } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
