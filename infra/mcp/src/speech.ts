// The voice cascade's ears and mouth: /voice/transcribe and /voice/speak.
//
// DeepSeek ships no audio surface at all, so "Ask the forest by voice" is a
// composed loop rather than one model: the browser records an utterance, this
// server turns it into text with Whisper (STT), the router sends that text to
// DeepSeek, and the reply comes back as speech from Kokoro (TTS). Both halves
// live in the `speech` service (Speaches), which speaks OpenAI-compatible HTTP,
// so the MCP server is a thin relay.
//
// The browser never calls `speech` directly. It posts to these two routes, and
// they hold the only two things the page must not have:
//
//   - the caller's identity check, shared with /mcp and /route, so an anonymous
//     poster cannot use this server as a free STT/TTS relay;
//   - the cascade's endpoint and model names, which therefore never reach the
//     shipped bundle (Vite inlines every VITE_ variable, so anything the page
//     knows is public).
//
// This is the free, private, unlimited alternative to a native realtime vendor
// (OpenAI Realtime, Gemini Live) - no per-minute bill and no audio leaving this
// machine. The cost is that it is a cascade, not one model: the turnaround is
// the sum of its parts rather than a single streaming generation.
//
// Weights are not baked into the Speaches image. A request for a model that has
// not been fetched yet answers 404 "is not installed locally", so these routes
// install it themselves and retry once - the first utterance after a cold start
// is slow, and every later one is not. That is deliberate: it means a fresh
// clone works without an out-of-band download step.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { resolveCaller } from './identity.js';

/** The cascade's configuration, read per request so an env change needs no restart. */
export interface SpeechConfig {
  /** The Speaches base URL, or null when the cascade is not configured. */
  url: string | null;
  /** The Whisper model behind /voice/transcribe. */
  sttModel: string;
  /** The Kokoro model behind /voice/speak. */
  ttsModel: string;
  /** The voice Kokoro speaks with. */
  ttsVoice: string;
}

/** How long a transcription or synthesis may take before the route gives up. */
const CALL_TIMEOUT_MS = 120_000;

/** How long a one-time model download may take. Weights are hundreds of MB. */
const INSTALL_TIMEOUT_MS = 300_000;

/** A recording this long is a mistake; base64 makes it longer on the wire. */
const MAX_AUDIO_CHARS = 8_000_000;

/**
 * The cascade's settings, with the same defaults compose passes through. A
 * missing SPEECH_URL is a valid configuration, not a broken one - exactly as
 * EMBEDDING_PROVIDER=none keeps semantic search a valid configuration - it just
 * makes the two routes answer 503 and leaves the rest of the MCP surface alone.
 */
export function speechConfig(): SpeechConfig {
  return {
    url: process.env.SPEECH_URL?.trim().replace(/\/+$/, '') || null,
    // Multilingual, not `base.en`: the DNP reference tables carry Thai
    // (thai_name, protected_area, provinces), and an English-only model cannot
    // output those characters at all, so a spoken Thai name never reaches the
    // query (plan §17.3). Same size class as `base.en`; `small` and
    // `large-v3-turbo` are one-line upgrades once the container's RAM allows.
    sttModel: process.env.SPEECH_STT_MODEL?.trim() || 'Systran/faster-whisper-base',
    ttsModel: process.env.SPEECH_TTS_MODEL?.trim() || 'speaches-ai/Kokoro-82M-v1.0-ONNX',
    ttsVoice: process.env.SPEECH_TTS_VOICE?.trim() || 'af_heart',
  };
}

/** Whether the voice routes can serve, and with what - for /health. */
export function speechHealth(): {
  configured: boolean;
  sttModel: string;
  ttsModel: string;
  voice: string;
} {
  const { url, sttModel, ttsModel, ttsVoice } = speechConfig();
  return { configured: url !== null, sttModel, ttsModel, voice: ttsVoice };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `fetch` with a deadline, so a hung cascade cannot hold the request open. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Installs a model into the running Speaches container.
 *
 * The weights are downloaded on demand, so the very first request for a model
 * is a 404 rather than a result. `POST /v1/models/{id}` with the model id
 * URL-encoded is the install endpoint - verified against the image, where
 * `POST /v1/models/Systran%2Ffaster-whisper-base` answers 200
 * `Model '…' downloaded`.
 */
async function installModel(cfg: SpeechConfig, model: string, log: FastifyInstance['log']): Promise<boolean> {
  const url = `${cfg.url}/v1/models/${encodeURIComponent(model)}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { method: 'POST' }, INSTALL_TIMEOUT_MS);
  } catch (error) {
    log.error({ err: error, model }, 'speech: model install request failed');
    return false;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log.error({ status: response.status, model }, 'speech: model install was refused');
    return false;
  }
  log.info({ model }, 'speech: model installed');
  return true;
}

/** The multipart body Speaches' transcription endpoint expects. */
function multipartBody(
  parts: { name: string; value: string | Buffer; filename?: string; contentType?: string }[],
  boundary: string,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const headers = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}`,
      ...(part.contentType ? [`Content-Type: ${part.contentType}`] : []),
      '',
      '',
    ].join('\r\n');
    chunks.push(Buffer.from(headers, 'utf8'));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

/** A filename extension Whisper can infer from, so the part is well-formed. */
function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'audio/webm':
      return '.webm';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/mp4':
      return '.m4a';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    default:
      return '.bin';
  }
}

/**
 * The browser sends the recording as a data URL (`data:audio/webm;base64,…`) or
 * as bare base64, in a JSON body - the same shape /route uses for an attached
 * image, and one Fastify already parses. Returns the bytes and the content type
 * so the relayed multipart part is labelled correctly.
 */
function parseAudioInput(value: string): { buffer: Buffer; contentType: string } | null {
  const match = /^data:(audio\/[\w.+-]+);base64,(.+)$/is.exec(value.trim());
  if (match) {
    const buffer = Buffer.from(match[2], 'base64');
    return buffer.length ? { buffer, contentType: match[1] } : null;
  }
  const buffer = Buffer.from(value.trim(), 'base64');
  return buffer.length ? { buffer, contentType: 'audio/webm' } : null;
}

/**
 * The two voice routes, gated by the same identity /mcp and /route require.
 *
 * Without the gate this would be an open relay to this server's CPU: any
 * anonymous poster could make it transcribe and synthesise on demand. The
 * browser host always holds a device id - it cannot connect to /mcp without one
 * - so the gate costs it nothing.
 */
export function registerSpeechRoutes(app: FastifyInstance): void {
  const callerGuard = (headers: Record<string, string | string[] | undefined>): boolean =>
    resolveCaller(headers) !== null;

  const CALLER_NEEDED =
    'The voice routes need a caller identity: the same X-Device-Id (or demo ' +
    'Authorization bearer) that /mcp accepts. See infra/mcp/README.md.';

  const NOT_CONFIGURED =
    'The voice cascade is not configured. Set SPEECH_URL to the speech service ' +
    '(http://speech:8000 inside the compose network) in the MCP server environment.';

  // The ears. Audio in, text out.
  app.post('/voice/transcribe', async (request, reply) => {
    if (!callerGuard(request.headers)) return reply.code(401).send({ error: CALLER_NEEDED });

    const cfg = speechConfig();
    if (!cfg.url) return reply.code(503).send({ error: NOT_CONFIGURED });

    const body: unknown = request.body;
    if (!isRecord(body) || typeof body.audio !== 'string' || !body.audio.trim()) {
      return reply.code(400).send({ error: 'The transcribe body must be { audio: string } - base64 audio or an audio data URL.' });
    }
    if (body.audio.length > MAX_AUDIO_CHARS) {
      return reply.code(413).send({ error: 'That recording is too large to transcribe.' });
    }
    const audio = parseAudioInput(body.audio);
    if (!audio) {
      return reply.code(400).send({ error: 'The transcribe body carried no decodable audio.' });
    }

    // Fresh body each attempt: a consumed Request body cannot be sent twice,
    // and the retry after a cold install needs to send the same bytes again.
    const attempt = (): Promise<Response> => {
      const boundary = `----globie${randomUUID().replace(/-/g, '')}`;
      const payload = multipartBody(
        [
          { name: 'file', value: audio.buffer, filename: `audio${extensionFor(audio.contentType)}`, contentType: audio.contentType },
          { name: 'model', value: cfg.sttModel },
        ],
        boundary,
      );
      return fetchWithTimeout(
        `${cfg.url}/v1/audio/transcriptions`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body: payload,
        },
        CALL_TIMEOUT_MS,
      );
    };

    let upstream: Response;
    try {
      upstream = await attempt();
      // 404 here is the cold-start case: the model has not been fetched yet. The
      // route installs it and retries once rather than failing the first ever
      // utterance - which is what makes a fresh clone work with no setup step.
      if (upstream.status === 404 && (await installModel(cfg, cfg.sttModel, request.log))) {
        upstream = await attempt();
      }
    } catch (error) {
      request.log.error({ err: error }, 'speech: transcribe failed');
      return reply.code(502).send({ error: `The speech service could not be reached at ${cfg.url}.` });
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      request.log.error({ status: upstream.status }, 'speech: transcribe returned an error');
      return reply.code(502).send({
        error: `The speech service returned ${upstream.status} for transcription. ${detail.slice(0, 300)}`.trim(),
      });
    }

    const payload = (await upstream.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      return reply.code(502).send({ error: 'The speech service transcribed no text from that recording.' });
    }
    // The model is echoed back so the host can say honestly which ears it used.
    return reply.send({ text, model: cfg.sttModel });
  });

  // The mouth. Text in, audio out.
  app.post('/voice/speak', async (request, reply) => {
    if (!callerGuard(request.headers)) return reply.code(401).send({ error: CALLER_NEEDED });

    const cfg = speechConfig();
    if (!cfg.url) return reply.code(503).send({ error: NOT_CONFIGURED });

    const body: unknown = request.body;
    if (!isRecord(body) || typeof body.text !== 'string' || !body.text.trim()) {
      return reply.code(400).send({ error: 'The speak body must be { text: string }.' });
    }
    // The same ceiling the router applies to an utterance: a reply read aloud is
    // a sentence or two, not an essay, and an unbounded one is a mistake.
    const text = body.text.trim().slice(0, 2000);

    const attempt = (): Promise<Response> =>
      fetchWithTimeout(
        `${cfg.url}/v1/audio/speech`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: text,
            model: cfg.ttsModel,
            voice: cfg.ttsVoice,
            response_format: 'mp3',
          }),
        },
        CALL_TIMEOUT_MS,
      );

    let upstream: Response;
    try {
      upstream = await attempt();
      if (upstream.status === 404 && (await installModel(cfg, cfg.ttsModel, request.log))) {
        upstream = await attempt();
      }
    } catch (error) {
      request.log.error({ err: error }, 'speech: speak failed');
      return reply.code(502).send({ error: `The speech service could not be reached at ${cfg.url}.` });
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      request.log.error({ status: upstream.status }, 'speech: speak returned an error');
      return reply.code(502).send({
        error: `The speech service returned ${upstream.status} for speech synthesis. ${detail.slice(0, 300)}`.trim(),
      });
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    if (!audio.length) {
      return reply.code(502).send({ error: 'The speech service synthesised no audio.' });
    }
    return reply
      .header('Content-Type', 'audio/mpeg')
      // The reply is a one-off utterance; caching it would serve stale wording.
      .header('Cache-Control', 'no-store')
      .send(audio);
  });
}
