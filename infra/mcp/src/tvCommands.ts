// The TV relay: how an Alexa utterance reaches the Vega app.
//
// A Skill cannot address another process on the TV. Its only directives are
// `outputSpeech` and `AudioPlayer.Play/Stop`, and neither carries a screen
// change, so "search for forest podcasts on the television" today starts audio
// on the device that handled the utterance and never touches the app. Content
// Launcher is the Amazon-blessed route for that, but it needs catalog ingestion
// and a partner id we do not have (see Dev-Docs/App Idea/vega-alexa-tv-plan.md).
//
// So the Skill posts a command here and the app picks it up. The queue and the
// long poll are in-process: a command is only useful for the seconds before it
// goes stale, and a waiter is an open HTTP request. The pairing is not - the
// maps below used to be the only copy, so every redeploy silently unpaired
// every television. Both the ticket and the binding now live in
// api.tv_pairing_codes / api.tv_pairings (infra/schema/255_tv_pairing.sql), and
// the maps are a per-process mirror that keeps pairing working when the API is
// unreachable.
//
// It sits beside /mcp for the same reason /route, /voice and /wiki do: the
// Skill holds no device identifier of its own, so identity is resolved in one
// place - resolveCaller, from the headers the caller already sends - and every
// route below reads it from there.
//
// The pairing is what makes the relay safe to expose. A TV shows a six-digit
// code, the Skill speaks it back, and from then on only that Alexa identity may
// queue work for that TV, and only that TV may drain it.

import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';

import { resolveCaller, type Caller } from './identity.js';
import { PostgrestError, get, rpc } from './postgrest.js';
import { callProxy, ProxyError } from './proxy.js';
import type { PodcastFeed } from './tools/podcast.js';
import type { ChallengeAward, ChallengeLobby, ChallengeQuestion, ChallengeStanding } from './challenge.js';
import type { GameSnapshot } from './tvGame.js';

/**
 * The screens voice may name. Every one is a chip or tile the viewer can reach
 * with the D-pad from where they already are, so naming it adds no reach.
 */
export type TvScreen = 'welcome' | 'quests' | 'learn' | 'focus' | 'settings' | 'wardrobe' | 'guessWho';

/**
 * The closed set of things voice may ask the TV to do.
 *
 * Deliberately small. Each member is a navigation the app already performs from
 * its own remote, so the relay cannot drive the TV into a state a viewer could
 * not reach with the D-pad.
 *
 * `openFeed` carries the whole show rather than its id: the player reads the
 * title, image and author, and the TV has no feed-by-id route of its own. The
 * server resolves it before queueing, so an unknown show is refused here
 * instead of arriving as a navigation to nowhere.
 *
 * The `game.*` members carry a whole snapshot rather than a delta. The score
 * is judged in tvGame.ts, and letting the screen apply anything but the whole
 * state is how a spoken score and a drawn score drift apart.
 *
 * The `challenge.*` members do the same for a party: each one carries the
 * lobby, the question or the standings as the room currently sees them, so a
 * dropped or duplicated push cannot leave a team a round ahead.
 *
 * Still no raw key member. `back`, `openScreen` and `player.pause|resume` are
 * the remote's own moves named at intent level: `back` is exactly what the TV's
 * BACK key does on that screen, `openScreen` is a header chip, and the player
 * pair is the play/pause key. A `key` member would instead let a stale queued
 * command move focus from wherever the viewer has since parked it.
 */
/**
 * One seat's camera, as the television draws it.
 *
 * `frameUrl` is a path, not an address: the TV prefixes the same relay origin
 * it polls for commands. It is null until the seat has a frame that can still
 * be read, so the tile shows an avatar rather than a broken image.
 */
export interface TvPresenceTile {
  slot: number;
  name: string;
  on: boolean;
  /** Bumped per accepted frame; the image URL changes with it. */
  version: number;
  /** Epoch ms of the latest accepted frame; 0 for none. */
  frameAt: number;
  frameUrl: string | null;
  /** Advisory computer-vision reading from the phone. Never a score. */
  event: { type: string; score: number; at: number } | null;
}

export type TvCommand =
  | { type: 'search'; query: string }
  | { type: 'openFeed'; feedId: number; feed: PodcastFeed }
  | { type: 'home' }
  | { type: 'back' }
  | { type: 'openScreen'; screen: TvScreen }
  | { type: 'player.pause' }
  | { type: 'player.resume' }
  | { type: 'game.start'; snapshot: GameSnapshot }
  | { type: 'game.answer'; snapshot: GameSnapshot }
  | { type: 'game.next'; snapshot: GameSnapshot }
  | { type: 'game.quit' }
  | { type: 'challenge.lobby'; room: ChallengeLobby }
  | { type: 'challenge.question'; round: ChallengeQuestion; index: number; total: number; endsAt: number }
  | { type: 'challenge.standings'; rows: ChallengeStanding[]; final: boolean; award?: ChallengeAward | null }
  | { type: 'challenge.presence'; roomId: string; tiles: TvPresenceTile[] }
  | {
      type: 'challenge.closed';
      reason: 'host_left' | 'expired';
      roomId: string;
    };

/**
 * What the TV asks Alexa to take over when it cannot play sound itself.
 *
 * The virtual device (and any Vega build without an audio sink) fails every
 * play with MEDIA_ERR_SRC_NOT_SUPPORTED. Rather than leave the listener with a
 * silent screen, the TV records what it was trying to play and names a carrier
 * phrase; the next PlayMeditationIntent / PlayPodcastIntent / ResumeIntent from
 * the paired Alexa account then plays that exact item on the Echo.
 *
 * Identifiers only: the Skill resolves the media from its own catalogue, so a
 * TV cannot point the Echo at an arbitrary URL.
 */
export type TvHandoff =
  | { type: 'meditation'; minutes: number | null; guideId: string }
  | { type: 'podcast'; feedId: number; episodeId: number };

interface HandoffEntry {
  handoff: TvHandoff;
  at: number;
}

interface CodeEntry {
  tvDeviceId: string;
  expiresAt: number;
}

interface Pairing {
  tvDeviceId: string;
  alexaDeviceId: string;
  pairedAt: number;
}

interface Queued {
  command: TvCommand;
  enqueuedAt: number;
}

/** Long enough to read off the TV and say, short enough to not linger. */
const CODE_TTL_MS = 5 * 60_000;
/** A command older than this is stale: the viewer has moved on. */
const COMMAND_TTL_MS = 2 * 60_000;
/** Alexa abandons a request around 8s, so a command must not wait longer. */
const WAIT_DEFAULT_MS = 15_000;
const WAIT_MAX_MS = 20_000;
/** A burst of utterances should not queue a minute of navigation. */
const QUEUE_LIMIT = 8;
/** The MCP tool's own ceiling, so a spoken query cannot exceed what it accepts. */
const QUERY_MAX = 120;
/** The named screens voice may ask for; the order is the order in the error text. */
const TV_SCREENS: readonly TvScreen[] = [
  'welcome',
  'quests',
  'learn',
  'focus',
  'settings',
  'wardrobe',
  'guessWho',
];
/**
 * How long a hand-off stays usable. Long enough to pick up the Echo and say the
 * phrase; short enough that a lesson from this morning is not replayed tonight.
 */
const HANDOFF_TTL_MS = 15 * 60_000;
/** The durations PlayMeditationIntent understands; anything else is the short lesson. */
const HANDOFF_MINUTES = new Set([10, 15, 30]);

const codes = new Map<string, CodeEntry>();
const pairingsByAlexa = new Map<string, Pairing>();
const pairingsByTv = new Map<string, Pairing>();
const queues = new Map<string, Queued[]>();
/** One pending GET per TV: a second poll supersedes the first. */
const waiters = new Map<string, (command: TvCommand | null) => void>();
/** Keyed by the Alexa identity, because that is who the Skill speaks for. */
const handoffs = new Map<string, HandoffEntry>();

function pruneCodes(now: number): void {
  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) codes.delete(code);
  }
}

function freshCode(now: number): string {
  // Six digits with a leading zero allowed: it is spoken, not parsed, and a
  // fixed width is easier to read across the room.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!codes.has(code)) return code;
  }
  // Every code is taken, which needs a million live codes; refuse rather than
  // overwrite someone else's pairing window.
  throw Object.assign(new Error('No pairing code is available right now.'), { statusCode: 503 });
}

function queueFor(deviceId: string): Queued[] {
  const existing = queues.get(deviceId);
  if (existing) return existing;
  const created: Queued[] = [];
  queues.set(deviceId, created);
  return created;
}

function takeCommand(deviceId: string, now: number): TvCommand | null {
  const queue = queueFor(deviceId);
  while (queue.length && now - queue[0].enqueuedAt > COMMAND_TTL_MS) queue.shift();
  const next = queue.shift() ?? null;
  if (!queue.length) queues.delete(deviceId);
  return next?.command ?? null;
}

function waitForCommand(deviceId: string, waitMs: number): Promise<TvCommand | null> {
  // A second poll from the same TV would otherwise leave the first hanging
  // until its own timeout; releasing it with null lets that request end.
  waiters.get(deviceId)?.call(null, null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(deviceId);
      resolve(null);
    }, waitMs);
    waiters.set(deviceId, (command) => {
      clearTimeout(timer);
      waiters.delete(deviceId);
      resolve(command);
    });
  });
}

function deliver(deviceId: string, command: TvCommand): void {
  const waiter = waiters.get(deviceId);
  if (waiter) {
    waiters.delete(deviceId);
    waiter(command);
    return;
  }
  const queue = queueFor(deviceId);
  while (queue.length >= QUEUE_LIMIT) queue.shift();
  queue.push({ command, enqueuedAt: Date.now() });
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isTvScreen(value: string | null): value is TvScreen {
  return value !== null && (TV_SCREENS as readonly string[]).includes(value);
}

/**
 * A code spoken into the Skill's search-query slot arrives as words - "zero
 * four seven nine five one" - because the recognizer transcribes free text
 * rather than converting it to a number. Typed and curl callers send digits.
 * Both have to reach the same six digits before the map is consulted.
 */
const SPOKEN_DIGITS: Record<string, string> = {
  zero: '0',
  oh: '0',
  nought: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/**
 * The six digits in whatever was said, or fewer when the words were not a code.
 *
 * Exported because the Skill adapter has to tell "the listener just read the
 * digits" apart from every other in-session utterance while a pairing is
 * waiting on them (alexa.ts, PairTvIntent).
 */
export function pairingDigits(raw: string): string {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(token => SPOKEN_DIGITS[token] ?? token)
    .join('')
    .replace(/\D/g, '');
}

export type ClaimResult =
  | { paired: true; tvDeviceId: string }
  | { paired: false; reason: 'invalid_code' };

/** The PostgREST row shapes; snake_case because that is the column spelling. */
interface PairingRow {
  tv_device_id: string;
  alexa_device_id: string;
  paired_at: string;
}

interface CodeRow {
  code: string;
  expires_at: string;
}

/**
 * Remembers a binding in both directions.
 *
 * The eviction is the same rule the durable claim applies: repairing moves an
 * Alexa account off its old TV and a TV off its old account, so there is never
 * more than one route to a screen.
 */
function rememberPairing(pairing: Pairing): void {
  const previousTv = pairingsByAlexa.get(pairing.alexaDeviceId);
  if (previousTv) pairingsByTv.delete(previousTv.tvDeviceId);
  const previousAlexa = pairingsByTv.get(pairing.tvDeviceId);
  if (previousAlexa) pairingsByAlexa.delete(previousAlexa.alexaDeviceId);

  pairingsByAlexa.set(pairing.alexaDeviceId, pairing);
  pairingsByTv.set(pairing.tvDeviceId, pairing);
}

function rememberCode(code: string, tvDeviceId: string, expiresAt: number): void {
  // The durable issue already replaced this TV's previous code; keep the mirror
  // in step so a fallback claim cannot consume a ticket the TV no longer shows.
  for (const [existing, entry] of codes) {
    if (entry.tvDeviceId === tvDeviceId) codes.delete(existing);
  }
  codes.set(code, { tvDeviceId, expiresAt });
}

function pairingFrom(row: PairingRow): Pairing {
  return {
    tvDeviceId: row.tv_device_id,
    alexaDeviceId: row.alexa_device_id,
    pairedAt: Date.parse(row.paired_at) || Date.now(),
  };
}

/**
 * Whether a call fell back to the mirror rather than the durable store.
 *
 * The API can be unreachable or the migration unapplied, and a demo TV that
 * cannot pair because PostgREST is slow is worse than one that pairs until the
 * next redeploy. So every store call degrades to the maps below, which are
 * always coherent within this process. A non-Postgrest error is a bug and is
 * left for the route to answer.
 */
function storeUnavailable(error: unknown): boolean {
  return error instanceof PostgrestError;
}

/**
 * Issues the six digits a TV shows on its pairing screen.
 *
 * The function also deletes the caller's previous code, so a code the screen
 * no longer displays stops being claimable the moment a new one is drawn.
 */
async function issueCode(caller: Caller): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now();
  try {
    const rows = await rpc<CodeRow[]>('tv_issue_pairing_code', {}, caller);
    const row = rows[0];
    if (row) {
      const expiresAt = Date.parse(row.expires_at) || now + CODE_TTL_MS;
      rememberCode(row.code, caller.deviceId, expiresAt);
      return { code: row.code, expiresAt };
    }
  } catch (error) {
    if (!storeUnavailable(error)) throw error;
  }

  pruneCodes(now);
  for (const [code, entry] of codes) {
    if (entry.tvDeviceId === caller.deviceId) codes.delete(code);
  }
  const code = freshCode(now);
  const expiresAt = now + CODE_TTL_MS;
  codes.set(code, { tvDeviceId: caller.deviceId, expiresAt });
  return { code, expiresAt };
}

/**
 * Binds a code shown on a TV to the Alexa identity that spoke it.
 *
 * Exported because the Skill adapter calls it in-process: /alexa already runs
 * in this server, so a PairTvIntent is a function call here rather than an HTTP
 * request back to ourselves.
 */
export async function claimPairing(code: string, caller: Caller): Promise<ClaimResult> {
  const now = Date.now();
  const digits = pairingDigits(code);
  if (digits.length !== 6) return { paired: false, reason: 'invalid_code' };

  try {
    // Authoritative when it answers: the DELETE ... RETURNING in the database
    // is what makes the ticket single use, including against a second instance.
    const tvDeviceId = await rpc<string | null>('tv_claim_pairing', { p_code: digits }, caller);
    if (!tvDeviceId) return { paired: false, reason: 'invalid_code' };

    codes.delete(digits);
    rememberPairing({ tvDeviceId, alexaDeviceId: caller.deviceId, pairedAt: now });
    return { paired: true, tvDeviceId };
  } catch (error) {
    if (!storeUnavailable(error)) throw error;
  }

  // Offline: only a ticket this process drew can be claimed.
  pruneCodes(now);
  const entry = codes.get(digits);
  if (!entry) return { paired: false, reason: 'invalid_code' };

  // Single use: consuming the code is also what stops a second Alexa account
  // from claiming the same television.
  codes.delete(digits);
  rememberPairing({ tvDeviceId: entry.tvDeviceId, alexaDeviceId: caller.deviceId, pairedAt: now });
  return { paired: true, tvDeviceId: entry.tvDeviceId };
}

/**
 * The binding as the Skill sees it: this Alexa account's television.
 *
 * Local first, because anything paired or looked up in this process is already
 * mirrored; the table is consulted after a restart, when the mirror is empty.
 */
async function pairingForAlexa(caller: Caller): Promise<Pairing | null> {
  const cached = pairingsByAlexa.get(caller.deviceId);
  if (cached) return cached;
  try {
    const rows = await get<PairingRow[]>(
      'tv_pairings?select=tv_device_id,alexa_device_id,paired_at' +
        `&alexa_device_id=eq.${encodeURIComponent(caller.deviceId)}`,
      caller,
    );
    const row = rows[0];
    if (!row) return null;
    const pairing = pairingFrom(row);
    rememberPairing(pairing);
    return pairing;
  } catch (error) {
    if (!storeUnavailable(error)) throw error;
    return null;
  }
}

/** The binding as the TV sees it: the Alexa account that claimed this screen. */
async function pairingForTv(caller: Caller): Promise<Pairing | null> {
  const cached = pairingsByTv.get(caller.deviceId);
  if (cached) return cached;
  try {
    const rows = await get<PairingRow[]>(
      'tv_pairings?select=tv_device_id,alexa_device_id,paired_at' +
        `&tv_device_id=eq.${encodeURIComponent(caller.deviceId)}`,
      caller,
    );
    const row = rows[0];
    if (!row) return null;
    const pairing = pairingFrom(row);
    rememberPairing(pairing);
    return pairing;
  } catch (error) {
    if (!storeUnavailable(error)) throw error;
    return null;
  }
}

/**
 * Queues one command for whichever TV this Alexa identity is paired with.
 *
 * Exported for the same reason claimPairing is: the Skill's SearchOnTvIntent
 * runs in this process and must not depend on the server being able to reach
 * its own public origin.
 */
export async function enqueueForAlexa(
  caller: Caller,
  command: TvCommand,
): Promise<{ queued: true; tvDeviceId: string } | { queued: false; reason: 'not_paired' }> {
  const pairing = await pairingForAlexa(caller);
  if (!pairing) return { queued: false, reason: 'not_paired' };
  deliver(pairing.tvDeviceId, command);
  return { queued: true, tvDeviceId: pairing.tvDeviceId };
}

/** Whether this Alexa identity can already drive a TV. */
export async function isPaired(caller: Caller): Promise<boolean> {
  return (await pairingForAlexa(caller)) !== null;
}

/**
 * The television this Alexa identity drives, or null when it is unpaired.
 *
 * The game module needs the id before it has a command to send: the deck and
 * the score are keyed by the screen, and a session has to exist before the
 * first `game.start` can carry a snapshot of it.
 */
export async function tvDeviceIdForAlexa(caller: Caller): Promise<string | null> {
  return (await pairingForAlexa(caller))?.tvDeviceId ?? null;
}

/**
 * Queues one command for a television whose id is already known.
 *
 * Not a second route to a TV: callers only reach this after a pairing lookup,
 * which is what the Skill's game turns do once per utterance.
 */
export function enqueueForTv(tvDeviceId: string, command: TvCommand): void {
  deliver(tvDeviceId, command);
}

function pruneHandoffs(now: number): void {
  for (const [alexaDeviceId, entry] of handoffs) {
    if (now - entry.at > HANDOFF_TTL_MS) handoffs.delete(alexaDeviceId);
  }
}

/**
 * Records what a paired TV could not play.
 *
 * Returns false when no Alexa account has claimed this television. That is not
 * an error: the TV still shows the carrier phrase, and the Skill's usual
 * choice still plays, so the listener only loses exact resume - not sound.
 */
export async function setHandoffForTv(caller: Caller, handoff: TvHandoff): Promise<boolean> {
  const pairing = await pairingForTv(caller);
  if (!pairing) return false;
  const now = Date.now();
  pruneHandoffs(now);
  handoffs.set(pairing.alexaDeviceId, { handoff, at: now });
  return true;
}

/**
 * Consumes the hand-off for this Alexa identity.
 *
 * `kind` matters: a listener who says "play a podcast" after the TV offered a
 * meditation must get a podcast, so a mismatched entry stays in place instead
 * of being silently used or dropped. With no `kind` (AMAZON.ResumeIntent)
 * anything counts.
 */
export function takeHandoff(
  alexaDeviceId: string,
  kind?: TvHandoff['type'],
): TvHandoff | null {
  pruneHandoffs(Date.now());
  const entry = handoffs.get(alexaDeviceId);
  if (!entry) return null;
  if (kind && entry.handoff.type !== kind) return null;
  handoffs.delete(alexaDeviceId);
  return entry.handoff;
}

export interface TvCommandsHealth {
  codes: number;
  pairings: number;
  queued: number;
  waiting: number;
  handoffs: number;
}

export function tvCommandsHealth(): TvCommandsHealth {
  let queued = 0;
  for (const queue of queues.values()) queued += queue.length;
  return {
    codes: codes.size,
    // The mirror, not the table: /health is synchronous and must not depend on
    // the API. After a restart this reads 0 until a lookup hydrates it, even
    // though the bindings are still durable.
    pairings: pairingsByAlexa.size,
    queued,
    waiting: waiters.size,
    handoffs: handoffs.size,
  };
}

/**
 * Resolves a Podcast Index feed id to the show the TV's player renders.
 *
 * `null` means the catalogue has no such show; a proxy or network failure is
 * rethrown so the route can answer 502 rather than pretend the feed does not
 * exist. The proxy's own /v1/podcast/feeds/:id route owns the upstream lookup
 * and the blocked-feed rules, so this server holds no second copy of them.
 */
async function resolveFeed(feedId: number, caller: Caller): Promise<PodcastFeed | null> {
  try {
    const { feed } = await callProxy<{ feed: PodcastFeed }>(
      'podcast',
      `/v1/podcast/feeds/${feedId}`,
      caller,
    );
    return feed;
  } catch (error) {
    if (error instanceof ProxyError && error.status === 404) return null;
    throw error;
  }
}

export function registerTvCommandsRoute(app: FastifyInstance): void {
  // --- The TV asks to be paired -------------------------------------------
  // Called from the app's pairing screen. The code is the only thing the TV
  // has to show; it never learns the Alexa identity that claims it.
  app.post('/v1/tv/pair', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({
        error:
          'Pairing needs the same X-Device-Id (or demo bearer) that /mcp accepts, ' +
          'so the code belongs to one television.',
      });
    }

    // The durable issue replaces this TV's previous code and prunes expired
    // tickets, so re-requesting never leaves an old code claimable.
    const issued = await issueCode(caller);

    return reply.send({
      code: issued.code,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      spoken:
        'Open Globie Earth on your TV and say: pair my TV, ' +
        issued.code.split('').join(' ') +
        '.',
    });
  });

  // --- The Skill claims the code, binding one Alexa identity to one TV ----
  // The Skill's caller is a device id derived from the Alexa user id
  // (alexa.ts: deviceIdFor), so this is the same identity the Skill uses for
  // every tool call.
  app.post('/v1/alexa/pair', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({
        error:
          'Pairing needs the Skill caller identity the Alexa adapter already sends, ' +
          'so the binding belongs to one account.',
      });
    }

    const body = (request.body ?? {}) as { code?: unknown };
    const code = readString(body.code) ?? '';
    const digits = pairingDigits(code);
    if (digits.length !== 6) {
      return reply.code(400).send({ error: 'Say the six-digit code shown on the TV.' });
    }

    if (!(await claimPairing(digits, caller)).paired) {
      return reply.code(404).send({
        error: 'That code is not valid. Ask the TV for a new one and try again.',
      });
    }

    return reply.send({
      paired: true,
      spoken: 'Paired. You can now ask me to search the TV.',
    });
  });

  // --- The Skill queues a command for its paired TV -----------------------
  app.post('/v1/tv/commands', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Sending a TV command needs a caller identity.' });
    }

    const pairing = await pairingForAlexa(caller);
    if (!pairing) {
      return reply.code(409).send({
        error: 'This Alexa account is not paired with a TV yet.',
        spoken: 'No TV is paired yet. Open Globie Earth on the TV and say: pair my TV.',
      });
    }

    const body = (request.body ?? {}) as {
      type?: unknown;
      query?: unknown;
      feedId?: unknown;
      screen?: unknown;
    };
    const type = readString(body.type);
    let command: TvCommand;
    if (type === 'search') {
      const query = readString(body.query);
      if (!query || query.length > QUERY_MAX) {
        return reply
          .code(400)
          .send({ error: `A search needs a query of 1 to ${QUERY_MAX} characters.` });
      }
      command = { type: 'search', query };
    } else if (type === 'openFeed') {
      const feedId = Number(body.feedId);
      if (!Number.isInteger(feedId) || feedId <= 0) {
        return reply.code(400).send({ error: 'openFeed needs a positive numeric feedId.' });
      }

      // Resolve before queueing: the TV has no feed-by-id route, so a bare id
      // would arrive as a player with nothing to render. An unknown show is a
      // refusal here rather than a silent no-op on the television.
      let feed: PodcastFeed | null;
      try {
        feed = await resolveFeed(feedId, caller);
      } catch (error) {
        request.log.error({ err: error, feedId }, 'resolving a TV feed failed');
        return reply.code(502).send({ error: 'The podcast catalogue is unavailable.' });
      }
      if (!feed) {
        return reply.code(404).send({ error: 'No show with that feed id is in the library.' });
      }

      command = { type: 'openFeed', feedId, feed };
    } else if (type === 'home') {
      command = { type: 'home' };
    } else if (type === 'back') {
      command = { type: 'back' };
    } else if (type === 'openScreen') {
      const screen = readString(body.screen);
      if (!isTvScreen(screen)) {
        return reply
          .code(400)
          .send({ error: `openScreen needs a screen of: ${TV_SCREENS.join(', ')}.` });
      }
      command = { type: 'openScreen', screen };
    } else if (type === 'player.pause') {
      command = { type: 'player.pause' };
    } else if (type === 'player.resume') {
      command = { type: 'player.resume' };
    } else {
      return reply.code(400).send({
        error: 'type must be search, openFeed, home, back, openScreen, player.pause or player.resume.',
      });
    }

    deliver(pairing.tvDeviceId, command);
    return reply.send({ sent: true, tvDeviceId: pairing.tvDeviceId, command });
  });

  // --- The TV long-polls for the next command -----------------------------
  // Header identity, not a query parameter: a device id in the URL would let
  // anyone drain another television's queue.
  app.get('/v1/tv/commands', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Polling for TV commands needs a caller identity.' });
    }

    const query = request.query as { waitMs?: unknown };
    const requested = Number(query.waitMs);
    const waitMs = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), WAIT_MAX_MS)
      : WAIT_DEFAULT_MS;

    const now = Date.now();
    const immediate = takeCommand(caller.deviceId, now);
    // `paired` is always present: the app renders its pairing card from it, and
    // a missing field would read as unpaired even while a command arrives.
    if (immediate) return reply.send({ command: immediate, paired: true });

    // No pairing means nothing can arrive, so answer at once instead of making
    // the app wait out a poll that has no sender.
    if (!(await pairingForTv(caller))) {
      return reply.send({ command: null, paired: false });
    }

    const command = await waitForCommand(caller.deviceId, waitMs);
    return reply.send({ command, paired: true });
  });

  // --- The TV hands its audio to the paired Echo --------------------------
  // A Vega build with no audio sink fails every play with
  // MEDIA_ERR_SRC_NOT_SUPPORTED (the virtual device is the common case), so
  // the TV posts what it wanted to hear and shows a carrier phrase. The
  // Skill's next audio intent consumes this and plays the same item instead
  // of a random one. Unpaired TVs get {stored:false} rather than an error:
  // the phrase still works, they just lose exact resume.
  app.post('/v1/tv/handoff', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({
        error: 'A hand-off needs the same X-Device-Id (or demo bearer) that polling uses.',
      });
    }

    const body = (request.body ?? {}) as {
      type?: unknown;
      minutes?: unknown;
      guideId?: unknown;
      feedId?: unknown;
      episodeId?: unknown;
    };
    const type = readString(body.type);
    let handoff: TvHandoff;

    if (type === 'meditation') {
      const raw = body.minutes;
      const minutes = raw === null || raw === undefined ? null : Number(raw);
      if (minutes !== null && !HANDOFF_MINUTES.has(minutes)) {
        return reply.code(400).send({ error: 'minutes must be 10, 15, 30 or null.' });
      }
      const guideId = readString(body.guideId) ?? '';
      if (!guideId || guideId.length > 40) {
        return reply.code(400).send({ error: 'A meditation hand-off needs a guideId.' });
      }
      handoff = { type: 'meditation', minutes, guideId };
    } else if (type === 'podcast') {
      const feedId = Number(body.feedId);
      const episodeId = Number(body.episodeId);
      if (
        !Number.isInteger(feedId) ||
        feedId <= 0 ||
        !Number.isInteger(episodeId) ||
        episodeId <= 0
      ) {
        return reply.code(400).send({
          error: 'A podcast hand-off needs numeric feedId and episodeId.',
        });
      }
      handoff = { type: 'podcast', feedId, episodeId };
    } else {
      return reply.code(400).send({ error: 'type must be meditation or podcast.' });
    }

    return reply.send({ stored: await setHandoffForTv(caller, handoff), handoff });
  });
}
