// The push half of the live-notification system: the one place the MCP server
// talks to OneSignal.
//
// Until now every notification was a campaign sent by hand from the OneSignal
// dashboard. This module is what lets the server send one itself - a live
// discussion reply, an approved contribution, a points award - by calling
// POST https://api.onesignal.com/notifications. It is deliberately *not* a route:
// the sender is called by whatever observed the event (the notification stream in
// infra/mcp/src/notifications.ts, 2c.1), so no call site has to know the vendor's
// request shape.
//
// Four things are deliberate:
//
//   - It targets a *person*, not a device. include_aliases.external_id carries the
//     RevenueCat appUserID that linkRevenueCatSubscriber() already sets
//     (src/lib/oneSignal.ts), so there is no device-token table to keep in the
//     database. target_channel:'push' is mandatory alongside include_aliases.
//   - It sends two launch URLs, not one. A web push cannot follow a custom scheme
//     and a native push should not open a browser, so `app_url` carries the
//     `globie://` form and `web_url` the `https://globie.earth/?dl=...` form
//     (Dev-Docs/ONESIGNAL-WEB-PUSH-PLAN.md D3). OneSignal's plain `url` is not set:
//     it targets every platform at once and must be https, which would send
//     Android back through the browser.
//   - It honours the recipient's own choices. api.notification_preferences (251)
//     is applied at delivery, and the sender is one of the two places that does
//     it - the stream (notifications.ts, 2c) is the other, for the in-app frame.
//     A muted kind, `frequency='off'`, or both push channels off stop the send;
//     one channel off narrows it to the other through OneSignal's platform
//     switches (aliases and filters cannot be combined in one request, so a
//     per-platform choice cannot be a filter). The *caller* resolves the row -
//     this module holds no database credential - and an absent `preferences`
//     leaves the send exactly as it was, so a sender called without them cannot
//     be the thing that silently stops a push.
//   - It *fails closed*. A missing app id or key, an unknown kind, an aborted
//     request or a refused send is logged and returns false; it never throws. The
//     event that triggered the push has already been committed by the database,
//     and a push is a best-effort extra - it must not be able to fail the thing it
//     is about. With the key unset the sender simply disables itself and says so.
//
// The link spelling comes from the server-side twin of src/lib/notificationLink.ts
// (infra/mcp/src/notificationLink.ts); see that file for why the mapping is
// written twice.

import type { FastifyInstance } from 'fastify';

import { notificationLink, type NotificationKind } from './notificationLink.js';

/** OneSignal's Create-Message endpoint. */
const ENDPOINT = 'https://api.onesignal.com/notifications';

/** How long one send may take before it is abandoned. */
const TIMEOUT_MS = 10_000;

/** The language a heading and body are filed under when the caller does not say. */
const DEFAULT_LANG = 'en';

/**
 * What the sender reads from the environment. Both are optional: compose passes
 * them without a `${...:?}` guard so one unset key never aborts the stack, and an
 * unset pair is a valid configuration that only disables push.
 */
function pushConfig(): { appId: string | null; apiKey: string | null } {
  return {
    appId: process.env.ONESIGNAL_APP_ID?.trim() || null,
    apiKey: process.env.ONESIGNAL_API_KEY?.trim() || null,
  };
}

/**
 * The delivery choices the sender must honour, as resolved by
 * api.my_notification_preferences() (infra/schema/251_notifications.sql). Every
 * field is optional: an absent one is "no opinion", so a caller that resolved
 * only part of the row still gets the safe behaviour for the rest.
 */
export interface PushPreferences {
  /** instant | daily | off. 'off' silences every channel. */
  frequency?: string | null;
  /** The per-kind switches; `{[kind]: false}` mutes that kind. */
  kinds?: Record<string, boolean> | null;
  /** When false, no browser subscription is woken. */
  webPush?: boolean | null;
  /** When false, no handset subscription is woken. */
  mobilePush?: boolean | null;
}

/**
 * One push to one person.
 *
 * `title` and `body` are the already-resolved copy: the row stores a `title_key`
 * and `body_params` (migration `251`) and the caller renders them, so the sender
 * never has to own a translation catalogue.
 */
export interface PushMessage {
  /** include_aliases.external_id - the RevenueCat appUserID. */
  externalId: string;
  /** api.notifications.kind, which chooses the link (R3.1). */
  kind: NotificationKind;
  /** The contribution the notification is about, when it names one. */
  contributionId?: string | null;
  /** The frame's object-storage key, when the link opens one thread. */
  frameKey?: string | null;
  /** The rendered heading and body. */
  title: string;
  body: string;
  /** api.notification_preferences.lang; defaults to 'en'. */
  lang?: string | null;
  /** The recipient's resolved preferences; absent means "send as configured". */
  preferences?: PushPreferences | null;
}

/** The OneSignal platform switches a channel choice turns into. All default on. */
interface PushPlatforms {
  isAnyWeb?: false;
  isAndroid?: false;
  isIos?: false;
}

/**
 * The platform switches that honour webPush / mobilePush, or null when the
 * recipient has asked for no push at all.
 *
 * Aliases and filters cannot be combined in one request (OneSignal "Choose your
 * target audience"), and this send targets a person by alias, so a per-platform
 * choice cannot be expressed as a filter - the platform booleans are the
 * supported route. Each defaults to on, so only the muted side is named:
 * `isAnyWeb:false` leaves the handset subscriptions, and `isAndroid/isIos:false`
 * leave the browser ones.
 */
function pushPlatforms(prefs: PushPreferences | null | undefined): PushPlatforms | null {
  if (!prefs) return {};
  const web = prefs.webPush !== false;
  const mobile = prefs.mobilePush !== false;
  if (!web && !mobile) return null;
  const platforms: PushPlatforms = {};
  if (!web) platforms.isAnyWeb = false;
  if (!mobile) {
    platforms.isAndroid = false;
    platforms.isIos = false;
  }
  return platforms;
}

/**
 * Sends one push and reports whether OneSignal accepted it. Never throws - see
 * the file header.
 */
export async function sendPush(message: PushMessage, log: FastifyInstance['log']): Promise<boolean> {
  const { appId, apiKey } = pushConfig();
  if (!appId || !apiKey) {
    log.warn(
      { kind: message.kind },
      'push: disabled - ONESIGNAL_APP_ID / ONESIGNAL_API_KEY is unset, so nothing was sent',
    );
    return false;
  }

  const source = {
    kind: message.kind,
    contribution_id: message.contributionId,
    frame_key: message.frameKey,
  };
  const app = notificationLink(source, 'native');
  const web = notificationLink(source, 'web');
  if (!app || !web) {
    log.warn({ kind: message.kind }, 'push: no route for this kind, so nothing was sent');
    return false;
  }

  const prefs = message.preferences;
  if (prefs) {
    if (prefs.frequency === 'off') {
      log.info({ kind: message.kind }, 'push: suppressed - the recipient set frequency to off');
      return false;
    }
    if (prefs.kinds?.[message.kind] === false) {
      log.info({ kind: message.kind }, 'push: suppressed - the recipient muted this kind');
      return false;
    }
  }
  const platforms = pushPlatforms(prefs);
  if (platforms === null) {
    log.info({ kind: message.kind }, 'push: suppressed - both push channels are off');
    return false;
  }

  const lang = message.lang?.trim() || DEFAULT_LANG;
  const payload = {
    app_id: appId,
    include_aliases: { external_id: [message.externalId] },
    target_channel: 'push',
    headings: { [lang]: message.title },
    contents: { [lang]: message.body },
    app_url: app,
    web_url: web,
    ...platforms,
  };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    log.error({ err: error, kind: message.kind }, 'push: the send request failed');
    return false;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log.error(
      { status: response.status, kind: message.kind, detail: detail.slice(0, 300) },
      'push: OneSignal refused the send',
    );
    return false;
  }

  log.info({ kind: message.kind }, 'push: sent');
  return true;
}
