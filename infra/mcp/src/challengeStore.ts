// The durable copy of a challenge room.
//
// Phase A keeps rooms in a Map in challenge.ts for the same reason the solo
// game keeps its session in tvGame.ts: a party lasts an evening and a redeploy
// ends it. An invitation does not. A code read out at dinner has to mean the
// same room after the relay restarts, so the room is also written to
// api.challenge_rooms (infra/schema/257_challenge_rooms.sql), and this module
// is the only code that reads or writes it.
//
// Four functions, one per thing a route needs:
//
//   create  the host opens a lobby, and the digits may collide with a live room
//   byCode  a player takes a slot, from six digits rather than an id
//   load    every action after that, from the id the host already holds
//   save    the whole room, after any change
//
// Phase B adds three narrow ones, because a second household writes without
// being the host: deckByCode reads an invitation without membership,
// recordAnswer writes one member's row, and leave removes a seat.
//
// Phase C adds the phone's two: byToken reads a room as the seat that token
// names, and claimAnswer inserts the (room, round, slot) row that makes one
// answer per player per round a constraint rather than a check-then-write.
//
// Whole-state writes match the whole-state pushes the television already
// receives, so persistence adds a call rather than a second model. There is
// deliberately no per-field RPC: a room is small, and two writers patching
// different fields of a score would be a race for no gain.
//
// The store degrades rather than throws. A PostgrestError is the API being
// unreachable or the migration unapplied, which is a room that lives only in
// this process - exactly what Phase A was - and the party must still work.
// Reads report that case as `unavailable` rather than folding it into "no such
// room": a Phase B invitation that cannot reach Postgres is a 503, not a wrong
// code. Anything that is not a PostgrestError is a bug and is left for the
// route to answer, matching the wallet's rule in tvWallet.ts.

import type { Caller } from './identity.js';
import { PostgrestError, rpc } from './postgrest.js';
import type {
  ChallengeAward,
  ChallengeInvitation,
  ChallengePhase,
  ChallengePlayer,
  ChallengeRoom,
} from './challenge.js';
import type { GameDeck } from './tvGame.js';

/**
 * What Postgres did with a room.
 *
 * `code_taken` is the one refusal worth naming: the digits are unique across
 * live rooms, so a host that draws a code a surviving room already owns has to
 * draw again. `degraded` means only this process holds the room now.
 */
export type WriteOutcome = 'written' | 'code_taken' | 'degraded';

/** What a read found.
 *
 * `missing` is a wrong code or a dead room. `unavailable` is Postgres being
 * unreachable or 257 being unapplied; Phase B answers it as 503 instead of
 * telling the player their invitation never existed.
 */
export type ReadOutcome<T> =
  | { kind: 'found'; value: T }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/** What happened to a seat. `slot_taken` is a lost race, not a bug. */
export type SeatOutcome = 'seated' | 'slot_taken' | 'degraded';

/** A room plus the seat the presented token owns. */
export interface TokenRoom {
  room: ChallengeRoom;
  slot: number;
}

/** What the claim RPC said. */
export type ClaimOutcome = 'claimed' | 'duplicate' | 'degraded';

/** The row api.challenge_state composes, in the JSON shape it composes it in. */
interface StateRow {
  roomId: string;
  code: string;
  phase: ChallengePhase;
  deckId: string;
  deck: GameDeck;
  hostDeviceId: string;
  players: Array<{
    slot: number;
    name: string;
    team: number;
    score: number;
    streak: number;
    correct: number;
    lateAnswers?: number | null;
    deviceId: string | null;
    answered?: Record<string, string> | null;
  }>;
  roundIndex: number;
  /** Epoch ms, or 0 before the first question. */
  roundStartedAt: number;
  roundAnswers: Record<string, string> | null;
  /** Epoch ms. */
  expiresAt: number;
  awarded: boolean;
  lastAward: ChallengeAward | null;
}

/** The room as the SQL function reads it: the interface, minus `at`. */
function wire(room: ChallengeRoom): Record<string, unknown> {
  return {
    roomId: room.roomId,
    code: room.code,
    phase: room.phase,
    deckId: room.deckId,
    deck: room.deck,
    hostDeviceId: room.hostDeviceId,
    players: room.players.map(player => ({
      slot: player.slot,
      name: player.name,
      team: player.team,
      score: player.score,
      streak: player.streak,
      correct: player.correct,
      lateAnswers: player.lateAnswers ?? 0,
      deviceId: player.deviceId,
      answered: player.answered,
      // Omitted when null: api.challenge_save treats a missing token as "do
      // not touch the seat's credential", which is what lets the host
      // television write a room whose phone seats it never held tokens for.
      ...(player.token ? { playerToken: player.token } : {}),
    })),
    roundIndex: room.roundIndex,
    roundStartedAt: room.roundStartedAt,
    // A Map serialises as {} through JSON.stringify, so the slots are spelled
    // out: {"1":"a"} is what round_answers stores and what comes back.
    roundAnswers: Object.fromEntries(room.roundAnswers),
    expiresAt: room.expiresAt,
    awarded: room.awarded,
    lastAward: room.lastAward,
  };
}

function fromWire(row: StateRow): ChallengeRoom {
  const answers = row.roundAnswers ?? {};
  return {
    roomId: row.roomId,
    code: row.code,
    phase: row.phase,
    deckId: row.deckId,
    deck: row.deck,
    hostDeviceId: row.hostDeviceId,
    players: (row.players ?? []).map((player): ChallengePlayer => ({
      slot: Number(player.slot),
      name: player.name,
      team: Number(player.team) === 1 ? 1 : 0,
      score: Number(player.score) || 0,
      streak: Number(player.streak) || 0,
      correct: Number(player.correct) || 0,
      lateAnswers: Number(player.lateAnswers) || 0,
      deviceId: player.deviceId ?? null,
      answered: player.answered ?? {},
      // The compositor never returns a token, so a room read back from the
      // store knows only the token presented on this request. The route
      // re-attaches that one; every other seat keeps null and can answer once
      // it presents its own, because byToken re-reads the row.
      token: null,
    })),
    roundIndex: Number(row.roundIndex) || 0,
    roundStartedAt: Number(row.roundStartedAt) || 0,
    roundAnswers: new Map(
      Object.entries(answers).map(([slot, choice]) => [Number(slot), String(choice)]),
    ),
    expiresAt: Number(row.expiresAt) || 0,
    awarded: Boolean(row.awarded),
    lastAward: row.lastAward ?? null,
    // Only used for expiry bookkeeping in this process; the column that
    // matters is expires_at, which the row always carries.
    at: Date.now(),
  };
}

async function write(room: ChallengeRoom, caller: Caller): Promise<WriteOutcome> {
  try {
    await rpc<void>('challenge_save', { p_room: wire(room) }, caller);
    return 'written';
  } catch (error) {
    if (!(error instanceof PostgrestError)) throw error;
    // The code index is unique across live rooms. A room that has never been
    // stored can lose the draw; api.challenge_save raises 23505 for it.
    if (error.code === '23505') return 'code_taken';
    // The function refuses a write by anyone but the host. In Phase A the
    // television is always the host, so this is a bug or a forged header,
    // not a party that should carry on unpersisted.
    if (error.code === '42501') throw error;
    // Unreachable API, or 257 not applied: the in-process Map is the room.
    return 'degraded';
  }
}

/**
 * Stores a brand-new room, reporting a code that a live room already owns.
 *
 * The host draws the digits, so the collision is decided here rather than in
 * the route: only Postgres knows about rooms opened before the last redeploy.
 */
export function create(room: ChallengeRoom, caller: Caller): Promise<WriteOutcome> {
  return write(room, caller);
}

/**
 * Stores the whole room after a change.
 *
 * `code_taken` cannot arise for a room that is already stored: it owns the row
 * its id names and never changes its code. A degraded write leaves the party
 * running on this process's copy, which is the Phase A behaviour.
 */
export async function save(room: ChallengeRoom, caller: Caller): Promise<void> {
  await write(room, caller);
}

async function read<Row, Value>(
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
  hydrate: (row: Row) => Value,
): Promise<ReadOutcome<Value>> {
  try {
    const row = await rpc<Row | null>(name, args, caller);
    return row ? { kind: 'found', value: hydrate(row) } : { kind: 'missing' };
  } catch (error) {
    if (error instanceof PostgrestError) return { kind: 'unavailable' };
    throw error;
  }
}

/**
 * One room by id, or `missing` when it is gone, expired or not this caller's.
 *
 * api.challenge_state already answers nothing for a room the caller neither
 * hosts nor plays in, so a stranger and a dead room are the same 404.
 */
export function load(roomId: string, caller: Caller): Promise<ReadOutcome<ChallengeRoom>> {
  return read('challenge_load', { p_room_id: roomId }, caller, fromWire);
}

/** One room by its six digits, or `missing` under the same rules as load. */
export function byCode(code: string, caller: Caller): Promise<ReadOutcome<ChallengeRoom>> {
  return read('challenge_by_code', { p_code: code }, caller, fromWire);
}

/**
 * One room by code with no membership rule: what an invitation has to show.
 *
 * The relay has already authenticated the caller; the code is the secret, and
 * it is six digits that only the host shared. The host's device id is not part
 * of the answer because neither household needs the other's.
 */
export function deckByCode(code: string, caller: Caller): Promise<ReadOutcome<ChallengeInvitation>> {
  return read<ChallengeInvitation, ChallengeInvitation>(
    'challenge_deck_by_code',
    { p_code: code },
    caller,
    row => row,
  );
}

/**
 * Takes one seat for the caller's own device.
 *
 * A joiner is not the host, so the whole-room `save` would refuse; this writes
 * only the member row the caller now owns. Slots are allocated by the relay
 * from the room it just read, so a taken seat here is a lost race, not a case
 * the route has to explain.
 */
export async function joinMember(
  roomId: string,
  player: ChallengePlayer,
  caller: Caller,
): Promise<SeatOutcome> {
  try {
    await rpc<void>(
      'challenge_join',
      {
        p_room_id: roomId,
        p_slot: player.slot,
        p_name: player.name,
        p_team: player.team,
        p_token: player.token,
      },
      caller,
    );
    return 'seated';
  } catch (error) {
    if (!(error instanceof PostgrestError)) throw error;
    if (error.code === '42501') throw error;
    // The primary key on (room_id, slot) refused the write: another phone
    // claimed the same seat between the route's read and this call.
    if (error.code === '23505') return 'slot_taken';
    return 'degraded';
  }
}

/**
 * One room and the seat the presented token owns.
 *
 * The phone has no X-Device-Id identity of its own, so the token is the whole
 * credential. `token` is passed through to challenge_state as the second
 * membership proof and never appears in the answer.
 */
export function byToken(token: string, caller: Caller): Promise<ReadOutcome<TokenRoom>> {
  return read<{ slot: number } & StateRow, TokenRoom>(
    'challenge_by_token',
    { p_token: token },
    caller,
    row => ({ room: fromWire(row), slot: Number(row.slot) }),
  );
}

/**
 * Claims this token's one answer for a round.
 *
 * `duplicate` is not an error: the primary key on (room_id, round_id, slot)
 * is what makes one answer per player per round a fact rather than a race the
 * route has to win.
 */
export async function claimAnswer(
  token: string,
  roundId: string,
  choice: string,
  caller: Caller,
): Promise<ClaimOutcome> {
  try {
    const row = await rpc<{ claimed: boolean } | null>('challenge_claim', {
      p_token: token,
      p_round_id: roundId,
      p_choice: choice,
    }, caller);
    return row?.claimed ? 'claimed' : 'duplicate';
  } catch (error) {
    if (!(error instanceof PostgrestError)) throw error;
    return 'degraded';
  }
}

/**
 * Persists one member's answer.
 *
 * The whole-room `save` is host-only, and a Phase B household answers from its
 * own television; this writes exactly the row that device owns. A store that
 * cannot answer leaves the in-process room authoritative, as everywhere else.
 */
export async function recordAnswer(
  roomId: string,
  player: ChallengePlayer,
  caller: Caller,
  token?: string | null,
): Promise<void> {
  try {
    await rpc<void>(
      'challenge_record',
      {
        p_room_id: roomId,
        p_slot: player.slot,
        p_score: player.score,
        p_streak: player.streak,
        p_correct: player.correct,
        p_late_answers: player.lateAnswers ?? 0,
        p_answered: player.answered ?? {},
        // The phone's seat credential. It has no device identity of its own, so
        // the token is the whole proof that this row is its to write.
        ...(token ? { p_token: token } : {}),
      },
      caller,
    );
  } catch (error) {
    if (!(error instanceof PostgrestError)) throw error;
    if (error.code === '42501') throw error;
  }
}

/**
 * Removes one seat, or the whole room when `slot` is null.
 *
 * A member may always leave; closing a room is the host's call and the SQL
 * refuses anyone else's.
 */
export async function leave(roomId: string, slot: number | null, caller: Caller): Promise<void> {
  try {
    await rpc<void>('challenge_leave', { p_room_id: roomId, p_slot: slot }, caller);
  } catch (error) {
    if (!(error instanceof PostgrestError)) throw error;
    if (error.code === '42501') throw error;
  }
}
