// Family party challenges: one quiz, one server-owned clock, one score.
//
// The solo game keeps its score in the app and mirrors it through tvGame.ts.
// A challenge cannot: four people share one remote, so "who answered, and how
// quickly" is a fact only the server can observe. This module therefore owns
// the room, the round clock, the score and the payout, and the TV draws the
// whole state that arrives over the existing long poll.
//
// The room is held twice: in a Map here, where every request in this process
// mutates one object, and in api.challenge_rooms through challengeStore.ts, so
// a redeploy does not end a party that is still being played. Phase B grows
// that store - atomic join, atomic answer - rather than adding a second one.
//
// There is one judge. Answers are compared by evaluateAnswer in tvGame.ts, so
// a spoken answer, a D-pad press and a challenge answer cannot disagree about
// which option was right; only the scoring around it lives here.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import QRCode from 'qrcode';

import {
  byToken,
  claimAnswer,
  create,
  byCode,
  deckByCode,
  joinMember,
  leave,
  load,
  recordAnswer,
  save,
  type ReadOutcome,
} from './challengeStore.js';
import { resolveCaller } from './identity.js';
import type { Caller } from './identity.js';
import { forgetPresence, presenceFramePath, presenceTiles } from './presenceStore.js';
import { enqueueForTv } from './tvCommands.js';
import {
  DECK_ROUNDS_MAX,
  evaluateAnswer,
  lockDeckForChallenge,
  parseGameRound,
  unlockDeckForChallenge,
  type GameChoice,
  type GameDeck,
  type GameDeckRound,
} from './tvGame.js';
import { awardEcoTokens } from './tvWallet.js';

export type ChallengePhase = 'lobby' | 'playing' | 'standings' | 'finished';

export interface ChallengePlayer {
  /** 1..8, stable, drawn when the player joins. */
  slot: number;
  name: string;
  /** 0 = solo/no team colour. A view over one score list, not a second engine. */
  team: 0 | 1;
  score: number;
  streak: number;
  correct: number;
  /**
   * How many of this seat's answers landed after the window. A late answer is
   * scored for accuracy only, so the podium carries the count rather than
   * leaving a low score looking like a wrong one.
   */
  lateAnswers?: number;
  /** Set in Phase B/C; null in Phase A, where every slot shares one device. */
  deviceId: string | null;
  /**
   * The credential a phone presents on every answer; null for a seat the
   * television itself owns.
   *
   * It is minted on join and rotated on rejoin, so it is written to the member
   * row but never composed back out: api.challenge_state must not hand one
   * seat's credential to whoever reads the room.
   */
  token: string | null;
  /**
   * roundId -> choice, for this slot's whole party.
   *
   * The room's roundAnswers is cleared per round because Phase A's party runs
   * on one clock. A Phase B household plays the frozen deck on its own, so the
   * member's history is what stops a second press on the same question from
   * scoring twice.
   */
  answered: Record<string, string>;
}

/** A player as the television draws them: no device identity leaves the room. */
export interface ChallengePlayerView {
  slot: number;
  name: string;
  team: 0 | 1;
}

export interface ChallengeLobby {
  roomId: string;
  code: string;
  deckId: string;
  phase: ChallengePhase;
  players: ChallengePlayerView[];
  expiresAt: number;
}

/**
 * What a household gets after typing a code: the room and its frozen deck.
 *
 * The deck travels with its answer keys because the joining television has to
 * judge its own presses: one publisher, one deck, byte-identical for both
 * households. The host's device id is deliberately absent - each household is
 * paid on its own device, so neither needs the other's identity.
 */
export interface ChallengeInvitation {
  roomId: string;
  code: string;
  deckId: string;
  deck: GameDeck;
  phase: ChallengePhase;
  players: ChallengeStanding[];
  expiresAt: number;
}

/** A deck round minus the answer key: the TV renders, it does not hold the key. */
export interface ChallengeQuestion {
  roundId: string;
  options: GameChoice[];
  clues: string[];
  hasPhoto: boolean;
  /** The species photo, so a room round can draw it instead of a question mark. */
  image?: string | null;
}

export interface ChallengeStanding {
  slot: number;
  name: string;
  team: 0 | 1;
  score: number;
  correct: number;
  streak: number;
  /** Answers that landed after the window; they score accuracy only. */
  lateAnswers?: number;
  /**
   * roundId -> choice for this seat's whole party. It is what a head-to-head
   * screen turns into a tick per round; the television already holds the
   * frozen deck, so no answer key has to travel beside it.
   */
  answered: Record<string, string>;
}

export interface ChallengeAward {
  tokens: number;
  awarded: number;
  balance: number | null;
  available: boolean;
}

/** The room as this process mutates it; challengeStore maps it to the row. */
export interface ChallengeRoom {
  roomId: string;
  code: string;
  phase: ChallengePhase;
  deckId: string;
  /** Frozen at creation; never republished while the room lives. */
  deck: GameDeck;
  hostDeviceId: string;
  players: ChallengePlayer[];
  roundIndex: number;
  /** Epoch ms of the push that started the round. The scoring clock. */
  roundStartedAt: number;
  /** Slot -> choice key, for the current round only. */
  roundAnswers: Map<number, string>;
  expiresAt: number;
  awarded: boolean;
  lastAward: ChallengeAward | null;
  at: number;
}

/** A party that nobody touched for half an hour is over. */
const ROOM_TTL_MS = 30 * 60_000;
/** Long enough to read four options; short enough to keep a party moving. */
const ROUND_MS = 15_000;
/**
 * The network's share. An answer that arrives after the window still counts
 * for accuracy - a slow uplink should cost points, not the round - but earns
 * neither the speed nor the streak bonus.
 */
const ANSWER_GRACE_MS = 2_000;

const BASE = 100;
const SPEED_MAX = 60;
const STREAK_STEP = 20;
const STREAK_MAX = 60;
/** tokens = floor(points / 20), hard-capped at the ledger's single-award limit. */
const POINTS_PER_TOKEN = 20;
const TOKENS_MAX = 500;

const PLAYERS_MIN = 2;
/** The shared shape allows eight; Phase A's lobby draws four tiles. */
const SLOTS_MAX = 8;
const NAME_MAX = 16;
const CODE_LENGTH = 6;

/**
 * Where a phone is sent to play.
 *
 * A television prints and encodes `CHALLENGE_PLAY_URL` because it is the short
 * host every client already knows, but the board itself is a static bundle on
 * its own host: `/play/<code>` here redirects there rather than serving a page
 * this process cannot render.
 */
const PLAY_PAGE_BASE = (process.env.CHALLENGE_PLAY_URL ?? 'https://mcp.globie.earth/play').replace(/\/+$/, '');
const PLAY_BOARD_BASE = (process.env.CHALLENGE_BOARD_URL ?? 'https://mcp-client.globie.earth/play').replace(/\/+$/, '');

/** The one address a phone types, scans or is read aloud for a room. */
export function playUrlFor(code: string): string {
  return `${PLAY_PAGE_BASE}/${code}`;
}

/**
 * The working copy.
 *
 * A room lives here for the life of this process and is written through to the
 * store on every change; a room read back from the store is promoted into it,
 * so one request never sees two objects for one id. The Map is also what makes
 * the store optional: when the API is unreachable the party runs exactly as
 * Phase A did.
 */
const rooms = new Map<string, ChallengeRoom>();

/**
 * The plan's scoring table, in one place.
 *
 * `streakAfter` is the count *including* this answer, so the third consecutive
 * correct answer is the first to earn a bonus. `elapsedMs` is measured from
 * the server's push to the server's receipt - the client never names a
 * duration, because a client that can name its own speed will name a fast one.
 */
export function scoreForAnswer(correct: boolean, elapsedMs: number, streakAfter: number): number {
  if (!correct) return 0;
  if (elapsedMs > ROUND_MS + ANSWER_GRACE_MS) return BASE;

  const remaining = Math.max(0, ROUND_MS - Math.max(0, elapsedMs));
  const speed = Math.round((SPEED_MAX * remaining) / ROUND_MS);
  const streak = Math.min(STREAK_MAX, STREAK_STEP * Math.max(0, streakAfter - 2));
  return BASE + speed + streak;
}

function readText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function playersView(room: ChallengeRoom): ChallengePlayerView[] {
  return room.players.map(player => ({
    slot: player.slot,
    name: player.name,
    team: player.team,
  }));
}

function lobbyOf(room: ChallengeRoom): ChallengeLobby {
  return {
    roomId: room.roomId,
    code: room.code,
    deckId: room.deckId,
    phase: room.phase,
    players: playersView(room),
    expiresAt: room.expiresAt,
  };
}

/** The in-memory room in the shape challenge_deck_by_code returns. */
function invitationOf(room: ChallengeRoom): ChallengeInvitation {
  return {
    roomId: room.roomId,
    code: room.code,
    deckId: room.deckId,
    deck: room.deck,
    phase: room.phase,
    players: [...room.players]
      .sort((left, right) => left.slot - right.slot)
      .map(player => ({
        slot: player.slot,
        name: player.name,
        team: player.team,
        score: player.score,
        correct: player.correct,
        streak: player.streak,
        lateAnswers: player.lateAnswers ?? 0,
        answered: {...player.answered},
      })),
    expiresAt: room.expiresAt,
  };
}

/** Highest score first, then accuracy, then the earlier slot. */
function standingsOf(room: ChallengeRoom): ChallengeStanding[] {
  return [...room.players]
    .sort((left, right) => right.score - left.score || right.correct - left.correct || left.slot - right.slot)
    .map(player => ({
      slot: player.slot,
      name: player.name,
      team: player.team,
      score: player.score,
      correct: player.correct,
      streak: player.streak,
      lateAnswers: player.lateAnswers ?? 0,
      answered: {...player.answered},
    }));
}

/** Keeps the room alive and its deck frozen for as long as it is in use. */
function touch(room: ChallengeRoom, now: number): void {
  room.at = now;
  room.expiresAt = now + ROOM_TTL_MS;
  lockDeckForChallenge(room.hostDeviceId, room.roomId, room.expiresAt);
}

function closeRoom(room: ChallengeRoom, reason: 'expired' | 'host_left'): void {
  rooms.delete(room.roomId);
  // Cameras belong to the party, not the process: a closed room holds none.
  forgetPresence(room.roomId);
  unlockDeckForChallenge(room.hostDeviceId, room.roomId);
  // The id travels with the reason: a lobby that is replacing a stale room
  // closes it itself, and the television must not read that push as the end of
  // the room it is showing.
  enqueueForTv(room.hostDeviceId, {
    type: 'challenge.closed',
    reason,
    roomId: room.roomId,
  });
  publishClosed(room, reason);
}

function pruneRooms(now: number): void {
  for (const [roomId, room] of rooms) {
    if (room.expiresAt > now) continue;
    rooms.delete(roomId);
    closeRoom(room, 'expired');
  }
}

/**
 * The room, from this process when it holds one and from the store when it
 * does not - which is every action after the relay restarted.
 *
 * A stored room is promoted into the Map and freezes the deck again: the lock
 * in tvGame.ts is per-process, so the guard has to be re-taken on the way in,
 * not only when the lobby was opened.
 */
async function liveRoom(roomId: string, now: number, caller: Caller): Promise<ChallengeRoom | null> {
  pruneRooms(now);

  const cached = rooms.get(roomId);
  if (cached) return cached;

  const stored = await load(roomId, caller);
  if (stored.kind !== 'found') return null;
  const room = stored.value;
  if (room.expiresAt <= now) return null;
  rooms.set(room.roomId, room);
  lockDeckForChallenge(room.hostDeviceId, room.roomId, room.expiresAt);
  return room;
}

/**
 * A room by its digits from this process only.
 *
 * The frame image is loaded by an image component, which sends no identity
 * header, so that one route is anonymous by the code - the same contract as
 * qr.png. The television that knows the code has already hydrated the room
 * with its presence poll; this reads back that copy.
 */
export function residentRoomByCode(code: string, now: number): ChallengeRoom | null {
  pruneRooms(now);
  for (const room of rooms.values()) {
    if (room.code === code) return room;
  }
  return null;
}

export async function roomByCode(code: string, now: number, caller: Caller): Promise<ChallengeRoom | null> {
  pruneRooms(now);

  for (const room of rooms.values()) {
    if (room.code === code) return room;
  }

  const stored = await byCode(code, caller);
  if (stored.kind !== 'found') return null;
  const room = stored.value;
  if (room.expiresAt <= now) return null;
  rooms.set(room.roomId, room);
  lockDeckForChallenge(room.hostDeviceId, room.roomId, room.expiresAt);
  return room;
}

/** Six digits, unique among the rooms that are still live. */
function freshCode(now: number): string | null {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0');
    let taken = false;
    for (const room of rooms.values()) {
      if (room.code === code && room.expiresAt > now) {
        taken = true;
        break;
      }
    }
    if (!taken) return code;
  }
  return null;
}

function freeSlot(room: ChallengeRoom): number | null {
  for (let slot = 1; slot <= SLOTS_MAX; slot += 1) {
    if (!room.players.some(player => player.slot === slot)) return slot;
  }
  return null;
}

function questionOf(round: GameDeckRound): ChallengeQuestion {
  return {
    roundId: round.roundId,
    options: round.options,
    clues: round.clues,
    hasPhoto: round.hasPhoto,
    ...(round.image ? { image: round.image } : {}),
  };
}

function pushQuestion(room: ChallengeRoom, now: number): void {
  const round = room.deck.rounds[room.roundIndex];
  if (!round) return;
  enqueueForTv(room.hostDeviceId, {
    type: 'challenge.question',
    round: questionOf(round),
    index: room.roundIndex,
    total: room.deck.rounds.length,
    endsAt: now + ROUND_MS,
  });
  publish(room);
}

/**
 * Pays each household on its own device.
 *
 * Phase A's seats all share the host's device, so the sum is exactly the number
 * Phase A paid. Phase B's two households each earn their own total, and the key
 * carries the device, so replaying the same room credits neither one twice.
 *
 * `tokens` is what the room earned in total; `awarded` is what the ledger
 * actually added for it, which is 0 on a replay. A balance only means something
 * for a single device, so a two-household room reports none.
 */
async function finishRoom(room: ChallengeRoom, now: number): Promise<void> {
  room.phase = 'finished';
  room.at = now;
  room.expiresAt = now + ROOM_TTL_MS;
  unlockDeckForChallenge(room.hostDeviceId, room.roomId);

  if (room.awarded) return;
  room.awarded = true;

  const points = new Map<string, number>();
  for (const player of room.players) {
    if (!player.deviceId) continue;
    points.set(player.deviceId, (points.get(player.deviceId) ?? 0) + player.score);
  }

  const shares: Array<{ deviceId: string; tokens: number }> = [];
  for (const [deviceId, total] of points) {
    const tokens = Math.min(TOKENS_MAX, Math.floor(total / POINTS_PER_TOKEN));
    if (tokens >= 1) shares.push({ deviceId, tokens });
  }

  const tokens = shares.reduce((sum, share) => sum + share.tokens, 0);
  if (tokens < 1) {
    room.lastAward = { tokens: 0, awarded: 0, balance: null, available: false };
    return;
  }

  let awarded = 0;
  let balance = 0;
  let available = true;
  for (const share of shares) {
    const result = await awardEcoTokens(
      { deviceId: share.deviceId },
      `challenge:${room.roomId}:${share.deviceId}`,
      share.tokens,
    );
    awarded += result.awarded;
    if (result.balance === null) available = false;
    else balance += result.balance;
  }

  room.lastAward = {
    tokens,
    awarded,
    balance: available && shares.length === 1 ? balance : null,
    available,
  };
}

/**
 * Closes the round on screen.
 *
 * A slot that did not answer is a skip: no points, streak reset. That is what
 * lets the host press NEXT while someone is in the kitchen, and it is also the
 * recovery path when a client goes away mid-round.
 *
 * The last round finishes the room here rather than waiting for NEXT: the
 * server already knows every slot answered, and making the host press a key to
 * be paid would add a way to lose the payout.
 */
async function closeRound(
  room: ChallengeRoom,
  now: number,
): Promise<{ rows: ChallengeStanding[]; final: boolean }> {
  for (const player of room.players) {
    if (!room.roundAnswers.has(player.slot)) player.streak = 0;
  }

  const rows = standingsOf(room);
  const last = room.roundIndex >= room.deck.rounds.length - 1;

  if (last) {
    await finishRoom(room, now);
  } else {
    room.phase = 'standings';
  }

  // The payout rides the last ranking: a room that phones closed never asks
  // the host for NEXT, so this push is the only way the board learns it.
  enqueueForTv(room.hostDeviceId, {
    type: 'challenge.standings',
    rows,
    final: last,
    award: last ? room.lastAward : null,
  });
  publish(room);
  return { rows, final: last };
}

// --- Phones ---------------------------------------------------------------
//
// A phone is not a television: it has no long poll, no copy of the deck, and
// no reason to be trusted with an answer key. It joins with the six digits,
// keeps the token it is handed, and watches the room over SSE. Everything it
// may see is composed here, in one place, so the key has one shape to escape
// by and it is not this one.

/** A seat as a phone draws it: a score, and whether it has answered. */
interface PhonePlayer {
  slot: number;
  name: string;
  team: 0 | 1;
  score: number;
  correct: number;
  streak: number;
  /** True once this seat claimed an answer for the round on screen. */
  answered: boolean;
}

/**
 * The room as a phone may see it.
 *
 * `answered` is a boolean rather than the standing's roundId -> choice map on
 * purpose: a phone that could read another seat's choice during the round
 * would have the answer key back.
 */
interface PhoneState {
  roomId: string;
  code: string;
  phase: ChallengePhase;
  index: number;
  total: number;
  /** The card, minus the key. Null in the lobby and between rounds. */
  question: ChallengeQuestion | null;
  /** Epoch ms the answer window closes; 0 when there is no window. */
  endsAt: number;
  players: PhonePlayer[];
  /**
   * Which seats are offering a camera, and where their latest frame is.
   *
   * A path, not bytes: a phone may draw a peer, but the phone's own camera is
   * the one that costs it uplink. Presence is off until a seat turns it on.
   */
  presence: Array<{ slot: number; on: boolean; frameUrl: string | null }>;
  award: ChallengeAward | null;
}

type PhoneEvent =
  | { type: 'challenge.state'; state: PhoneState }
  | { type: 'challenge.closed'; reason: 'expired' | 'host_left' };

function phoneStateOf(room: ChallengeRoom): PhoneState {
  const round = room.deck.rounds[room.roundIndex];
  const playing = room.phase === 'playing' && round !== undefined;
  return {
    roomId: room.roomId,
    code: room.code,
    phase: room.phase,
    index: room.roundIndex,
    total: room.deck.rounds.length,
    question: playing ? questionOf(round) : null,
    endsAt: playing ? room.roundStartedAt + ROUND_MS + ANSWER_GRACE_MS : 0,
    players: [...room.players]
      .sort((left, right) => left.slot - right.slot)
      .map(player => ({
        slot: player.slot,
        name: player.name,
        team: player.team,
        score: player.score,
        correct: player.correct,
        streak: player.streak,
        answered: Boolean(round && player.answered[round.roundId]) || room.roundAnswers.has(player.slot),
      })),
    presence: presenceTiles(room.roomId, room.players.map(player => player.slot), Date.now()).map(tile => ({
      slot: tile.slot,
      on: tile.on,
      frameUrl: presenceFramePath(room.code, tile),
    })),
    award: room.lastAward,
  };
}

/** One connection per phone; the set is emptied by the stream's own close. */
const listeners = new Map<string, Set<(event: PhoneEvent) => void>>();

function subscribe(roomId: string, listener: (event: PhoneEvent) => void): () => void {
  let set = listeners.get(roomId);
  if (!set) {
    set = new Set();
    listeners.set(roomId, set);
  }
  const owned = set;
  owned.add(listener);
  return () => {
    owned.delete(listener);
    if (owned.size === 0) listeners.delete(roomId);
  };
}

/** Mirrors a TV push to the phones watching the same room. */
export function publish(room: ChallengeRoom): void {
  const set = listeners.get(room.roomId);
  if (!set) return;
  const event: PhoneEvent = { type: 'challenge.state', state: phoneStateOf(room) };
  for (const listener of set) listener(event);
}

function publishClosed(room: ChallengeRoom, reason: 'expired' | 'host_left'): void {
  const set = listeners.get(room.roomId);
  if (!set) return;
  for (const listener of set) listener({ type: 'challenge.closed', reason });
}

/** How often a quiet stream proves it is still there; proxies cut silent ones. */
const STREAM_BEAT_MS = 25_000;

/**
 * One SSE frame.
 *
 * Only two event names ever leave here, and neither carries a key: a phone
 * draws the card without the answer, and learns whether *it* was right from
 * its own answer response.
 */
function writeFrame(raw: ServerResponse, event: string, data: unknown): void {
  if (raw.writableEnded || raw.destroyed) return;
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A token is a UUID; anything else is refused before it reaches Postgres. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The public write endpoints' only guard against a scripted burst.
 *
 * A fixed window is enough: there is no account to punish and no score to
 * protect, only a party that must not be drowned by a loop. The answer limit
 * is generous because six phones on one Wi-Fi share an egress address.
 */
export const RATE_WINDOW_MS = 60_000;
const JOIN_PER_IP = 60;
const ANSWER_PER_IP = 120;
const ANSWERS_PER_ROOM = 240;
const rateHits = new Map<string, { count: number; resetAt: number }>();

/** Shared with the presence routes so one window guards every public write. */
export function overLimit(key: string, limit: number, now: number): boolean {
  if (rateHits.size > 2048) {
    for (const [stale, entry] of rateHits) if (entry.resetAt <= now) rateHits.delete(stale);
  }
  const entry = rateHits.get(key);
  if (!entry || entry.resetAt <= now) {
    rateHits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

/**
 * The room a phone's token names, from this process when it holds one and from
 * the store when it does not.
 *
 * A stored room comes back with every seat's token nulled by the compositor, so
 * the one token presented on this request is re-attached to the seat it owns -
 * that is the only credential this request may act with.
 */
export async function tokenRoom(
  token: string,
  now: number,
  caller: Caller,
): Promise<{ room: ChallengeRoom; slot: number } | null> {
  pruneRooms(now);

  for (const room of rooms.values()) {
    const player = room.players.find(candidate => candidate.token === token);
    if (player) return { room, slot: player.slot };
  }

  const stored = await byToken(token, caller);
  if (stored.kind !== 'found') return null;
  const { room, slot } = stored.value;
  if (room.expiresAt <= now) return null;
  const player = room.players.find(candidate => candidate.slot === slot);
  if (player) player.token = token;
  rooms.set(room.roomId, room);
  lockDeckForChallenge(room.hostDeviceId, room.roomId, room.expiresAt);
  return { room, slot };
}

type JoinRefusal = { status: 400 | 404 | 409; error: string; code?: string };
type JoinResult = { kind: 'joined'; room: ChallengeRoom; player: ChallengePlayer } | { kind: 'refused'; refusal: JoinRefusal };

/**
 * Takes the next free seat for the caller's own device.
 *
 * Shared by the television's join and the phone's, because the room does not
 * care which one is asking: the difference is only what the response shows.
 * The token is minted here, never by the client, and challenge_join's upsert
 * rotates it on a rejoin.
 */
async function joinSeat(
  room: ChallengeRoom,
  caller: Caller,
  name: string,
  team: 0 | 1,
  now: number,
): Promise<JoinResult> {
  if (room.phase !== 'lobby') {
    return { kind: 'refused', refusal: { status: 409, error: 'That room has already started.', code: 'room_closed' } };
  }

  const slot = freeSlot(room);
  if (!slot) {
    return { kind: 'refused', refusal: { status: 409, error: 'That room is full.', code: 'room_full' } };
  }

  const player: ChallengePlayer = {
    slot,
    name,
    team,
    score: 0,
    streak: 0,
    correct: 0,
    lateAnswers: 0,
    // The joining device owns the seat, so the payout at the end can pay it
    // rather than the host. Phase A's four seats all share the host's device.
    deviceId: caller.deviceId,
    // Minted here rather than at the phone: the credential has to be
    // unguessable, and it is rotated on every rejoin by challenge_join's
    // upsert. A television that joins with its own device id also gets one,
    // which keeps the route to one shape.
    token: randomUUID(),
    answered: {},
  };
  room.players.push(player);
  touch(room, now);

  // The host writes the whole room; a joining household may only write the
  // seat it just took, because challenge_save refuses anyone but the host.
  if (room.hostDeviceId === caller.deviceId) {
    await save(room, caller);
  } else {
    const seat = await joinMember(room.roomId, player, caller);
    if (seat === 'slot_taken') {
      // Another phone claimed the seat between this route's read and its
      // write. Drop the phantom seat so the in-process room stays true.
      room.players = room.players.filter(candidate => candidate.slot !== slot);
      return { kind: 'refused', refusal: { status: 409, error: 'That room is full.', code: 'room_full' } };
    }
  }

  enqueueForTv(room.hostDeviceId, { type: 'challenge.lobby', room: lobbyOf(room) });
  publish(room);
  return { kind: 'joined', room, player };
}

export function registerChallengeRoutes(app: FastifyInstance): void {
  // --- The join link a television prints and a phone scans ----------------
  /**
   * GET /play/:code - the address on the television.
   *
   * The board is a static bundle on its own host, so this is a redirect, not a
   * page. Keeping the redirect here means the link a player reads or scans is
   * the same host they already know, and the board can move without reprinting
   * every code.
   */
  app.get('/play/:code', async (request, reply) => {
    const params = request.params as { code?: unknown };
    const code = typeof params.code === 'string' ? params.code.trim() : '';
    if (!new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(code)) {
      return reply
        .code(404)
        .send({ error: `A play link is /play/<${CODE_LENGTH} digits>.`, code: 'invalid_code' });
    }
    return reply.redirect(`${PLAY_BOARD_BASE}/${code}`, 302);
  });

  /**
   * GET /v1/challenge/:code/qr.png - the same link as a square.
   *
   * Drawn here rather than on the television: the app ships no QR encoder, and
   * a phone camera only needs the PNG. No identity is required because an
   * <Image> cannot send a header; the code itself is the secret, exactly as it
   * is when it is read aloud.
   */
  app.get('/v1/challenge/:code/qr.png', async (request, reply) => {
    const now = Date.now();
    if (overLimit(`qr:${request.ip}`, JOIN_PER_IP, now)) {
      return reply
        .code(429)
        .send({ error: 'Too many codes from this address.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    const params = request.params as { code?: unknown };
    const code = typeof params.code === 'string' ? params.code.trim() : '';
    if (!new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(code)) {
      return reply
        .code(400)
        .send({ error: `A join code is ${CODE_LENGTH} digits.`, code: 'invalid_code' });
    }

    const png = await QRCode.toBuffer(playUrlFor(code), {
      type: 'png',
      width: 360,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1a14', light: '#ffffff' },
    });
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=300')
      .send(png);
  });

  // --- The host freezes a deck and opens a lobby -------------------------
  app.post('/v1/tv/challenge', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Opening a challenge needs a caller identity.' });
    }

    const now = Date.now();
    pruneRooms(now);

    // One open room per host. A finished room may still be on screen for its
    // podium, which is why it does not count.
    for (const room of rooms.values()) {
      if (room.hostDeviceId === caller.deviceId && room.phase !== 'finished') {
        return reply.code(409).send({
          error: 'A challenge is already open on this television.',
          code: 'room_live',
          roomId: room.roomId,
        });
      }
    }

    const body = (request.body ?? {}) as { rounds?: unknown };
    if (!Array.isArray(body.rounds) || body.rounds.length < 1 || body.rounds.length > DECK_ROUNDS_MAX) {
      return reply.code(400).send({ error: `A challenge needs 1 to ${DECK_ROUNDS_MAX} rounds.` });
    }

    const rounds: GameDeckRound[] = [];
    for (const raw of body.rounds) {
      const round = parseGameRound(raw);
      if (!round) {
        return reply
          .code(400)
          .send({ error: 'Each round needs a roundId, an answerKey among three options, and clues.' });
      }
      if (rounds.some(existing => existing.roundId === round.roundId)) {
        return reply.code(400).send({ error: 'Round ids must be unique within a deck.' });
      }
      rounds.push(round);
    }

    const code = freshCode(now);
    if (!code) {
      return reply.code(503).send({ error: 'No room code is free right now.', code: 'code_unavailable' });
    }

    // Content-addressed: the same questions produce the same id, which is what
    // lets Phase B prove two households played the identical deck.
    const digest = createHash('sha256').update(JSON.stringify(rounds)).digest('hex');
    const deck = { deckId: `deck-${digest.slice(0, 48)}`, rounds };

    const room: ChallengeRoom = {
      roomId: randomUUID(),
      code,
      phase: 'lobby',
      deckId: deck.deckId,
      deck,
      hostDeviceId: caller.deviceId,
      players: [],
      roundIndex: 0,
      roundStartedAt: 0,
      roundAnswers: new Map(),
      expiresAt: now + ROOM_TTL_MS,
      awarded: false,
      lastAward: null,
      at: now,
    };

    // Store before publishing: the digits are unique across live rooms, and a
    // code a room opened before the last restart still owns has to be drawn
    // again rather than silently shadowed. The Map alone cannot see that room.
    const outcome = await create(room, caller);
    if (outcome === 'code_taken') {
      return reply.code(503).send({ error: 'No room code is free right now.', code: 'code_unavailable' });
    }

    rooms.set(room.roomId, room);
    lockDeckForChallenge(caller.deviceId, room.roomId, room.expiresAt);

    enqueueForTv(caller.deviceId, { type: 'challenge.lobby', room: lobbyOf(room) });
    return reply.send({
      roomId: room.roomId,
      code: room.code,
      deckId: room.deckId,
      phase: room.phase,
      expiresAt: room.expiresAt,
    });
  });

  // --- A player takes a slot ---------------------------------------------
  app.post('/v1/tv/challenge/join', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Joining a challenge needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { code?: unknown; name?: unknown; team?: unknown };
    const code = readText(body.code, CODE_LENGTH);
    const name = readText(body.name, NAME_MAX);
    if (!code || !new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(code)) {
      return reply.code(400).send({ error: `A join needs a ${CODE_LENGTH}-digit code.` });
    }
    if (!name) {
      return reply.code(400).send({ error: `A join needs a name of 1 to ${NAME_MAX} characters.` });
    }

    const now = Date.now();
    const room = await roomByCode(code, now, caller);
    if (!room) {
      return reply.code(404).send({ error: 'No room is open with that code.', code: 'not_found' });
    }

    if (body.team !== undefined && body.team !== 0 && body.team !== 1) {
      return reply.code(400).send({ error: 'A team is 0 or 1.' });
    }

    const seat = await joinSeat(room, caller, name, body.team === 1 ? 1 : 0, now);
    if (seat.kind === 'refused') {
      return reply
        .code(seat.refusal.status)
        .send({ error: seat.refusal.error, ...(seat.refusal.code ? { code: seat.refusal.code } : {}) });
    }

    return reply.send({
      roomId: seat.room.roomId,
      code: seat.room.code,
      slot: seat.player.slot,
      players: playersView(seat.room),
    });
  });

  // --- A household reads an invitation before taking a seat --------------
  // The six digits are the secret, so this one read has no membership rule:
  // the joining television has not joined yet. It answers the frozen deck,
  // answer keys included, because that television has to judge its own
  // presses with the same deck the host published.
  app.get('/v1/tv/challenge/:code', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Reading a challenge needs a caller identity.' });
    }

    const params = request.params as { code?: unknown };
    const code = typeof params.code === 'string' ? params.code.trim() : '';
    if (!new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(code)) {
      return reply
        .code(400)
        .send({ error: `A challenge is looked up by its ${CODE_LENGTH}-digit code.`, code: 'invalid_code' });
    }

    const now = Date.now();
    pruneRooms(now);
    // This process already holds the room: answer from it even when Postgres
    // is unreachable, which is the same room Phase A's join would find.
    for (const room of rooms.values()) {
      if (room.code === code) return reply.send(invitationOf(room));
    }

    const outcome = await deckByCode(code, caller);
    if (outcome.kind === 'unavailable') {
      return reply
        .code(503)
        .send({ error: 'Challenges cannot be read right now.', code: 'challenge_unavailable' });
    }
    if (outcome.kind === 'missing') {
      return reply.code(404).send({ error: 'No room is open with that code.', code: 'not_found' });
    }
    return reply.send(outcome.value);
  });

  // --- A player gives up a seat, or the host closes the room -------------
  app.post('/v1/tv/challenge/leave', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Leaving a challenge needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { roomId?: unknown; slot?: unknown };
    const roomId = readText(body.roomId, 64);
    if (!roomId) return reply.code(400).send({ error: 'Leaving a challenge needs a roomId.' });

    let slot: number | null = null;
    if (body.slot !== undefined && body.slot !== null) {
      const parsed = Number(body.slot);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > SLOTS_MAX) {
        return reply.code(400).send({ error: `A seat is numbered 1 to ${SLOTS_MAX}.` });
      }
      slot = parsed;
    }

    const now = Date.now();
    const room = await liveRoom(roomId, now, caller);
    if (!room) return reply.code(404).send({ error: 'No such room.', code: 'not_found' });

    // No seat means the whole room, which is the host's call: it releases the
    // six digits and every member with them.
    if (slot === null) {
      if (room.hostDeviceId !== caller.deviceId) {
        return reply.code(403).send({ error: 'Only the host can close the room.', code: 'not_host' });
      }
      closeRoom(room, 'host_left');
      await leave(room.roomId, null, caller);
      return reply.send({ roomId: room.roomId, closed: true });
    }

    const player = room.players.find(candidate => candidate.slot === slot);
    if (!player) {
      return reply.code(404).send({ error: 'That seat has not joined this room.', code: 'not_joined' });
    }
    if (room.hostDeviceId !== caller.deviceId && player.deviceId !== caller.deviceId) {
      return reply.code(403).send({ error: 'That seat belongs to another device.', code: 'not_yours' });
    }

    room.players = room.players.filter(candidate => candidate.slot !== slot);
    room.roundAnswers.delete(slot);
    touch(room, now);
    // The host's write removes the member too; anyone else may only remove the
    // seat they own, which challenge_leave enforces.
    if (room.hostDeviceId === caller.deviceId) await save(room, caller);
    else await leave(room.roomId, slot, caller);

    enqueueForTv(room.hostDeviceId, { type: 'challenge.lobby', room: lobbyOf(room) });
    return reply.send({ roomId: room.roomId, slot, players: playersView(room) });
  });

  // --- The host starts the party -----------------------------------------
  app.post('/v1/tv/challenge/start', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Starting a challenge needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { roomId?: unknown };
    const roomId = readText(body.roomId, 64);
    if (!roomId) return reply.code(400).send({ error: 'Starting a challenge needs a roomId.' });

    const now = Date.now();
    const room = await liveRoom(roomId, now, caller);
    if (!room) return reply.code(404).send({ error: 'No such room.', code: 'not_found' });
    if (room.hostDeviceId !== caller.deviceId) {
      return reply.code(403).send({ error: 'Only the host can start the room.', code: 'not_host' });
    }
    if (room.phase !== 'lobby') {
      return reply.code(409).send({ error: 'That room has already started.', code: 'not_lobby' });
    }
    if (room.players.length < PLAYERS_MIN) {
      return reply
        .code(409)
        .send({ error: `A challenge needs at least ${PLAYERS_MIN} players.`, code: 'not_enough_players' });
    }

    room.phase = 'playing';
    room.roundIndex = 0;
    room.roundAnswers.clear();
    room.roundStartedAt = now;
    touch(room, now);
    await save(room, caller);
    pushQuestion(room, now);

    return reply.send({
      roomId: room.roomId,
      phase: room.phase,
      index: room.roundIndex,
      total: room.deck.rounds.length,
      endsAt: now + ROUND_MS,
    });
  });

  // --- The only scoring path ----------------------------------------------
  app.post('/v1/tv/challenge/answer', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Reporting an answer needs a caller identity.' });
    }

    const body = (request.body ?? {}) as {
      roomId?: unknown;
      slot?: unknown;
      roundId?: unknown;
      choice?: unknown;
    };
    const roomId = readText(body.roomId, 64);
    const roundId = readText(body.roundId, 120);
    const choice = readText(body.choice, 120);
    const slot = Number(body.slot);
    if (!roomId || !roundId || !choice) {
      return reply.code(400).send({ error: 'An answer needs a roomId, a roundId and a choice.' });
    }
    if (!Number.isInteger(slot) || slot < 1 || slot > SLOTS_MAX) {
      return reply.code(400).send({ error: `An answer needs a slot from 1 to ${SLOTS_MAX}.` });
    }

    const now = Date.now();
    const room = await liveRoom(roomId, now, caller);
    if (!room) return reply.code(404).send({ error: 'No such room.', code: 'not_found' });
    if (room.phase === 'finished') {
      return reply.code(409).send({ error: 'That room has finished.', code: 'finished' });
    }
    if (room.phase !== 'playing') {
      return reply.code(409).send({ error: 'That room is not on a question.', code: 'not_playing' });
    }

    const round = room.deck.rounds[room.roundIndex];
    if (!round || round.roundId !== roundId) {
      return reply.code(409).send({ error: 'That question is no longer on screen.', code: 'stale_round' });
    }

    const player = room.players.find(candidate => candidate.slot === slot);
    if (!player) {
      return reply.code(404).send({ error: 'That slot has not joined this room.', code: 'not_joined' });
    }
    if (room.roundAnswers.has(slot)) {
      // A double press, or a press plus a retry: the first answer stands.
      return reply.code(409).send({ error: 'That slot has already answered.', code: 'already_answered' });
    }

    const verdict = evaluateAnswer(room.deck, room.roundIndex, roundId, choice);
    if (!verdict) {
      return reply.code(400).send({ error: 'That choice is not on the card.', code: 'invalid_choice' });
    }

    const elapsedMs = Math.max(0, now - room.roundStartedAt);
    const late = elapsedMs > ROUND_MS + ANSWER_GRACE_MS;
    if (late) player.lateAnswers = (player.lateAnswers ?? 0) + 1;

    if (verdict.correct) {
      player.streak += 1;
      player.correct += 1;
    } else {
      player.streak = 0;
    }
    const points = scoreForAnswer(verdict.correct, elapsedMs, player.streak);
    player.score += points;
    room.roundAnswers.set(slot, choice);
    player.answered[roundId] = choice;
    touch(room, now);

    const answered = room.roundAnswers.size;
    const total = room.players.length;
    const closed = answered >= total ? await closeRound(room, now) : null;
    // One write per answer, after the round may have closed and paid: the row
    // is what makes a finished room stay finished across a restart. A joining
    // household is not the host, so it writes its own member row instead.
    if (room.hostDeviceId === caller.deviceId) await save(room, caller);
    else await recordAnswer(room.roomId, player, caller);

    return reply.send({
      accepted: true,
      correct: verdict.correct,
      answerPrimary: verdict.answerPrimary,
      points,
      elapsedMs,
      late,
      answered,
      total,
      phase: room.phase,
      standings: closed?.rows ?? null,
      award: room.lastAward,
    });
  });

  // --- The host moves the room on ----------------------------------------
  app.post('/v1/tv/challenge/next', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Advancing a challenge needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { roomId?: unknown };
    const roomId = readText(body.roomId, 64);
    if (!roomId) return reply.code(400).send({ error: 'Advancing a challenge needs a roomId.' });

    const now = Date.now();
    const room = await liveRoom(roomId, now, caller);
    if (!room) return reply.code(404).send({ error: 'No such room.', code: 'not_found' });
    if (room.hostDeviceId !== caller.deviceId) {
      return reply.code(403).send({ error: 'Only the host can advance the room.', code: 'not_host' });
    }
    if (room.phase === 'lobby') {
      return reply.code(409).send({ error: 'That room has not started.', code: 'not_started' });
    }
    if (room.phase === 'finished') {
      return reply.code(409).send({ error: 'That room has finished.', code: 'finished' });
    }

    // From 'playing' this closes a round in progress: unanswered slots are
    // skipped rather than blocking the party. From 'standings' every slot has
    // already answered, so there is nothing left to close.
    const closed = room.phase === 'playing'
      ? await closeRound(room, now)
      : { rows: standingsOf(room), final: false };

    if (closed.final) {
      await save(room, caller);
      return reply.send({
        roomId: room.roomId,
        phase: room.phase,
        index: room.roundIndex,
        total: room.deck.rounds.length,
        standings: closed.rows,
        final: true,
        award: room.lastAward,
      });
    }

    room.roundIndex += 1;
    room.phase = 'playing';
    room.roundAnswers.clear();
    room.roundStartedAt = now;
    touch(room, now);
    await save(room, caller);
    pushQuestion(room, now);

    return reply.send({
      roomId: room.roomId,
      phase: room.phase,
      index: room.roundIndex,
      total: room.deck.rounds.length,
      standings: closed.rows,
      final: false,
      award: null,
    });
  });

  // --- Phones: the same room, a different board --------------------------
  //
  // Everything below is public in the sense that it needs no television: six
  // digits, a name, and the token the server hands back. The token is the only
  // credential that survives a reconnect, so it is minted here (joinSeat) and
  // demanded on every answer.

  app.post('/v1/challenge/join', async (request, reply) => {
    const now = Date.now();
    if (overLimit(`join:${request.ip}`, JOIN_PER_IP, now)) {
      return reply
        .code(429)
        .send({ error: 'Too many joins from this address.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Joining a challenge needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { code?: unknown; name?: unknown; team?: unknown };
    const code = readText(body.code, CODE_LENGTH);
    const name = readText(body.name, NAME_MAX);
    if (!code || !new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(code)) {
      return reply.code(400).send({ error: `A join needs a ${CODE_LENGTH}-digit code.` });
    }
    if (!name) {
      return reply.code(400).send({ error: `A join needs a name of 1 to ${NAME_MAX} characters.` });
    }
    if (body.team !== undefined && body.team !== 0 && body.team !== 1) {
      return reply.code(400).send({ error: 'A team is 0 or 1.' });
    }

    const room = await roomByCode(code, now, caller);
    if (!room) return reply.code(404).send({ error: 'No room is open with that code.', code: 'not_found' });

    const seat = await joinSeat(room, caller, name, body.team === 1 ? 1 : 0, now);
    if (seat.kind === 'refused') {
      return reply
        .code(seat.refusal.status)
        .send({ error: seat.refusal.error, ...(seat.refusal.code ? { code: seat.refusal.code } : {}) });
    }

    // The only response that carries a token: it is this seat's credential for
    // the rest of the party, and it is never composed into another seat's view.
    return reply.send({
      roomId: seat.room.roomId,
      code: seat.room.code,
      slot: seat.player.slot,
      name: seat.player.name,
      team: seat.player.team,
      playerToken: seat.player.token,
      players: playersView(seat.room),
    });
  });

  app.post('/v1/challenge/answer', async (request, reply) => {
    const now = Date.now();
    if (overLimit(`answer:${request.ip}`, ANSWER_PER_IP, now)) {
      return reply
        .code(429)
        .send({ error: 'Too many answers from this address.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Answering a challenge needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { playerToken?: unknown; roundId?: unknown; choice?: unknown };
    const token = readText(body.playerToken, 64);
    const roundId = readText(body.roundId, 120);
    const choice = readText(body.choice, 120);
    if (!token || !UUID.test(token) || !roundId || !choice) {
      return reply.code(400).send({ error: 'An answer needs a playerToken, a roundId and a choice.' });
    }

    const seat = await tokenRoom(token, now, caller);
    if (!seat) {
      return reply.code(404).send({ error: 'That player token is not in a live room.', code: 'not_joined' });
    }
    const { room, slot } = seat;

    // Per room as well as per address: six phones share one egress address, so
    // only a room-wide ceiling catches a loop that rotates its token.
    if (overLimit(`answer:${room.roomId}`, ANSWERS_PER_ROOM, now)) {
      return reply
        .code(429)
        .send({ error: 'That room is answering too quickly.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    if (room.phase === 'finished') {
      return reply.code(409).send({ error: 'That room has finished.', code: 'finished' });
    }
    if (room.phase !== 'playing') {
      // The window is the server's clock. An answer for a card that is not on
      // screen is refused rather than scored from zero elapsed: holding it
      // would hand the fastest thumb full speed points for a question it never
      // saw. The phone keeps its tile and sends again when the state says
      // `playing` - that is the hold.
      return reply
        .code(409)
        .send({ error: 'That room is not on a question.', code: 'not_playing', phase: room.phase });
    }

    const round = room.deck.rounds[room.roundIndex];
    if (!round || round.roundId !== roundId) {
      return reply.code(409).send({ error: 'That question is no longer on screen.', code: 'stale_round' });
    }

    const player = room.players.find(candidate => candidate.slot === slot);
    if (!player) {
      return reply.code(404).send({ error: 'Your seat has left this room.', code: 'not_joined' });
    }

    const verdict = evaluateAnswer(room.deck, room.roundIndex, roundId, choice);
    if (!verdict) {
      return reply.code(400).send({ error: 'That choice is not on the card.', code: 'invalid_choice' });
    }

    if (room.roundAnswers.has(slot)) {
      return reply.code(409).send({ error: 'You have already answered this round.', code: 'already_answered' });
    }

    // The durable claim goes first, so "one answer per slot per round" is the
    // primary key on (room_id, round_id, slot) rather than this check. A store
    // that cannot answer leaves the in-process map as the guard, which is the
    // Phase A behaviour and is enough while this process owns the room.
    const claim = await claimAnswer(token, roundId, choice, caller);
    if (claim === 'duplicate') {
      return reply.code(409).send({ error: 'You have already answered this round.', code: 'already_answered' });
    }

    const elapsedMs = Math.max(0, now - room.roundStartedAt);
    const late = elapsedMs > ROUND_MS + ANSWER_GRACE_MS;
    if (late) player.lateAnswers = (player.lateAnswers ?? 0) + 1;

    if (verdict.correct) {
      player.streak += 1;
      player.correct += 1;
    } else {
      player.streak = 0;
    }
    const points = scoreForAnswer(verdict.correct, elapsedMs, player.streak);
    player.score += points;
    room.roundAnswers.set(slot, choice);
    player.answered[roundId] = choice;
    touch(room, now);

    const answered = room.roundAnswers.size;
    const total = room.players.length;
    const closed = answered >= total ? await closeRound(room, now) : null;
    // A phone is not the host, so it writes only the member row it owns; the
    // television's next action writes the whole room.
    await recordAnswer(room.roomId, player, caller, token);
    // Except when this answer closed the room: the television never presses
    // NEXT on the last question, because the podium is already on screen, so
    // without this write the stored room stays 'playing' and a redeploy inside
    // its TTL would resurrect a finished party. The relay holds the host id it
    // minted, so it writes the final phase on the host's behalf;
    // api.challenge_save keeps every seat's token when the payload omits it.
    if (closed?.final) {
      await save(room, { deviceId: room.hostDeviceId });
    }

    return reply.send({
      accepted: true,
      correct: verdict.correct,
      // No answerPrimary: the window is still open for the other seats, and a
      // phone that learned the key would be the key.
      points,
      elapsedMs,
      late,
      answered,
      total,
      phase: room.phase,
      award: closed ? room.lastAward : null,
    });
  });

  /**
   * GET /v1/challenge/:code/stream - the board, watched from a phone.
   *
   * `EventSource` cannot set a header, so identity comes from the query string
   * the same way the notifications stream takes it. The code is the room
   * secret and the state carries no answer key, so a token is not required to
   * watch; it is required to answer.
   */
  app.get('/v1/challenge/:code/stream', async (request, reply) => {
    const now = Date.now();
    if (overLimit(`stream:${request.ip}`, JOIN_PER_IP, now)) {
      return reply
        .code(429)
        .send({ error: 'Too many streams from this address.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    const params = request.params as { code?: unknown };
    const code = typeof params.code === 'string' ? params.code.trim() : '';
    if (!new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(code)) {
      return reply
        .code(400)
        .send({ error: `A challenge is watched by its ${CODE_LENGTH}-digit code.`, code: 'invalid_code' });
    }

    const query = (request.query ?? {}) as { device_id?: unknown };
    const device = typeof query.device_id === 'string' ? query.device_id.trim() : '';
    const caller = resolveCaller(request.headers) ?? (UUID.test(device) ? { deviceId: device } : null);
    if (!caller) {
      return reply.code(401).send({ error: 'Watching a challenge needs a caller identity.' });
    }

    const room = await roomByCode(code, now, caller);
    if (!room) {
      // A stream has no body a browser will render, and EventSource stops on a
      // non-200, so a wrong code ends the page's retries instead of looping.
      return reply.code(404).send({ error: 'No room is open with that code.', code: 'not_found' });
    }

    const headers: Record<string, string | number | string[]> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };
    // The reply is handed to us, so the CORS headers @fastify/cors set on it
    // have to be copied across or the browser blocks a stream it preflighted.
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
    reply.raw.write('retry: 3000\n\n');
    reply.raw.write(': open\n\n');

    const raw = reply.raw;
    let closed = false;
    const stop = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      unsubscribe();
    };
    const unsubscribe = subscribe(room.roomId, event => {
      if (closed) return;
      writeFrame(raw, event.type, event);
    });

    // Prime immediately: a phone that just joined, woke up or reconnected gets
    // the round it is actually on, which is the plan 8 recovery for a stream.
    const prime: PhoneEvent = { type: 'challenge.state', state: phoneStateOf(room) };
    writeFrame(raw, prime.type, prime);

    const beat = setInterval(() => {
      if (closed || raw.writableEnded || raw.destroyed) return;
      raw.write(': ping\n\n');
    }, STREAM_BEAT_MS);

    request.raw.on('close', stop);
    raw.on('close', stop);
  });
}
