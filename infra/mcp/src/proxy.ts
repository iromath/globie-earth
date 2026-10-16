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
// Gemini and Podcast Index credentials; this server never holds either.

import type { Caller } from './identity.js';
import { ensureDevice } from './postgrest.js';

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

/**
 * The env var each service's *public* origin is read from, when it differs from
 * the origin this server calls. The call origin is often a compose service name
 * (`http://studio:8080`) that no listener can reach, while the public one
 * (`https://studio.globie.earth`) is what a browser or a device fetches from.
 */
const PUBLIC_ORIGIN_VAR: Record<ProxyService, string> = {
  studio: 'STUDIO_PUBLIC_URL',
  podcast: 'PODCAST_PUBLIC_URL',
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

/**
 * Turns a service-relative URL into a full one a listener can fetch.
 *
 * The proxies answer with paths relative to themselves - `get_soundscape` reads
 * the studio's `audioUrl`, which studio/src/server.ts keeps relative on purpose
 * because the proxy does not know its own public origin. A browser resolves that
 * path against the studio's public origin; this server knows the origin, so it
 * can hand any host - Alexa+ included - a URL that needs no such mapping. An
 * already-absolute URL is returned untouched, and with no public origin
 * configured the path is left relative for the client to resolve as before.
 */
export function publicUrl(service: ProxyService, path: string | null): string | null {
  if (!path) return null;
  // Any scheme (`https://…`, `s3://…`) means someone already made it absolute.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const publicOrigin = process.env[PUBLIC_ORIGIN_VAR[service]]?.trim().replace(/\/+$/, '');
  if (!publicOrigin) return path;
  try {
    return new URL(path, `${publicOrigin}/`).toString();
  } catch {
    return path;
  }
}

/**
 * Builds the absolute https URL a device fetches for itself.
 *
 * This exists for an Echo's AudioPlayer, which has no page to resolve a relative
 * path against and no way to hold an X-Device-Id. `publicUrl` already resolves
 * against the public origin, but leaves the path relative when none is
 * configured - fine for the browser, which maps the host itself
 * (mcp-client/src/main.ts), and useless for a player. So this falls back to the
 * call origin when that origin is itself https, which is the case in this stack
 * (STUDIO_URL is already https://studio.globie.earth), and raises otherwise: a
 * stream that cannot be fetched is a configuration error worth naming, not a
 * silence to debug on the device.
 */
export function absoluteUrl(service: ProxyService, path: string | null): string | null {
  if (!path) return null;
  if (/^https:\/\//i.test(path)) return path;
  const resolved = publicUrl(service, path);
  if (resolved && /^https:\/\//i.test(resolved)) return resolved;
  const callOrigin = process.env[ORIGIN_VAR[service]]?.trim().replace(/\/+$/, '');
  if (callOrigin && /^https:\/\//i.test(callOrigin)) {
    try {
      return new URL(path, `${callOrigin}/`).toString();
    } catch {
      // Fall through to the error below.
    }
  }
  throw new ProxyError(
    `${service} has no https origin, so no playable URL can be built. Set ` +
      `${PUBLIC_ORIGIN_VAR[service]} (or an https ${ORIGIN_VAR[service]}) - see infra/.env.example.`,
    0,
  );
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

  // Both proxies refuse a device they have never seen - their requireDevice
  // answers 401 "That device has not been registered by this app." - and they
  // are right to, because the web clients register themselves on first launch.
  // A voice caller cannot: its device id is derived from the Amazon userId
  // (deviceIdFor in alexa.ts) rather than created by an app, so it has no row
  // and every call would fail - the studio's soundscapes and the podcast
  // library alike. Registering it first is the same lazy insert the app's own
  // RPCs already do (infra/schema/090_starting_grant.sql).
  if (service === 'studio' || service === 'podcast') await ensureDevice(caller);

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
