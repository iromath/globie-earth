// The push dispatcher: the always-on loop that gives sendPush its caller.
//
// 251 built the table, 252 made events become rows, and 2c made an *open* app
// feel a row within a second. None of that reaches an app that is closed - the
// stream (notifications.ts) is one connection per caller and only ever reads
// that caller's own feed. This module is the missing half: it notices new rows
// for *every* device and hands each to sendPush (pushSender.ts, 2d.1).
//
// Why polling, and not LISTEN/NOTIFY. The MCP server has *no direct Postgres
// connection* - it speaks HTTP to PostgREST as `anon` (postgrest.ts) - so it
// cannot LISTEN, and 252 moved every emit into database triggers, so nothing
// happens in this process to emit from. The loop therefore polls a SECURITY
// DEFINER claim function, api.claim_notification_pushes (253), which returns the
// next un-delivered rows and stamps them delivered in the same statement.
//
// Why a credential. api.notifications is closed (251 revokes all from anon and
// creates no policy), so a function that reads it across devices would be a hole
// if the world could call it - the same reasoning 252's header gives. The claim
// function is gated on `notification_dispatch: true`, a claim of a JWT signed
// with the stack's own PGRST_JWT_SECRET. This process holds no other database
// credential: the token rides in as the ordinary anon bearer (postgrest.ts), and
// PostgREST verifies the signature before the call ever runs. Mint one with
// scripts/make-dispatch-token.mjs (`npm run make:dispatch-token`).
//
// Why claiming stamps first. api.claim_notification_pushes sets `pushed_at` at
// claim time, not after the send, so a row is returned exactly once even across
// restarts or two dispatchers. A send that then fails is logged by the sender
// and not retried - the plan's "a push is a best-effort extra" (2d.1); the event
// was committed by the database long before this ran and must not be put at
// risk by its own push.
//
// Why it declines to start when unconfigured. sendPush fails closed, so with no
// OneSignal key it would return false - but the claim would still have stamped
// `pushed_at`, draining the queue and silently discarding every alert. The loop
// therefore does not run at all until both the dispatch token and the OneSignal
// pair are set, so rows simply wait for a sender instead of being lost.

import type { FastifyInstance } from 'fastify';

import type { Caller } from './identity.js';
import { notificationText } from './notificationCopy.js';
import type { NotificationKind } from './notificationLink.js';
import { notificationsEnabled } from './notifications.js';
import { rpc } from './postgrest.js';
import { sendPush, type PushMessage } from './pushSender.js';

/** How often the loop claims a batch. Push is best-effort; the vendor's own delivery dominates. */
const TICK_MS = 5000;

/** The most rows one tick claims, matching the claim RPC's own default. */
const BATCH = 50;

/**
 * The device id sent on the claim call. The claim function runs as the owner and
 * reads no device identity - it derives nothing from X-Device-Id - but
 * postgrest.ts always sends one, so a well-formed placeholder stands in. It is
 * never written anywhere.
 */
const DISPATCH_DEVICE_ID = '00000000-0000-4000-8000-000000000000';

/** The six kinds api.notifications accepts (migration `251`). */
const KINDS: readonly NotificationKind[] = [
  'discussion_message',
  'question',
  'points_awarded',
  'media_approved',
  'media_rejected',
  'media_pending',
];

function isNotificationKind(value: string): value is NotificationKind {
  return (KINDS as readonly string[]).includes(value);
}

/** A row of api.claim_notification_pushes() - the row plus the recipient's resolved preferences. */
interface ClaimedPush {
  id: string;
  recipient_device_id: string;
  kind: string;
  contribution_id: string | null;
  frame_key: string | null;
  title_key: string | null;
  body_params: Record<string, unknown> | null;
  lang: string | null;
  frequency: string | null;
  kinds: Record<string, boolean> | null;
  web_push: boolean | null;
  mobile_push: boolean | null;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** The dispatch credential. A secret, but a low-privilege one - see the file header. */
function dispatchToken(): string | null {
  return process.env.NOTIFICATIONS_DISPATCH_TOKEN?.trim() || null;
}

/** Whether the OneSignal sender has both halves it needs. */
function pushConfigured(): boolean {
  return Boolean(process.env.ONESIGNAL_APP_ID?.trim() && process.env.ONESIGNAL_API_KEY?.trim());
}

/** Whether the dispatcher could run: the token and the sender both present. */
export function pushDispatcherConfigured(): boolean {
  return Boolean(dispatchToken() && pushConfigured());
}

/**
 * The token's `exp` as an ISO timestamp, or null when it carries none. Decoded
 * without verification - this is only so /health and the boot log can say when
 * the credential lapses; the signature is PostgREST's business, not ours.
 */
function tokenExpiresAt(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/** The caller the claim call is made as: the token in the bearer, a placeholder device id. */
function callerFor(token: string): Caller {
  return { deviceId: DISPATCH_DEVICE_ID, bearer: token };
}

/** Renders one claimed row with the app's own copy and hands it to the sender. */
async function dispatchOne(row: ClaimedPush, log: FastifyInstance['log']): Promise<void> {
  if (!isNotificationKind(row.kind)) {
    // 251's check constraint makes this unreachable, but the claim returns `text`
    // and a future kind must not be sent as an unroutable link.
    log.warn({ id: row.id, kind: row.kind }, 'push: skipping an alert with an unknown kind');
    return;
  }

  const { title, body } = notificationText(
    { kind: row.kind, body_params: row.body_params },
    row.lang,
  );
  const message: PushMessage = {
    externalId: row.recipient_device_id,
    kind: row.kind,
    contributionId: row.contribution_id,
    frameKey: row.frame_key,
    title,
    body,
    lang: row.lang,
    preferences: {
      frequency: row.frequency,
      kinds: row.kinds,
      webPush: row.web_push,
      mobilePush: row.mobile_push,
    },
  };

  if (await sendPush(message, log)) {
    log.info({ id: row.id, kind: row.kind }, 'push: dispatched');
  }
}

/** Claims one batch and sends each row. A failed tick is logged, never fatal. */
async function tick(log: FastifyInstance['log']): Promise<void> {
  if (running) return;
  const token = dispatchToken();
  if (!token) return;
  running = true;
  try {
    const rows = await rpc<ClaimedPush[]>(
      'claim_notification_pushes',
      { p_limit: BATCH },
      callerFor(token),
    );
    if (!Array.isArray(rows)) return;
    // Oldest first from the RPC; send in order so a digest-like burst arrives in
    // the order it happened.
    for (const row of rows) {
      await dispatchOne(row, log);
    }
  } catch (error) {
    // A PostgREST blip, or a token that has lapsed. Must not kill the loop: the
    // rows stay unclaimed until a later tick succeeds.
    log.warn({ err: error }, 'push: a dispatch tick failed');
  } finally {
    running = false;
  }
}

/**
 * Starts the loop, or says why it did not. Idempotent, and safe to call before
 * the server is listening - everything it does is outbound HTTP.
 */
export function startPushDispatcher(app: FastifyInstance): void {
  if (timer) return;

  // The 4d kill switch. With delivery off the loop never claims, so no push is
  // sent; the rows stay un-pushed and are sent once the switch is turned back on
  // (the claim only stamps pushed_at at claim time, so nothing was drained).
  if (!notificationsEnabled()) {
    app.log.info('push: dispatcher not started - NOTIFICATIONS_ENABLED is off');
    return;
  }

  const token = dispatchToken();
  const sender = pushConfigured();
  if (!token || !sender) {
    app.log.info(
      { token: Boolean(token), onesignal: sender },
      'push: dispatcher not started - set NOTIFICATIONS_DISPATCH_TOKEN (and ONESIGNAL_APP_ID / ' +
        'ONESIGNAL_API_KEY) to wake closed apps',
    );
    return;
  }

  const expiry = tokenExpiresAt(token);
  if (expiry && Date.parse(expiry) <= Date.now()) {
    app.log.error(
      { tokenExpiresAt: expiry },
      'push: the dispatch token has expired - re-mint it with `npm run make:dispatch-token`',
    );
    return;
  }

  app.log.info({ tokenExpiresAt: expiry, tickMs: TICK_MS }, 'push: dispatcher started');
  timer = setInterval(() => void tick(app.log), TICK_MS);
  // Prime immediately, so a row that arrived while the process booted is not
  // held for a whole interval.
  void tick(app.log);
}

/**
 * The dispatcher's state, for /health. `configured` is whether it *could* run
 * (token and sender present); `running` is whether the loop is actually ticking;
 * `tokenExpiresAt` is when the credential lapses, or null when it carries no
 * expiry.
 */
export function pushDispatcherHealth(): {
  configured: boolean;
  running: boolean;
  tokenExpiresAt: string | null;
} {
  const token = dispatchToken();
  return {
    configured: Boolean(token && pushConfigured()),
    running: Boolean(timer),
    tokenExpiresAt: token ? tokenExpiresAt(token) : null,
  };
}
