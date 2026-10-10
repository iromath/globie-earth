// A thin client for the Globie Earth PostgREST API.
//
// The MCP server talks HTTP to PostgREST rather than opening its own Postgres
// connection on purpose. The RPCs derive the caller from the X-Device-Id header
// (private.device_id(), infra/schema/040_functions.sql) and 030_rls.sql pins
// every device-scoped row to it; forwarding the caller's own headers is what
// makes that identity model hold. A direct connection as the migration role -
// the way `studio` reads api.studio_tracks - would bypass RLS and force every
// tool to re-scope by device itself, which is exactly the bug RLS prevents.
//
// Signing in adds an optional GoTrue JWT on top (070_accounts.sql); it is
// forwarded untouched, never interpreted here.

import type { Caller } from './identity.js';

/** A hung upstream must not pin an Alexa+ turn forever. */
const TIMEOUT_MS = 10000;

export class PostgrestError extends Error {
  /** 0 means "never reached the server", not an HTTP status. */
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'PostgrestError';
    this.status = status;
    this.code = code;
  }
}

/** The shape PostgREST returns for a raised error. */
interface PostgrestErrorBody {
  code?: string;
  message?: string;
  hint?: string;
}

/** The origin the service calls. Read lazily so /health can answer without it. */
function baseUrl(): string {
  const url = process.env.POSTGREST_URL?.trim().replace(/\/+$/, '');
  if (!url) {
    throw new PostgrestError(
      'POSTGREST_URL is not set, so no Globie Earth data can be read. ' +
        'Set it to https://api.globie.earth (or the local stack) - see infra/.env.example.',
      0,
    );
  }
  return url;
}

async function request<T>(
  path: string,
  caller: Caller,
  body?: unknown,
  headers: Record<string, string> = {},
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE',
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        // The device credential. See infra/schema/030_rls.sql.
        'X-Device-Id': caller.deviceId,
        // The account credential, when there is one. See 070_accounts.sql.
        ...(caller.bearer ? { Authorization: `Bearer ${caller.bearer}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PostgrestError(`Could not reach the Globie Earth API: ${reason}`, 0);
  }

  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as PostgrestErrorBody | null;
    throw new PostgrestError(
      parsed?.message ?? `The Globie Earth API answered ${response.status}.`,
      response.status,
      parsed?.code ?? null,
    );
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Calls a SECURITY DEFINER function exposed as a PostgREST RPC. */
export function rpc<T>(name: string, args: Record<string, unknown>, caller: Caller): Promise<T> {
  return request<T>(`/rpc/${name}`, caller, args);
}

/**
 * Reads a table or view, e.g. `living_deeds?select=deed_no&order=issued_at.desc`.
 * Device-scoped tables are filtered by RLS, not by the query, so the caller's
 * own X-Device-Id is the only thing deciding which rows come back.
 */
export function get<T>(query: string, caller: Caller): Promise<T> {
  return request<T>(`/${query.replace(/^\/+/, '')}`, caller);
}

/**
 * Inserts one row into a table and returns it.
 *
 * `Prefer: return=representation` makes PostgREST answer with the stored row
 * instead of an empty 201, so the caller gets the generated id back. RLS still
 * applies: an insert the caller's device may not make is rejected as 403 by the
 * policy, not silently written - which is what actually guards this path.
 */
export function insert<T>(table: string, row: Record<string, unknown>, caller: Caller): Promise<T> {
  return request<T>(`/${table.replace(/^\/+/, '')}`, caller, row, {
    Prefer: 'return=representation',
  });
}

/**
 * Updates the rows a PostgREST filter matches, and returns the rows it changed.
 *
 * `match` is the query string that picks the target rows, e.g.
 * `id=eq.<uuid>&status=eq.pending` - the filter is not optional, because a
 * PATCH without one would rewrite the whole table. `Prefer:
 * return=representation` makes PostgREST answer with the stored rows instead of
 * an empty 204, so a review action can report what it actually moved.
 *
 * RLS is the real guard, exactly as it is for insert: only a moderator's device
 * satisfies species_contributions_moderate, and the column grant confines the
 * write to the review columns - status, reviewed_by, reviewed_at. An update the
 * caller may not make comes back as 403, not as a silent no-op.
 */
export function update<T>(
  table: string,
  match: string,
  patch: Record<string, unknown>,
  caller: Caller,
): Promise<T> {
  const query = `${table.replace(/^\/+/, '')}?${match}`;
  return request<T>(`/${query}`, caller, patch, { Prefer: 'return=representation' }, 'PATCH');
}

/**
 * Deletes the rows a PostgREST filter matches, and returns the rows it removed.
 *
 * `match` is the query string that picks the target rows, e.g.
 * `id=eq.<uuid>` - it is not optional for the same reason it is not on update:
 * a DELETE without one would empty the table. `Prefer: return=representation`
 * makes PostgREST answer with the deleted rows instead of an empty 204, so a
 * caller can confirm what actually went, and tell "removed it" apart from
 * "it was not mine / not there" (both of which come back as an empty array).
 *
 * RLS is the real guard, exactly as it is for insert and update: only the
 * owning device satisfies species_contributions_delete, so another device's
 * delete matches no rows. An already-deleted row is likewise an empty result,
 * not an error - a repeat removal is a no-op.
 */
export function del<T>(table: string, match: string, caller: Caller): Promise<T> {
  const query = `${table.replace(/^\/+/, '')}?${match}`;
  return request<T>(`/${query}`, caller, undefined, { Prefer: 'return=representation' }, 'DELETE');
}
