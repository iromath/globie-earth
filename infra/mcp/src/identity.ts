// Who is calling, resolved from the request headers at the MCP edge.
//
// Globie Earth has two credentials (Dev-Docs/Amazon/AMAZON-MCP-PLAN.md 6):
//
//   - X-Device-Id: a uuid, also the RevenueCat appUserID. The RPCs read it as
//     their identity via private.device_id(), and 030_rls.sql pins every
//     device-scoped row to it.
//   - Authorization: Bearer <GoTrue JWT>: the optional account credential that
//     070_accounts.sql matches. A device-only caller omits it.
//
// A raw MCP client (the Alexa+ host, a curl client, a small web demo) will not
// mint a GoTrue JWT just to try the server, so the demo accepts a static bearer
// token that stands in for a device identity (decision D4). That is stated
// honestly in the README rather than presented as OAuth: production should use
// the MCP OAuth 2.1 flow, which is not built here.

import { timingSafeEqual } from 'node:crypto';

export interface Caller {
  /** Always sent: the RPCs derive the caller from this header. */
  deviceId: string;
  /** A GoTrue JWT, forwarded so the account policies apply. Never our own token. */
  bearer?: string;
}

/** The schema's own length, so a bad id is rejected before it reaches Postgres. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HeaderValue = string | string[] | undefined;

function first(value: HeaderValue): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || null;
}

/** Constant-time, and false when lengths differ - which is not a leak here. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The caller, or null when the request carries no acceptable credential.
 *
 * A well-formed X-Device-Id is honoured on its own, which keeps the existing
 * device-only clients working unchanged. Otherwise the static demo token is
 * exchanged for MCP_DEMO_DEVICE_ID - the "exchange at the edge" in D4.
 */
export function resolveCaller(headers: Record<string, HeaderValue>): Caller | null {
  const deviceHeader = first(headers['x-device-id']);
  const authorization = first(headers.authorization);
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;

  const staticToken = process.env.MCP_BEARER_TOKEN?.trim() || null;
  const isStaticToken = Boolean(token && staticToken && sameSecret(token, staticToken));

  if (deviceHeader && UUID.test(deviceHeader)) {
    // Our own token is an MCP-edge credential, not a GoTrue JWT - forwarding it
    // to PostgREST would just make it reject the request.
    return {
      deviceId: deviceHeader,
      ...(token && !isStaticToken ? { bearer: token } : {}),
    };
  }

  if (isStaticToken) {
    const demoDevice = process.env.MCP_DEMO_DEVICE_ID?.trim() || '';
    if (UUID.test(demoDevice)) return { deviceId: demoDevice };
    // Configured but unusable: say so by refusing rather than guessing an id.
    return null;
  }

  return null;
}
