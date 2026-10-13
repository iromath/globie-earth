// The link a notification opens - the server's copy of src/lib/notificationLink.ts.
//
// This file is a *twin*, kept in step by hand, of the client module
// src/lib/notificationLink.ts (R3.1 of Dev-Docs/LIVE-DISCUSSION-NOTIFICATION-PLAN.md).
// It exists for one reason: the MCP build cannot import that module.
// infra/mcp/tsconfig.json pins `rootDir` to infra/mcp/src and `include`s only it,
// and the client module reaches Vite's `import.meta.env` through src/lib/site.ts,
// which is not valid input to a NodeNext compile. So the mapping is written twice
// rather than shared across the two tsconfigs.
//
// The client module is the source of truth. If R3.1 changes - a kind gains a
// different target, a route is renamed, a head is re-spelled - change *both*, and
// change them together: nothing here is tested against the client, and the only
// thing keeping them equal is that they are read side by side.
//
// What must not drift, and what is therefore spelled out below rather than
// derived: the three deep heads a `globie://` link is built from
// (`contributions`, `contribution/<id>`, `contribution/<id>/<frameKey>`), the two
// outer spellings (`globie://<deep>` for native, `<site>/?dl=<deep>` for web), and
// the frame key's single percent-encoding - it is an object-storage path carrying
// slashes (`contributions/<deviceId>/<uuid>.jpg`), so it rides as one encoded
// segment and is decoded back by the app's own parser.
//
// The mapping is R3.1 of the live-notification plan:
//   discussion_message            the frame's comment thread on the media page
//   question                      the same thread - a question is a comment
//   points_awarded                the contribution dashboard
//   media_approved / _rejected    the media detail page
//   media_pending                 the media detail page (raised at submission)

/** The six kinds api.notifications accepts (migration `251`). */
export type NotificationKind =
  | 'discussion_message'
  | 'question'
  | 'points_awarded'
  | 'media_approved'
  | 'media_rejected'
  | 'media_pending';

/** Where the link is going: a native push, or a web push's `?dl=` URL. */
export type NotificationLinkPlatform = 'native' | 'web';

/**
 * What the helper reads off a notification. `kind` is the mapping's whole input;
 * the contribution and frame come off the row's own columns, with the row's
 * `payload` accepted as a second source because the emitter writes both from one
 * shape and either may carry them.
 */
export interface NotificationLinkSource {
  kind: NotificationKind;
  contribution_id?: string | null;
  frame_key?: string | null;
  payload?: Record<string, unknown> | null;
}

/** The app's own scheme - the client's src/lib/deepLinks.ts holds the same value. */
const DEEP_LINK_SCHEME = 'globie';

/** The production apex src/lib/site.ts defaults to when VITE_SITE_URL is unset. */
const SITE_URL = 'https://globie.earth';

/** The dashboard's path; src/lib/contributionRoutes.ts holds the same value. */
const CONTRIBUTION_LIST_PATH = '/contributions';

/** The native head of a single contribution - `globie://contribution/<id>`. */
const CONTRIBUTION_HEAD = 'contribution';

/** A non-empty string, or null - so a blank payload value never becomes an address. */
function stringFrom(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value ? value : null;
}

/**
 * `contribution/<id>[/<frameKey>]` - the `globie://` head, and the `?dl=` value
 * before it is query-encoded. The frame key is percent-encoded into the one
 * trailing segment, exactly as the client's route module encodes it and the
 * parser decodes it.
 */
function contributionDeep(id: string, frameKey?: string | null): string {
  return frameKey
    ? `${CONTRIBUTION_HEAD}/${id}/${encodeURIComponent(frameKey)}`
    : `${CONTRIBUTION_HEAD}/${id}`;
}

/**
 * The URL one notification opens, or null for a kind this build has no screen
 * for - the caller then leaves the app where it was rather than guessing.
 *
 * A kind that names one contribution but arrives without a usable id falls back
 * to the dashboard, the same graceful landing the app's parser uses, rather than
 * a half-open page.
 */
export function notificationLink(
  n: NotificationLinkSource,
  platform: NotificationLinkPlatform,
): string | null {
  const id = n.contribution_id ?? stringFrom(n.payload, 'contribution_id');
  const frameKey = n.frame_key ?? stringFrom(n.payload, 'frame_key');

  // The dashboard head is the list path without its leading slash - the spelling
  // both `globie://contributions` and `?dl=contributions` resolve from.
  const dashboard = CONTRIBUTION_LIST_PATH.slice(1);

  let deep: string;
  switch (n.kind) {
    case 'points_awarded':
      deep = dashboard;
      break;
    case 'discussion_message':
    case 'question':
      deep = id ? contributionDeep(id, frameKey) : dashboard;
      break;
    case 'media_approved':
    case 'media_rejected':
    case 'media_pending':
      deep = id ? contributionDeep(id) : dashboard;
      break;
    default:
      return null;
  }

  return platform === 'web'
    ? `${SITE_URL}/?dl=${encodeURIComponent(deep)}`
    : `${DEEP_LINK_SCHEME}://${deep}`;
}
