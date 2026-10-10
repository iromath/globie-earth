// A thin client for the `studio` and `podcast` proxy services that sit beside
// this one in the stack (infra/docker-compose.yml).
//
// Neither proxy understands a Bearer token: both authenticate a caller on
// X-Device-Id alone and then apply their own ownership rules (a track belongs
// to the device that queued it). So this forwards the caller's own device id -
// the same identity the rest of the stack already trusts - and nothing else.
//
// Both answer errors as `{ error: string }`, not PostgREST's `{ message }`, so
// the message is read from that field and raised as-is. The proxies own the
// Suno and Podcast Index credentials; this server never holds either.

import type { Caller } from './identity.js';

/** A hung proxy must not pin an Alexa+ turn forever. */
const TIMEOUT_MS = 10000;

export class ProxyError extends Error {
  /** 0 means "never reached the service", not an HTTP status. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
  }
}

/** The two proxies this server calls, by the name used in messages. */
export type ProxyService = 'studio' | 'podcast';

/** The env var each service's origin is read from, mirroring POSTGREST_URL. */
const ORIGIN_VAR: Record<ProxyService, string> = {
  studio: 'STUDIO_URL',
  podcast: 'PODCAST_URL',
};

/** Read lazily, so /health can answer without either origin configured. */
function origin(service: ProxyService): string {
  const name = ORIGIN_VAR[service];
  const value = process.env[name]?.trim().replace(/\/+$/, '');
  if (!value) {
    throw new ProxyError(
      `${name} is not set, so the ${service} tools cannot reach their service. ` +
        'Set it to the matching origin - see infra/.env.example.',
      0,
    );
  }
  return value;
}

interface ProxyRequest {
  method?: 'GET' | 'POST';
  body?: unknown;
}

/** Calls a proxy and returns its parsed JSON, surfacing the proxy's own error text. */
export async function callProxy<T>(
  service: ProxyService,
  path: string,
  caller: Caller,
  options: ProxyRequest = {},
): Promise<T> {
  // Resolved before the try: an unset origin is a configuration error with its
  // own message, not a network failure to be re-worded.
  const url = `${origin(service)}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        // The device credential, exactly as the web clients send it.
        'X-Device-Id': caller.deviceId,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProxyError(`Could not reach the ${service} service: ${reason}`, 0);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const message =
      (parsed as { error?: string } | undefined)?.error ??
      `The ${service} service answered ${response.status}.`;
    throw new ProxyError(message, response.status);
  }

  return parsed as T;
}
