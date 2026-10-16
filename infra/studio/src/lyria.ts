// The Gemini (Lyria) music provider, reached from the server only.
//
// This replaces the previous Suno module. Suno was asynchronous - enqueue a
// task, poll a record, optionally extend - and signalled failures inside a 200
// body. Lyria is a single synchronous call that returns the audio inline as
// base64, and it uses ordinary HTTP status codes. So the surface here is much
// smaller: buildPrompt, generate, probeProvider, excerpt, detectFormat.
//
// It knows nothing about the database or the filesystem.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** The pinned model: a full song, ~$0.08, MP3 out. See the plan's decision 2. */
export const DEFAULT_MODEL = 'lyria-3.5';

/** A burst limit is worth retrying; a rejected key or a disabled API is not. */
export const RETRYABLE = new Set([429, 500, 502, 503, 504]);
export const FATAL = new Set([400, 401, 403, 404]);
export const BACKOFF_MS = [1000, 3000, 8000];

/** A health answer that takes longer than this is a health answer of "down". */
const PROBE_TIMEOUT_MS = 5_000;

/** Generation is one long request, so it gets far more room than a JSON call. */
const GENERATE_TIMEOUT_MS = 180_000;

export type ProviderState = 'up' | 'down';

/**
 * A failure the caller is expected to record rather than retry.
 *
 * `fatal` separates "this will never work" (a rejected key, a malformed
 * request, a disabled API) from "the provider was briefly unavailable". Both
 * end a job, so the flag is for the log line and the error text the device is
 * shown, not for control flow.
 */
export class LyriaError extends Error {
  readonly fatal: boolean;

  constructor(message: string, fatal = false) {
    super(message);
    this.name = 'LyriaError';
    this.fatal = fatal;
  }
}

export interface GenerateRequest {
  prompt: string;
  style: string;
  instrumental: boolean;
  model: string;
}

export interface GeneratedAudio {
  audio: Buffer;
  format: 'mp3' | 'm4a';
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new LyriaError('GEMINI_API_KEY is not set.', true);
  return key;
}

/** A one-line, length-bounded excerpt. Never includes the request headers. */
export function excerpt(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Folds the Studio's fields into the single text blob Lyria reads.
 *
 * Lyria has no `customMode` equivalent: it always interprets one prompt through
 * its own framework (genre & style, then mood/instrumentation/tempo). So the
 * chips lead, the free-text brief follows, and the literal word "instrumental"
 * is appended to suppress vocals. `title` is deliberately not included: it is
 * derived from the brief's first line, so folding it in would duplicate that
 * phrase. See the plan's §5.
 */
export function buildPrompt(input: Omit<GenerateRequest, 'model'>): string {
  const clauses = [input.style.trim(), input.prompt.trim()];
  if (input.instrumental) clauses.push('Instrumental — no vocals, no lyrics.');
  return clauses.filter(Boolean).join(' ');
}

/**
 * One authenticated call, with the retry policy applied to the status code.
 *
 * Unlike the vendor this replaces, Google signals failures with a real HTTP
 * status, so a 2xx is proof of success and no body-`code` check is needed.
 * Kept private: callers should be thinking in terms of generate, not HTTP.
 */
async function call(url: string, body: unknown, timeoutMs = GENERATE_TIMEOUT_MS): Promise<unknown> {
  let lastDetail = 'no attempt was made';

  for (let attempt = 1; attempt <= BACKOFF_MS.length + 1; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A timeout or a DNS failure is exactly the kind of thing the backoff is
      // for. It is not fatal, so it is retried like a 5xx.
      lastDetail = error instanceof Error ? error.message : String(error);
      if (attempt > BACKOFF_MS.length) {
        throw new LyriaError(`Gemini was unreachable after ${attempt} attempts. ${lastDetail}`);
      }
      await sleep(BACKOFF_MS[attempt - 1]);
      continue;
    }

    if (response.ok) return (await response.json()) as unknown;

    lastDetail = `${response.status} ${response.statusText}: ${excerpt(await response.text())}`;
    if (!RETRYABLE.has(response.status) || attempt > BACKOFF_MS.length) {
      throw new LyriaError(
        FATAL.has(response.status)
          ? `Gemini rejected the request. ${lastDetail}`
          : `Gemini gave up after ${attempt} attempts. ${lastDetail}`,
        FATAL.has(response.status),
      );
    }

    await sleep(BACKOFF_MS[attempt - 1]);
  }

  throw new LyriaError(`Gemini gave up. ${lastDetail}`);
}

/**
 * Whether the provider would accept a generation request right now.
 *
 * There is no credits endpoint to read, so this is a key + model reachability
 * check: it validates both that the key is accepted and that the pinned model
 * id is real. Anything that is not a 200 - including no key at all - is "down".
 */
export async function probeProvider(): Promise<ProviderState> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return 'down';

  try {
    const response = await fetch(`${BASE}/models/${encodeURIComponent(DEFAULT_MODEL)}`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

/**
 * Generates one clip and returns its bytes, decoded from the inline base64.
 *
 * The docs are explicit that the text (lyrics) parts and the audio part are not
 * in a fixed order, so every part is scanned and the last `inlineData` seen is
 * used - never assume the audio is the first part.
 */
export async function generate(input: GenerateRequest): Promise<GeneratedAudio> {
  const model = input.model.trim() || DEFAULT_MODEL;
  const payload = (await call(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    contents: [{ parts: [{ text: buildPrompt(input) }] }],
  })) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
  };

  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  let encoded: string | null = null;
  for (const part of parts) {
    const data = part?.inlineData?.data;
    if (typeof data === 'string' && data.length > 0) encoded = data;
  }

  if (!encoded) {
    throw new LyriaError(
      `Gemini returned no audio for the prompt. Parts seen: ${excerpt(
        parts.map((part) => Object.keys(part ?? {}).join('|')).join(', ') || 'none',
      )}`,
    );
  }

  const audio = Buffer.from(encoded, 'base64');
  const format = detectFormat(audio);
  if (!format) {
    throw new LyriaError(
      `The returned audio was not a recognised format (${audio.length} bytes). Nothing was saved.`,
    );
  }
  return { audio, format };
}

/**
 * The container, or null when the bytes are not audio at all - so a JSON error
 * body is rejected rather than saved as a track. The `m4a` branch is kept as a
 * guard even though Lyria's default output is MP3.
 */
export function detectFormat(buffer: Buffer): 'mp3' | 'm4a' | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'mp3'; // "ID3"
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a'; // ISO base media box
  return null;
}
