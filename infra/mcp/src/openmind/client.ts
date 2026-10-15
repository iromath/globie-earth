// A thin client for the Openmind.Travel backend REST API (bokunapi.9o9.io).
//
// This is the server-side counterpart to the browser-side WebMCP tools in the
// Openmind Travel web app. Those 36 tools wrap this same REST API; here we call
// it directly from the MCP server so an Alexa+ (or any MCP) host can drive the
// same travel catalogue over MCP instead of over a browser.
//
// The API is public (no auth required for read endpoints), so there is no
// caller identity to forward — unlike postgrest.ts which pins every row to the
// device. Write endpoints (save_trip_idea, save_itinerary) are also unauthenticated
// in the upstream app; we forward them as-is.

/** A hung upstream must not pin an Alexa+ turn forever. */
const TIMEOUT_MS = 20_000;

/** Flights stream can take up to ~90s, so it gets a much longer leash. */
const FLIGHT_TIMEOUT_MS = 110_000;

export class OpenmindError extends Error {
  /** 0 means "never reached the server", not an HTTP status. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenmindError';
    this.status = status;
  }
}

/**
 * The origin the service calls. Read from OPENMIND_API_URL, defaulting to the
 * production backend. Lazily read so /health can answer without it and so a
 * test/override can swap it at runtime.
 */
function baseUrl(): string {
  return (process.env.OPENMIND_API_URL ?? 'https://bokunapi.9o9.io').trim().replace(/\/+$/, '');
}

async function request<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const { method = 'GET', body, timeoutMs = TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${baseUrl()}${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error && e.name === 'AbortError') {
      throw new OpenmindError(`Openmind API timed out on ${path}`, 0);
    }
    throw new OpenmindError(
      `Could not reach Openmind API at ${url}: ${e instanceof Error ? e.message : String(e)}`,
      0,
    );
  }
  clearTimeout(timeout);

  if (!response.ok) {
    throw new OpenmindError(`${path} failed: HTTP ${response.status}`, response.status);
  }

  return (await response.json()) as T;
}

/** GET a JSON resource, with optional query params. */
export function openmindGet<T>(
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  let url = path;
  if (params && Object.keys(params).length > 0) {
    const usp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        usp.set(key, String(value));
      }
    }
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }
  return request<T>(url);
}

/** POST a JSON body and parse the JSON response. */
export function openmindPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body });
}

/**
 * Read an SSE stream until it closes, returning the decoded text events.
 * Used by the flight search which streams results over Server-Sent Events.
 */
export async function openmindSse<T>(
  path: string,
  onChunk: (chunk: T) => void,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLIGHT_TIMEOUT_MS);

  const url = `${baseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error && e.name === 'AbortError') {
      throw new OpenmindError(`Flight results stream timed out on ${path}`, 0);
    }
    throw new OpenmindError(
      `Could not reach Openmind flight stream: ${e instanceof Error ? e.message : String(e)}`,
      0,
    );
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    throw new OpenmindError(`Flight results stream failed: HTTP ${response.status}`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0 || eventName !== 'message') continue;

        try {
          const chunk = JSON.parse(dataLines.join('\n')) as T;
          onChunk(chunk);
        } catch {
          // Ignore malformed/empty chunks; the stream is best-effort.
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Whether the Openmind API is configured (always — it has a default). */
export function openmindConfigured(): boolean {
  return Boolean(baseUrl());
}
