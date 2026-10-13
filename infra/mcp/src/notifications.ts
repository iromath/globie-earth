// The live half of the notification system: the server-sent-events stream the
// app listens on, and the two ordinary routes beside it.
//
// 251 built the table a steward can be shown and the SECURITY DEFINER RPCs that
// read it; 252 made events become rows. This file is what turns a new row into
// something an open app feels within a second or two, instead of something it
// finds the next time the screen is opened.
//
// It sits beside /mcp and /moderate for the house reason: the caller's identity
// is checked in one place (identity.ts) and the caller's own credential is
// forwarded to PostgREST, so the database - not this process - decides whose
// alerts are read. The stream never holds a service key.
//
// Two deliberate departures from the plan's 2c.1 wording, both forced by how
// this server actually reaches its data:
//
//   * There is no LISTEN/NOTIFY. The plan offered "a Postgres LISTEN/NOTIFY
//     payload, or an in-process event emitter if the sender runs in the same
//     process", but neither exists here. The MCP server has *no direct Postgres
//     connection at all* - it speaks HTTP to PostgREST as `anon`
//     (infra/mcp/src/postgrest.ts), and 252 moved every emit into database
//     triggers, so this process observes nothing locally. The stream is
//     therefore backed by a short poll of api.my_notifications(p_since) as the
//     caller: every POLL_MS the connection asks "anything new for this device
//     since <cursor>?" and writes a frame per row. Two seconds keeps the plan's
//     "within 2 s on an open app" true while costing one bounded RPC per open
//     app, and because the poll carries the caller's own identity it is the same
//     scoping the read RPC already enforces - there is no per-device channel
//     registry to keep, and no way to subscribe to someone else's feed.
//
//   * The identity may arrive in the query string. A browser EventSource cannot
//     set request headers, and the whole point of the stream is that the app
//     opens it directly, so the device id is also accepted as `?device_id=`.
//     It is the same public device credential the X-Device-Id header carries
//     (the RevenueCat appUserID, D4) and never an account JWT, which is why a
//     header is still preferred and tried first.
//
// One more thing decided here rather than elsewhere: preferences are applied at
// delivery. api.notification_preferences says whether a steward wants to be
// *popped at* in the app (in_app), which kinds, and how often (frequency); a
// muted event is still recorded by 252 and still returned by GET /notifications,
// the stream just does not push a live frame for it. A new preference takes
// effect on the next connection - re-reading it every poll would cost a second
// RPC per tick to serve a change a steward makes once.
//
// Not done here, and named so it is not mistaken for done: `frequency='daily'`
// does not yet coalesce a day's events into one digest. The stream reports each
// event and carries the caller's frequency, and the digest is a later step. The
// push sender (pushSender.ts, 2d) is likewise not called from here - a stream
// that is only open while the app is open is not the right place to wake a
// closed one. The push dispatcher (pushDispatcher.ts, 2d) is: it runs always-on
// and polls api.claim_notification_pushes() (migration 253) for rows no app has
// been woken for yet, across every device, and hands each to the sender.

import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';

import { resolveCaller, type Caller } from './identity.js';
import { PostgrestError, rpc } from './postgrest.js';

/** How often an open stream asks for new rows. The plan's "within 2 s". */
const POLL_MS = 2000;

/** The comment keep-alive, so a proxy does not time an idle stream out. */
const HEARTBEAT_MS = 25_000;

/** How many rows one poll may return - the stream drains forward from its cursor. */
const STREAM_LIMIT = 50;

/** The most ids one read receipt may stamp, matching the read RPC's own ceiling. */
const MAX_READ_IDS = 200;

/** The schema's own device-id length, so a bad id is refused before Postgres. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CALLER_NEEDED =
  'Notifications need a caller identity: the same X-Device-Id (or demo ' +
  'Authorization bearer) that /mcp accepts. See infra/mcp/README.md.';

/** A row of api.my_notifications(). Every field is what the app renders. */
interface NotificationRow {
  id: string;
  kind: string;
  contribution_id: string | null;
  frame_key: string | null;
  comment_id: string | null;
  title_key: string;
  body_params: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

/** A row of api.my_notification_preferences(), resolved to its defaults. */
interface Preferences {
  in_app: boolean;
  web_push: boolean;
  mobile_push: boolean;
  frequency: string;
  kinds: Record<string, boolean> | null;
  lang: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One message an operator can act on, from a PostgREST failure. */
function upstreamMessage(error: unknown): string {
  if (error instanceof PostgrestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The caller for a stream request. Header credentials win; the query-string
 * device id is the EventSource fallback explained in the file header.
 */
function resolveStreamCaller(request: {
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
}): Caller | null {
  const fromHeaders = resolveCaller(request.headers);
  if (fromHeaders) return fromHeaders;
  const query = isRecord(request.query) ? request.query : {};
  const device = typeof query.device_id === 'string' ? query.device_id.trim() : '';
  return UUID.test(device) ? { deviceId: device } : null;
}

/** A finite ISO timestamp, or null - so a junk cursor is not sent to Postgres. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Where a freshly-opened stream resumes from. Last-Event-ID is the client's
 * replay cursor (the created_at of the last row it saw); with none, the stream
 * starts at "now" and only carries genuinely new events - the backlog is what
 * GET /notifications is for, so an old alert is never re-announced as if new.
 */
function initialCursor(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return isoOrNull(raw) ?? new Date().toISOString();
}

/** One SSE frame. Comment/heartbeat frames are written directly, not here. */
function writeFrame(raw: ServerResponse, event: string, data: unknown, id?: string): void {
  if (raw.writableEnded || raw.destroyed) return;
  const lines = [
    ...(id ? [`id: ${id}`] : []),
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
  ];
  raw.write(`${lines.join('\n')}\n\n`);
}

/**
 * Whether a steward has asked to be popped at for this kind. A preference read
 * that failed leaves nothing to honour, so the event is delivered - the alert
 * exists and losing the live frame would be the worse error.
 */
function preferenceAllows(prefs: Preferences | null, kind: string): boolean {
  if (!prefs) return true;
  if (prefs.in_app === false) return false;
  if (prefs.frequency === 'off') return false;
  return prefs.kinds?.[kind] !== false;
}

/** Reads the caller's resolved preferences, or null when they cannot be read. */
async function readPreferences(
  caller: Caller,
  log: FastifyInstance['log'],
): Promise<Preferences | null> {
  try {
    const rows = await rpc<Preferences[]>('my_notification_preferences', {}, caller);
    return Array.isArray(rows) ? rows[0] ?? null : null;
  } catch (error) {
    log.warn({ err: error }, 'notifications: preferences unreadable, delivering unfiltered');
    return null;
  }
}

/**
 * Runs one connection for its whole life: prime a poll, keep polling, keep
 * commenting, and tear everything down the moment either end of the socket
 * closes.
 */
async function runStream(
  log: FastifyInstance['log'],
  raw: ServerResponse,
  caller: Caller,
  resumeFrom: string,
  onClose: (handler: () => void) => void,
): Promise<void> {
  let cursor = resumeFrom;
  const prefs = await readPreferences(caller, log);

  // The client may have gone away while the preference read was in flight.
  if (raw.writableEnded || raw.destroyed) return;

  let closed = false;
  let busy = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (beatTimer) clearInterval(beatTimer);
  };
  onClose(stop);

  const poll = async (): Promise<void> => {
    if (closed || busy) return;
    busy = true;
    try {
      const rows = await rpc<NotificationRow[]>(
        'my_notifications',
        { p_since: cursor, p_limit: STREAM_LIMIT },
        caller,
      );
      if (!Array.isArray(rows)) return;
      // Newest first from the RPC; oldest first here, so the cursor only ever
      // moves forward and a client never receives an event older than one it
      // already has.
      for (const row of [...rows].reverse()) {
        if (closed) return;
        // The cursor advances past a row whether or not it is delivered, so a
        // muted kind is skipped once and never re-polled.
        if (typeof row.created_at === 'string') cursor = row.created_at;
        if (!preferenceAllows(prefs, row.kind)) continue;
        writeFrame(raw, 'notification', row, row.created_at);
      }
    } catch (error) {
      // A failed poll (a PostgREST blip, a revoked identity) must not kill the
      // connection: the app's own poll fallback covers the gap. Log and wait.
      log.warn({ err: error }, 'notifications: a stream poll failed');
    } finally {
      busy = false;
    }
  };

  pollTimer = setInterval(() => void poll(), POLL_MS);
  beatTimer = setInterval(() => {
    if (closed || raw.writableEnded || raw.destroyed) return;
    raw.write(': ping\n\n');
  }, HEARTBEAT_MS);

  // Prime immediately, so a fresh stream is not silent for a whole interval.
  void poll();
}

/**
 * The rollout kill switch (plan 4d). `NOTIFICATIONS_ENABLED` unset - or any
 * value but a falsey token - means on; `off`/`false`/`0`/`no`/`disabled` turns
 * *delivery* off: the writer (252) still records every row, so nothing is lost,
 * but the SSE stream is not served and the push dispatcher does not run.
 * Rollback is one env change. GET /notifications and POST /notifications/read
 * keep working, so an open app still reads its backlog on poll.
 */
export function notificationsEnabled(): boolean {
  const raw = process.env.NOTIFICATIONS_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

/**
 * The three notification routes.
 *
 * GET /notifications/stream is the live one; GET /notifications and
 * POST /notifications/read are the polling fallback and the read receipt the
 * plan names beside it - the first two share api.my_notifications(), so the
 * stream is a live view of exactly what the fallback reads.
 */
export function registerNotificationsRoutes(app: FastifyInstance): void {
  /**
   * GET /notifications/stream - server-sent events, one connection per caller.
   *
   * Authenticates like /moderate/queue, opens the event stream, and then runs
   * until the client hangs up. The response is written by hand, so the Fastify
   * reply is hijacked and the CORS headers @fastify/cors set on it are copied
   * onto the raw response first - an EventSource sends an Origin, and a browser
   * would otherwise see the stream blocked even though the preflight passed.
   */
  app.get('/notifications/stream', async (request, reply) => {
    // The kill switch: with delivery off the stream is not served. A browser
    // EventSource reports the non-200 and keeps retrying (it does not switch to
    // the poll path on its own), so an open app simply shows nothing new live
    // until the switch is turned back on.
    if (!notificationsEnabled()) {
      return reply.code(503).send({ error: 'Live notifications are disabled.' });
    }

    const caller = resolveStreamCaller({
      headers: request.headers,
      query: request.query,
    });
    if (!caller) return reply.code(401).send({ error: CALLER_NEEDED });

    const headers: Record<string, string | number | string[]> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform stops a proxy re-compressing and buffering the stream;
      // X-Accel-Buffering is the nginx-specific half of the same request.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };
    for (const name of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-expose-headers',
      'vary',
    ]) {
      const value = reply.getHeader(name);
      if (value !== undefined) headers[name] = value as string | number | string[];
    }

    reply.hijack();
    reply.raw.writeHead(200, headers);
    // retry tells the browser's EventSource how long to wait before reconnecting;
    // the leading comment flushes the headers so onopen fires promptly.
    reply.raw.write('retry: 3000\n\n');
    reply.raw.write(': open\n\n');

    const raw = reply.raw;
    // The client's replay cursor: the created_at of the last row it saw, sent
    // automatically by EventSource on reconnect.
    const resumeFrom = initialCursor(request.headers['last-event-id']);
    const onClose = (handler: () => void): void => {
      request.raw.on('close', handler);
      raw.on('close', handler);
    };
    // Detached: the handler must return so Fastify steps away from a reply it
    // has handed to us, while the stream keeps running on its own timers.
    void runStream(request.log, raw, caller, resumeFrom, onClose);
  });

  /**
   * GET /notifications - the caller's alerts, newest first.
   *
   * The polling fallback and the first load of the notifications centre: what
   * the stream will carry live, and what an app that slept through a push finds
   * waiting when it wakes. `since` is the same cursor the stream uses, so a
   * client can hand its newest row's timestamp across to the stream.
   */
  app.get('/notifications', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) return reply.code(401).send({ error: CALLER_NEEDED });

    const query = isRecord(request.query) ? request.query : {};
    const rawSince = typeof query.since === 'string' ? query.since.trim() : '';
    let since: string | null = null;
    if (rawSince) {
      since = isoOrNull(rawSince);
      if (!since) return reply.code(400).send({ error: 'since must be an ISO 8601 timestamp.' });
    }

    const args: Record<string, unknown> = {};
    if (since) args.p_since = since;
    if (typeof query.limit === 'string' && query.limit.trim()) {
      const limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        return reply.code(400).send({ error: 'limit must be a positive integer.' });
      }
      // api.my_notifications caps at 200 anyway; clamp here so the answer is the
      // same one the RPC would give rather than a surprise.
      args.p_limit = Math.min(limit, 200);
    }

    try {
      const rows = await rpc<NotificationRow[]>('my_notifications', args, caller);
      return reply.send({
        notifications: Array.isArray(rows) ? rows : [],
        // A server clock the client can adopt as its stream cursor, so the gap
        // between this read and opening the stream is not a hole.
        now: new Date().toISOString(),
      });
    } catch (error) {
      request.log.error({ err: error }, 'notifications: reading the feed failed');
      return reply.code(502).send({
        error: `The notification feed could not be read (${upstreamMessage(error)}).`,
      });
    }
  });

  /**
   * POST /notifications/read - the read receipt. Body: { ids: uuid[] }.
   *
   * Ids the caller does not own are ignored by the RPC, so this cannot be used
   * to probe for other stewards' alerts; it reports only how many of the
   * caller's own unread rows it stamped.
   */
  app.post('/notifications/read', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) return reply.code(401).send({ error: CALLER_NEEDED });

    const body: unknown = request.body;
    if (!isRecord(body) || !Array.isArray(body.ids)) {
      return reply.code(400).send({ error: 'The read body must be { ids: string[] }.' });
    }
    const ids = body.ids
      .filter((value): value is string => typeof value === 'string' && UUID.test(value))
      .slice(0, MAX_READ_IDS);
    if (ids.length === 0) {
      return reply
        .code(400)
        .send({ error: 'ids must be a non-empty array of notification uuids.' });
    }

    try {
      const marked = await rpc<number>('mark_notifications_read', { p_ids: ids }, caller);
      return reply.send({ marked: typeof marked === 'number' ? marked : 0 });
    } catch (error) {
      request.log.error({ err: error }, 'notifications: marking read failed');
      return reply.code(502).send({
        error: `The alerts could not be marked read (${upstreamMessage(error)}).`,
      });
    }
  });
}

/**
 * Whether the notification surface can serve - for /health, in the shape the
 * speech and contribute routes use. `enabled` is the 4d kill switch: when off,
 * the stream is refused and push is off, but the read routes still serve. While
 * enabled the stream is up (it holds no credential); push additionally needs the
 * OneSignal sender (pushSender.ts, 2d), reported here so /health says plainly
 * whether a closed app could be woken.
 */
export function notificationsHealth(): { enabled: boolean; stream: boolean; push: boolean } {
  const enabled = notificationsEnabled();
  return {
    enabled,
    stream: enabled,
    push: enabled && Boolean(process.env.ONESIGNAL_API_KEY?.trim()),
  };
}
