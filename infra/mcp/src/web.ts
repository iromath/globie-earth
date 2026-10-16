// Live web search, through Tavily's REST API.
//
// The same honest-fetch shape as src/wiki.ts and src/conditions.ts: one bounded
// POST, null on any failure, so a caller reports what it could not read rather
// than inventing an answer (house rule, AMAZON-MCP-PLAN.md 1.1). Tavily returns
// other people's pages, so every result keeps its own URL and the caller says
// the source is the open web - never Globie's own verified record.
//
// The key is read from TAVILY_API_KEY (infra/.env, git-ignored). When it is
// absent the request falls back to Tavily's keyless access mode, which needs no
// key and is rate-limited; when it is present the key is sent as the bearer
// token and the keyless header is left off, because asking for keyless while
// holding a key would spend the rate-limited pool for nothing.

/** A hung request must not pin an Alexa+ turn. */
const TIMEOUT_MS = 10000;

const API_URL = 'https://api.tavily.com/search';

/** Bounded so a voice answer never carries a wall of links. */
const MAX_RESULTS = 5;

/** One web result, reduced to what a card or a spoken line can use. */
export interface WebHit {
  title: string;
  url: string;
  /** Tavily's cleaned snippet of the page. */
  content: string;
  /** Tavily's own relevance score in [0,1], or null when it sent none. */
  score: number | null;
}

export interface WebAnswer {
  /** The query Tavily actually ran, echoed back for the card's heading. */
  query: string;
  /** Tavily's synthesised answer over the results, or null when it made none. */
  answer: string | null;
  hits: WebHit[];
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  query?: string;
  answer?: string;
  results?: TavilyResult[];
}

/** Collapses whitespace so a snippet reads as one line in a card or by ear. */
function line(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The top web results for a query, or null when Tavily answered nothing or the
 * request could not be read. Results without a title or an http(s) URL are
 * dropped, because a card cannot link to them and a spoken line cannot name
 * them.
 */
export async function searchWeb(query: string, maxResults = MAX_RESULTS): Promise<WebAnswer | null> {
  const q = query.trim();
  if (!q) return null;

  const key = process.env.TAVILY_API_KEY?.trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  } else {
    headers['X-Tavily-Access-Mode'] = 'keyless';
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers,
      // `basic` depth and a small result count keep the turn inside the voice
      // budget; the synthesised answer is what a spoken turn leans on.
      body: JSON.stringify({
        query: q,
        max_results: Math.min(Math.max(maxResults, 1), MAX_RESULTS),
        search_depth: 'basic',
        include_answer: 'basic',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as TavilyResponse;
    const hits = (data.results ?? [])
      .map(
        (result): WebHit => ({
          title: line(result.title),
          url: (result.url ?? '').trim(),
          content: line(result.content),
          score: typeof result.score === 'number' ? result.score : null,
        }),
      )
      .filter((hit) => hit.title && /^https?:\/\//i.test(hit.url));

    // No usable result is the same dead end as a failed request: the caller
    // reports that nothing came back rather than an empty list.
    if (!hits.length) return null;

    return { query: line(data.query) || q, answer: line(data.answer) || null, hits };
  } catch {
    // Offline, blocked or timed out: the caller reports what it could not read.
    return null;
  }
}
