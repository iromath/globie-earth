// Tests for challenge rooms: the score, the clock and the payout.
//
// The room is the one place where the server, not the app, owns a quiz score -
// four people share one remote, so "who answered, and how quickly" is only
// observable here. These tests therefore drive the real routes: the scoring
// table is asserted directly, but the double-press rule, the automatic
// standings and the single award are contracts of the HTTP responses.
//
// Every upstream is answered by the fetch stub below (PostgREST only), so
// nothing here needs a network. The file lives under src/ because that is all
// tsconfig compiles; package.json builds first, then runs dist.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { registerChallengeRoutes, scoreForAnswer } from './challenge.js';
import type { ChallengeRoom } from './challenge.js';
import { registerChallengePresenceRoutes } from './challengePresence.js';
import { byCode as storeByCode, create as storeCreate, load as storeLoad } from './challengeStore.js';
import type { ReadOutcome } from './challengeStore.js';
import { registerTvCommandsRoute } from './tvCommands.js';
import { parseGameRound, registerTvGameRoutes } from './tvGame.js';
import type { GameDeckRound } from './tvGame.js';

process.env.POSTGREST_URL = 'https://postgrest.test';

/** Distinct hosts per test: a room refuses a second live room per television. */
const HOST_ONE = '11111111-1111-4111-8111-111111111111';
const HOST_TWO = '22222222-2222-4222-8222-222222222222';
const HOST_THREE = '33333333-3333-4333-8333-333333333333';
const HOST_FOUR = '44444444-4444-4444-8444-444444444444';
const HOST_FIVE = '55555555-5555-4555-8555-555555555555';
const HOST_SIX = '66666666-6666-4666-8666-666666666666';
const HOST_SEVEN = '77777777-7777-4777-8777-777777777777';
const HOST_EIGHT = '88888888-8888-4888-8888-888888888888';
const HOST_NINE = '99999999-9999-4999-8999-999999999999';
const HOST_TEN = '10101010-1010-4010-8010-101010101010';
const HOST_ELEVEN = '11111112-1111-4111-8111-111111111112';
const HOST_TWELVE = '12121212-1212-4212-8212-121212121212';
const HOST_THIRTEEN = '13131313-1313-4313-8313-131313131313';
const HOST_FOURTEEN = '14141414-1414-4414-8414-141414141414';
const HOST_FIFTEEN = '15151515-1515-4515-8515-151515151515';
const HOST_SIXTEEN = '16161616-1616-4616-8616-161616161616';
const HOST_SEVENTEEN = '17171717-1717-4717-8717-171717171717';
const HOST_EIGHTEEN = '18181818-1818-4818-8818-181818181818';
const HOST_NINETEEN = '19191919-1919-4919-8919-191919191919';
const HOST_TWENTY = '20202020-2020-4020-8020-202020202020';
/** A second television: the household that joins by typing the code. */
const GUEST_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUEST_TWO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** Phones: a browser with its own device id and no seat of its own. */
const GUEST_THREE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GUEST_FOUR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GUEST_FIVE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const GUEST_SIX = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
/** A phone that closes the final round, which is the only writer left. */
const GUEST_SEVEN = 'abcdef01-1234-4567-89ab-abcdef012345';
/** Phase D households: each opens one party with one camera. */
const HOST_TWENTY_ONE = '21212121-2121-4121-8121-212121212121';
const HOST_TWENTY_TWO = '23232323-2323-4323-8323-232323232323';
/** Phase D phones. */
const GUEST_EIGHT = '12121213-1212-4212-8212-121212121213';
const GUEST_NINE = '14141415-1414-4414-8414-141414141415';

interface AwardCall {
  key: string;
  amount: number;
}

const awardCalls: AwardCall[] = [];

/**
 * What api.challenge_save would have written.
 *
 * The stub keeps the row as JSON, not as a room object, so a load has to come
 * back through the same encoding the database returns. That is what catches a
 * Map serialising as {}.
 */
const storedRows = new Map<string, Record<string, unknown>>();

/** Answers the challenge functions as an unapplied 257 does: 404. */
let challengeStoreDown = false;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function postgrestError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The member rows api.challenge_members would hold for one stored room. */
interface StoredMember {
  slot: number;
  name: string;
  team: number;
  score?: number;
  streak?: number;
  correct?: number;
  lateAnswers?: number;
  deviceId?: string | null;
  answered?: Record<string, string>;
  /** The Phase C credential; the compositor never returns it. */
  playerToken?: string;
}

/** (room, round, slot) -> claimed, which is the answer table's primary key. */
const claimedAnswers = new Set<string>();

function members(row: Record<string, unknown>): StoredMember[] {
  return (row.players as StoredMember[] | undefined) ?? [];
}

/** Unwraps a store read, so a test that expects a room fails loudly on 404. */
function found<T>(outcome: ReadOutcome<T>): T {
  assert.equal(outcome.kind, 'found');
  return (outcome as { kind: 'found'; value: T }).value;
}

const realFetch = globalThis.fetch;

/**
 * PostgREST is the only upstream a room reaches: the eco award, and the four
 * challenge functions from 257.
 */
function stubFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

  if (url.hostname === 'postgrest.test' && url.pathname === '/rpc/eco_award') {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      p_key?: string;
      p_amount?: number;
    };
    awardCalls.push({ key: String(body.p_key), amount: Number(body.p_amount) });
    return Promise.resolve(json([{ balance: 1000 + Number(body.p_amount), awarded: body.p_amount }]));
  }

  if (url.hostname === 'postgrest.test' && url.pathname.startsWith('/rpc/challenge_')) {
    if (challengeStoreDown) {
      return Promise.resolve(
        postgrestError(404, 'PGRST202', 'Could not find the public.challenge_save function.'),
      );
    }

    if (url.pathname === '/rpc/challenge_save') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_room?: Record<string, unknown> };
      const room = body.p_room ?? {};
      const roomId = String(room.roomId);
      // api.challenge_save refuses every caller except the payload's host.
      if (new Headers(init?.headers).get('X-Device-Id') !== room.hostDeviceId) {
        return Promise.resolve(postgrestError(403, '42501', 'only the host may save this room'));
      }
      // The unique index on code, across every room that is still stored.
      for (const [otherId, other] of storedRows) {
        if (otherId !== roomId && other.code === room.code) {
          return Promise.resolve(postgrestError(409, '23505', 'duplicate key value violates unique constraint'));
        }
      }
      storedRows.set(roomId, room);
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/rpc/challenge_load') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_room_id?: string };
      return Promise.resolve(json(storedRows.get(String(body.p_room_id)) ?? null));
    }

    if (url.pathname === '/rpc/challenge_by_code') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_code?: string };
      for (const room of storedRows.values()) {
        // The SQL function only resolves live rooms.
        if (room.code === body.p_code && Number(room.expiresAt) > Date.now()) {
          return Promise.resolve(json(room));
        }
      }
      return Promise.resolve(json(null));
    }

    if (url.pathname === '/rpc/challenge_deck_by_code') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_code?: string };
      for (const room of storedRows.values()) {
        if (room.code !== body.p_code) continue;
        // Expiry is the SQL function's filter, not the route's.
        if (Number(room.expiresAt) <= Date.now()) continue;
        // The SQL function deliberately omits hostDeviceId, so the stub does too.
        return Promise.resolve(
          json({
            roomId: room.roomId,
            code: room.code,
            deckId: room.deckId,
            deck: room.deck,
            phase: room.phase,
            players: members(room).map(player => ({
              slot: player.slot,
              name: player.name,
              team: player.team,
              score: player.score ?? 0,
              correct: player.correct ?? 0,
              streak: player.streak ?? 0,
              lateAnswers: player.lateAnswers ?? 0,
            })),
            expiresAt: room.expiresAt,
          }),
        );
      }
      return Promise.resolve(json(null));
    }

    if (url.pathname === '/rpc/challenge_join') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        p_room_id: string;
        p_slot: number;
        p_name: string;
        p_team?: number;
        p_token?: string | null;
      };
      const room = storedRows.get(String(body.p_room_id));
      if (!room) return Promise.resolve(postgrestError(404, 'P0002', 'room is not open'));
      members(room).push({
        slot: body.p_slot,
        name: body.p_name,
        team: body.p_team ?? 0,
        score: 0,
        streak: 0,
        correct: 0,
        // postgrest.ts forwards the caller's X-Device-Id, which is the owner.
        deviceId: new Headers(init?.headers).get('X-Device-Id'),
        answered: {},
        // Phase C: the join token rotates onto the member row.
        ...(body.p_token ? { playerToken: String(body.p_token) } : {}),
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/rpc/challenge_by_token') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_token?: string };
      for (const room of storedRows.values()) {
        if (Number(room.expiresAt) <= Date.now()) continue;
        const player = members(room).find(row => row.playerToken === body.p_token);
        if (!player) continue;
        return Promise.resolve(json({ ...room, slot: player.slot }));
      }
      return Promise.resolve(json(null));
    }

    if (url.pathname === '/rpc/challenge_claim') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        p_token?: string;
        p_round_id?: string;
      };
      for (const [roomId, room] of storedRows) {
        const player = members(room).find(row => row.playerToken === body.p_token);
        if (!player) continue;
        // The answer table's primary key: (room_id, round_id, slot).
        const key = `${roomId}:${String(body.p_round_id)}:${player.slot}`;
        if (claimedAnswers.has(key)) {
          return Promise.resolve(json({ claimed: false, reason: 'already_answered' }));
        }
        claimedAnswers.add(key);
        return Promise.resolve(
          json({ claimed: true, roomId, slot: player.slot, choice: (body as { p_choice?: string }).p_choice }),
        );
      }
      return Promise.resolve(json({ claimed: false, reason: 'no_token' }));
    }

    if (url.pathname === '/rpc/challenge_record') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        p_room_id?: string;
        p_slot?: number;
        p_score?: number;
        p_streak?: number;
        p_correct?: number;
        p_late_answers?: number | null;
        p_answered?: Record<string, string>;
      };
      const room = storedRows.get(String(body.p_room_id));
      const player = room && members(room).find(row => Number(row.slot) === Number(body.p_slot));
      if (!player) return Promise.resolve(postgrestError(403, '42501', 'slot is not this device’s'));
      player.score = body.p_score;
      player.streak = body.p_streak;
      player.correct = body.p_correct;
      // Null keeps the stored count, as the SQL function's coalesce does.
      player.lateAnswers = body.p_late_answers ?? player.lateAnswers ?? 0;
      player.answered = body.p_answered ?? {};
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/rpc/challenge_leave') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_room_id?: string; p_slot?: number };
      const roomId = String(body.p_room_id);
      const room = storedRows.get(roomId);
      if (!room) return Promise.resolve(new Response(null, { status: 204 }));
      if (body.p_slot === null || body.p_slot === undefined) {
        storedRows.delete(roomId);
      } else {
        room.players = members(room).filter(row => Number(row.slot) !== Number(body.p_slot));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
  }

  return Promise.resolve(new Response(null, { status: 201 }));
}

let app: FastifyInstance;

before(async () => {
  globalThis.fetch = stubFetch as typeof fetch;
  app = Fastify();
  registerTvGameRoutes(app);
  registerChallengeRoutes(app);
  // Phase D: the camera toggle, the frame relay and the advisory CV event.
  registerChallengePresenceRoutes(app);
  // The queue the television polls is how this file sees what a room pushed.
  registerTvCommandsRoute(app);
  await app.ready();
});

after(async () => {
  await app.close();
  globalThis.fetch = realFetch;
});

function headers(deviceId: string): Record<string, string> {
  return { 'x-device-id': deviceId };
}

/** One round in the shape the screen already publishes. */
function round(roundId: string, answerKey = 'a'): GameDeckRound {
  return {
    roundId,
    answerKey,
    options: [
      { key: 'a', primary: 'Dipterocarpus', secondary: 'ยางนา' },
      { key: 'b', primary: 'Ficus', secondary: 'ไทร' },
      { key: 'c', primary: 'Bamboo', secondary: 'ไผ่' },
    ],
    clues: ['A tall forest tree.'],
    hasPhoto: false,
  };
}

/** A room as a restarted relay finds it: a row, with no entry in this process. */
function storedRoom(host: string, code: string, rounds: GameDeckRound[]): ChallengeRoom {
  const now = Date.now();
  return {
    roomId: randomUUID(),
    code,
    phase: 'lobby',
    deckId: 'deck-stored',
    deck: { deckId: 'deck-stored', rounds },
    hostDeviceId: host,
    players: [],
    roundIndex: 0,
    roundStartedAt: 0,
    roundAnswers: new Map(),
    expiresAt: now + 30 * 60_000,
    awarded: false,
    lastAward: null,
    at: now,
  };
}

async function openRoom(host: string, rounds: unknown[]): Promise<{ roomId: string; code: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge',
    headers: headers(host),
    payload: { rounds },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { roomId: string; code: string };
}

async function join(host: string, code: string, name: string): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/join',
    headers: headers(host),
    payload: { code, name },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { slot: number }).slot;
}

async function start(host: string, roomId: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/start',
    headers: headers(host),
    payload: { roomId },
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function answer(
  host: string,
  roomId: string,
  slot: number,
  roundId: string,
  choice: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/answer',
    headers: headers(host),
    payload: { roomId, slot, roundId, choice },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** The phone's join: a code, a name, and a token back. */
async function phoneJoin(
  deviceId: string,
  code: string,
  name: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/challenge/join',
    headers: headers(deviceId),
    payload: { code, name },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** The phone's answer: the token is the whole credential. */
async function phoneAnswer(
  deviceId: string,
  playerToken: string,
  roundId: string,
  choice: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/challenge/answer',
    headers: headers(deviceId),
    payload: { playerToken, roundId, choice },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** The phone's camera toggle: on is a permission, off is a deletion. */
async function postPresence(
  deviceId: string,
  playerToken: string,
  on: boolean,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/challenge/presence',
    headers: headers(deviceId),
    payload: { playerToken, on },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** One base64 JPEG, as the phone captured it. */
async function postFrame(
  deviceId: string,
  playerToken: string,
  frame: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/challenge/presence/frame',
    headers: headers(deviceId),
    payload: { playerToken, frame },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** What the phone's own computer vision believed it saw. */
async function postEvent(
  deviceId: string,
  playerToken: string,
  type: string,
  score: number,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/challenge/presence/event',
    headers: headers(deviceId),
    payload: { playerToken, type, score },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** The frame as the television's <Image> reads it: no header, just the code. */
function frameGet(code: string, slot: number, version?: number) {
  return app.inject({
    method: 'GET',
    url: `/v1/challenge/${code}/presence/${slot}.jpg${version === undefined ? '' : `?v=${version}`}`,
  });
}

test('the scoring table pays accuracy, speed and a streak from the third answer', () => {
  // A correct answer at the bell: base plus the full speed bonus.
  assert.equal(scoreForAnswer(true, 0, 1), 160);
  assert.equal(scoreForAnswer(true, 7_500, 1), 130);
  assert.equal(scoreForAnswer(true, 15_000, 1), 100);

  // Past the grace window accuracy still counts, speed does not.
  assert.equal(scoreForAnswer(true, 17_001, 1), 100);

  // A wrong answer is worth nothing whatever the clock says.
  assert.equal(scoreForAnswer(false, 0, 1), 0);
  assert.equal(scoreForAnswer(false, 20_000, 4), 0);

  // The third consecutive correct answer is the first with a streak bonus,
  // and the bonus stops growing after three more.
  assert.equal(scoreForAnswer(true, 0, 2), 160);
  assert.equal(scoreForAnswer(true, 0, 3), 180);
  assert.equal(scoreForAnswer(true, 0, 5), 220);
  assert.equal(scoreForAnswer(true, 0, 9), 220);
});

test('a repeated press scores once and the round closes itself', async () => {
  const room = await openRoom(HOST_ONE, [round('r1'), round('r2')]);
  const first = await join(HOST_ONE, room.code, 'Ada');
  const second = await join(HOST_ONE, room.code, 'Bo');
  await start(HOST_ONE, room.roomId);

  const correct = await answer(HOST_ONE, room.roomId, first, 'r1', 'a');
  assert.equal(correct.statusCode, 200, JSON.stringify(correct.body));
  assert.equal(correct.body.correct, true);
  const points = Number(correct.body.points);
  assert.ok(points >= 100 && points <= 160, `unexpected points ${points}`);
  assert.equal(correct.body.phase, 'playing');

  // The first answer stands: a retry (or a double press) is refused, and the
  // score does not move.
  const again = await answer(HOST_ONE, room.roomId, first, 'r1', 'a');
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.code, 'already_answered');

  // The last slot closes the round without waiting for NEXT.
  const closes = await answer(HOST_ONE, room.roomId, second, 'r1', 'b');
  assert.equal(closes.statusCode, 200, JSON.stringify(closes.body));
  assert.equal(closes.body.phase, 'standings');
  const standings = closes.body.standings as Array<{ slot: number; score: number }>;
  assert.equal(standings.length, 2);
  assert.equal(standings[0].slot, first);
  assert.equal(standings[0].score, points);
});

test('finishing pays the host once and releases the frozen deck', async () => {
  const room = await openRoom(HOST_TWO, [round('only')]);

  // While the room is live the television may not republish its deck.
  const locked = await app.inject({
    method: 'POST',
    url: '/v1/tv/game/deck',
    headers: headers(HOST_TWO),
    payload: { deckId: 'deck-live', rounds: [round('only')] },
  });
  assert.equal(locked.statusCode, 409);
  assert.equal(locked.json().code, 'deck_locked');

  const first = await join(HOST_TWO, room.code, 'Cy');
  const second = await join(HOST_TWO, room.code, 'Di');
  await start(HOST_TWO, room.roomId);

  await answer(HOST_TWO, room.roomId, first, 'only', 'a');
  const last = await answer(HOST_TWO, room.roomId, second, 'only', 'a');
  assert.equal(last.statusCode, 200, JSON.stringify(last.body));
  assert.equal(last.body.phase, 'finished');

  const rows = last.body.standings as Array<{ score: number }>;
  const tokens = Math.floor(rows.reduce((sum, row) => sum + row.score, 0) / 20);
  assert.ok(tokens > 0, 'a two-player round should be worth at least one token');

  const award = last.body.award as { tokens: number; awarded: number; balance: number | null; available: boolean };
  assert.equal(award.tokens, tokens);
  assert.equal(award.awarded, tokens);
  assert.equal(award.available, true);
  assert.equal(awardCalls.length, 1);
  // Both seats share this television, so the payout is one credit for the room,
  // keyed by the device that earned it.
  assert.deepEqual(awardCalls[0], { key: `challenge:${room.roomId}:${HOST_TWO}`, amount: tokens });

  // NEXT after the podium is refused, so there is no second payout path.
  const next = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/next',
    headers: headers(HOST_TWO),
    payload: { roomId: room.roomId },
  });
  assert.equal(next.statusCode, 409);
  assert.equal(next.json().code, 'finished');
  assert.equal(awardCalls.length, 1);

  // The room no longer freezes the deck: the screen may publish again.
  const released = await app.inject({
    method: 'POST',
    url: '/v1/tv/game/deck',
    headers: headers(HOST_TWO),
    payload: { deckId: 'deck-after', rounds: [round('after')] },
  });
  assert.equal(released.statusCode, 200, released.body);
});

test('every change is written through the store and a load returns a Map again', async () => {
  const room = await openRoom(HOST_THREE, [round('r1'), round('r2')]);

  const opened = storedRows.get(room.roomId);
  assert.ok(opened, 'opening a room must leave a row');
  assert.equal(opened.phase, 'lobby');
  assert.equal(opened.hostDeviceId, HOST_THREE);
  // A Map serialises as {} through JSON.stringify: the row must spell the slots out.
  assert.deepEqual(opened.roundAnswers, {});

  await join(HOST_THREE, room.code, 'Ada');

  const joined = storedRows.get(room.roomId);
  assert.ok(joined);
  assert.equal((joined.players as unknown[]).length, 1);

  // What a restart would read: the row, decoded back into the shape routes mutate.
  const loaded = found(await storeLoad(room.roomId, { deviceId: HOST_THREE }));
  assert.equal(loaded.roomId, room.roomId);
  assert.equal(loaded.phase, 'lobby');
  assert.ok(loaded.roundAnswers instanceof Map);
  assert.deepEqual(loaded.players.map(player => player.name), ['Ada']);
  assert.equal(loaded.deck.rounds.length, 2);

  const byCode = found(await storeByCode(room.code, { deviceId: HOST_THREE }));
  assert.equal(byCode.roomId, room.roomId);
});

test('a code a stored room still owns is reported as taken', async () => {
  const room = await openRoom(HOST_FOUR, [round('r1')]);

  const rival = { ...storedRoom(HOST_FOUR, room.code, [round('other')]), roomId: randomUUID() };
  assert.equal(await storeCreate(rival, { deviceId: HOST_FOUR }), 'code_taken');
});

test('a room read back after a restart freezes its deck again', async () => {
  // The row exists, but this process has never seen the room: exactly the
  // state of the relay one second after a redeploy.
  const room = storedRoom(HOST_FIVE, '246810', [round('r1'), round('r2')]);
  assert.equal(await storeCreate(room, { deviceId: HOST_FIVE }), 'written');

  // Nothing is frozen yet, so the television may publish its solo deck.
  const beforeJoin = await app.inject({
    method: 'POST',
    url: '/v1/tv/game/deck',
    headers: headers(HOST_FIVE),
    payload: { deckId: 'deck-before', rounds: [round('before')] },
  });
  assert.equal(beforeJoin.statusCode, 200, beforeJoin.body);

  const slot = await join(HOST_FIVE, '246810', 'Eve');
  assert.equal(slot, 1);

  // Joining went through challenge_by_code, promoted the room and re-took the
  // lock - the per-process guard the lobby took last time does not survive.
  const locked = await app.inject({
    method: 'POST',
    url: '/v1/tv/game/deck',
    headers: headers(HOST_FIVE),
    payload: { deckId: 'deck-during', rounds: [round('during')] },
  });
  assert.equal(locked.statusCode, 409);
  const lock = locked.json() as { code: string; roomId: string };
  assert.equal(lock.code, 'deck_locked');
  assert.equal(lock.roomId, room.roomId);

  // The join was written back, so the same row still describes the room.
  const reloaded = found(await storeLoad(room.roomId, { deviceId: HOST_FIVE }));
  assert.deepEqual(reloaded.players.map(player => player.name), ['Eve']);
});

test('the party still runs when the challenge functions are not applied', async () => {
  challengeStoreDown = true;
  const awardsBefore = awardCalls.length;

  try {
    const room = await openRoom(HOST_SIX, [round('only')]);
    const first = await join(HOST_SIX, room.code, 'Fay');
    const second = await join(HOST_SIX, room.code, 'Gus');
    await start(HOST_SIX, room.roomId);

    await answer(HOST_SIX, room.roomId, first, 'only', 'a');
    const last = await answer(HOST_SIX, room.roomId, second, 'only', 'a');
    assert.equal(last.statusCode, 200, JSON.stringify(last.body));
    assert.equal(last.body.phase, 'finished');

    assert.equal(awardCalls.length, awardsBefore + 1);
    assert.equal(awardCalls[awardsBefore].key, `challenge:${room.roomId}:${HOST_SIX}`);
  } finally {
    challengeStoreDown = false;
  }
});

// ------------------------------------------------------------ Phase B: codes ----

test('an invitation travels by code, deck included, without the host identity', async () => {
  // A room this process has never seen: exactly what a second household's
  // television finds when it types the digits days later.
  const room = storedRoom(HOST_EIGHT, '424242', [round('r1'), round('r2', 'b')]);
  assert.equal(await storeCreate(room, { deviceId: HOST_EIGHT }), 'written');

  const response = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${room.code}`,
    headers: headers(GUEST_ONE),
  });
  assert.equal(response.statusCode, 200, response.body);

  const invitation = response.json() as Record<string, unknown>;
  assert.equal(invitation.roomId, room.roomId);
  assert.equal(invitation.phase, 'lobby');
  // Both households must render the identical deck: the invitation carries it,
  // answer keys and all, so the joining television judges its own presses.
  assert.deepEqual(invitation.deck, room.deck);
  assert.deepEqual(invitation.players, []);
  // Each household is paid on its own device, so the host's identity is not
  // part of what an invitation hands out.
  assert.equal('hostDeviceId' in invitation, false);
});

test('a code nobody holds is a 404, a malformed one is a 400', async () => {
  const missing = await app.inject({
    method: 'GET',
    url: '/v1/tv/challenge/999999',
    headers: headers(GUEST_ONE),
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'not_found');

  const malformed = await app.inject({
    method: 'GET',
    url: '/v1/tv/challenge/abc',
    headers: headers(GUEST_ONE),
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, 'invalid_code');
});

test('an expired code is gone even though its row still exists', async () => {
  const dead = storedRoom(HOST_NINE, '515151', [round('r1')]);
  dead.expiresAt = Date.now() - 1_000;
  assert.equal(await storeCreate(dead, { deviceId: HOST_NINE }), 'written');

  const response = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${dead.code}`,
    headers: headers(GUEST_ONE),
  });
  // challenge_deck_by_code filters on expires_at, so the route never sees it.
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, 'not_found');
});

test('a code read before 257 is applied says the store is unavailable', async () => {
  challengeStoreDown = true;

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tv/challenge/616161',
      headers: headers(GUEST_ONE),
    });
    // Plan §8: an unapplied migration is a 503 with a code the screen can
    // explain, not a 404 that would claim the code was wrong.
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'challenge_unavailable');
  } finally {
    challengeStoreDown = false;
  }
});

test('a ninth seat is refused with room_full', async () => {
  const room = await openRoom(HOST_TEN, [round('only')]);
  const seats: number[] = [];

  for (let seat = 1; seat <= 8; seat += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tv/challenge/join',
      headers: headers(randomUUID()),
      payload: { code: room.code, name: `P${seat}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    seats.push((response.json() as { slot: number }).slot);
  }
  assert.deepEqual(seats, [1, 2, 3, 4, 5, 6, 7, 8]);

  const ninth = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/join',
    headers: headers(randomUUID()),
    payload: { code: room.code, name: 'Extra' },
  });
  assert.equal(ninth.statusCode, 409);
  assert.equal(ninth.json().code, 'room_full');
});

test('a guest gives up its own seat and only the host may close the room', async () => {
  const room = await openRoom(HOST_ELEVEN, [round('only')]);
  const hostSlot = await join(HOST_ELEVEN, room.code, 'Host');
  const guestSlot = await join(GUEST_TWO, room.code, 'Guest');

  // Closing is the host's call: it releases the digits for everyone.
  const refused = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/leave',
    headers: headers(GUEST_TWO),
    payload: { roomId: room.roomId },
  });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, 'not_host');

  // Nor may it give up a seat it does not own.
  const wrongSeat = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/leave',
    headers: headers(GUEST_TWO),
    payload: { roomId: room.roomId, slot: hostSlot },
  });
  assert.equal(wrongSeat.statusCode, 403);
  assert.equal(wrongSeat.json().code, 'not_yours');

  const left = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/leave',
    headers: headers(GUEST_TWO),
    payload: { roomId: room.roomId, slot: guestSlot },
  });
  assert.equal(left.statusCode, 200, left.body);
  const remaining = left.json().players as Array<{ slot: number }>;
  assert.deepEqual(remaining.map(player => player.slot), [hostSlot]);

  // The seat is gone from the row too, so a relay restart agrees.
  const stored = storedRows.get(room.roomId);
  assert.ok(stored);
  assert.deepEqual(members(stored).map(player => player.slot), [hostSlot]);

  const closed = await app.inject({
    method: 'POST',
    url: '/v1/tv/challenge/leave',
    headers: headers(HOST_ELEVEN),
    payload: { roomId: room.roomId },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.deepEqual(closed.json(), { roomId: room.roomId, closed: true });
  assert.equal(storedRows.has(room.roomId), false);

  const gone = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${room.code}`,
    headers: headers(GUEST_TWO),
  });
  assert.equal(gone.statusCode, 404);
});

test('two households are each paid on their own device, once', async () => {
  const awardsBefore = awardCalls.length;
  const room = await openRoom(HOST_TWELVE, [round('only')]);

  // The guest reads the invitation before taking a seat - the one read with no
  // membership rule - then joins from its own television.
  const invitation = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${room.code}`,
    headers: headers(GUEST_ONE),
  });
  assert.equal(invitation.statusCode, 200, invitation.body);
  assert.equal((invitation.json() as { roomId: string }).roomId, room.roomId);

  const hostSlot = await join(HOST_TWELVE, room.code, 'Host');
  const guestSlot = await join(GUEST_ONE, room.code, 'Guest');
  await start(HOST_TWELVE, room.roomId);

  await answer(HOST_TWELVE, room.roomId, hostSlot, 'only', 'a');
  const last = await answer(GUEST_ONE, room.roomId, guestSlot, 'only', 'a');
  assert.equal(last.statusCode, 200, JSON.stringify(last.body));
  assert.equal(last.body.phase, 'finished');

  const rows = last.body.standings as Array<{ slot: number; score: number }>;
  const scoreOf = (slot: number): number => rows.find(row => row.slot === slot)?.score ?? 0;
  const hostTokens = Math.floor(scoreOf(hostSlot) / 20);
  const guestTokens = Math.floor(scoreOf(guestSlot) / 20);
  assert.ok(hostTokens >= 1 && guestTokens >= 1, JSON.stringify(rows));

  const pays = awardCalls.slice(awardsBefore);
  assert.equal(pays.length, 2);
  assert.deepEqual(
    pays.map(pay => [pay.key, pay.amount]).sort(),
    [
      [`challenge:${room.roomId}:${GUEST_ONE}`, guestTokens],
      [`challenge:${room.roomId}:${HOST_TWELVE}`, hostTokens],
    ].sort(),
  );

  const award = last.body.award as {
    tokens: number;
    awarded: number;
    balance: number | null;
    available: boolean;
  };
  assert.equal(award.tokens, hostTokens + guestTokens);
  assert.equal(award.awarded, hostTokens + guestTokens);
  // A balance only means something for one device, so a two-household room
  // reports none rather than a sum that belongs to nobody.
  assert.equal(award.balance, null);
  assert.equal(award.available, true);

  // The room is finished: a replay of the same round pays neither household.
  const again = await answer(GUEST_ONE, room.roomId, guestSlot, 'only', 'a');
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.code, 'finished');
  assert.equal(awardCalls.length, awardsBefore + 2);
});

test('the join link redirects to the board and its QR is a PNG of that link', async () => {
  const link = await app.inject({ method: 'GET', url: '/play/175822' });
  assert.equal(link.statusCode, 302);
  assert.equal(link.headers.location, 'https://mcp-client.globie.earth/play/175822');

  // Five digits is not a room, and sending a phone to a 404 board would hide
  // the mistake behind a redirect.
  const malformed = await app.inject({ method: 'GET', url: '/play/17582' });
  assert.equal(malformed.statusCode, 404);

  const qr = await app.inject({ method: 'GET', url: '/v1/challenge/175822/qr.png' });
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.headers['content-type'], 'image/png');
  assert.equal(qr.rawPayload.subarray(1, 4).toString('ascii'), 'PNG');
});

// --------------------------------------------------------- Phase C: phones ----

test('a phone joins by code and keeps the only copy of its token', async () => {
  const room = await openRoom(HOST_THIRTEEN, [round('r1')]);
  const joined = await phoneJoin(GUEST_THREE, room.code, 'Ada');
  assert.equal(joined.statusCode, 200, JSON.stringify(joined.body));

  const token = String(joined.body.playerToken);
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(joined.body.slot, 1);
  assert.equal(joined.body.name, 'Ada');

  // The lobby view another seat reads carries no credential: only its owner
  // was handed the token, and only in its own join response.
  for (const player of joined.body.players as Array<Record<string, unknown>>) {
    assert.deepEqual(Object.keys(player).sort(), ['name', 'slot', 'team']);
  }

  const invitation = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${room.code}`,
    headers: headers(GUEST_SIX),
  });
  assert.equal(invitation.statusCode, 200, invitation.body);
  assert.equal(invitation.body.includes(token), false);

  // The row does hold it, because that is what challenge_by_token reads.
  const stored = storedRows.get(room.roomId);
  assert.ok(stored);
  assert.equal(members(stored)[0].playerToken, token);
});

test('a phone answer scores its own seat and cannot be pressed twice', async () => {
  const room = await openRoom(HOST_FOURTEEN, [round('r1'), round('r2')]);
  const phone = await phoneJoin(GUEST_FOUR, room.code, 'Mobile');
  assert.equal(phone.statusCode, 200, JSON.stringify(phone.body));
  const token = String(phone.body.playerToken);
  const slot = Number(phone.body.slot);

  // A second seat, on the television, so the round has someone to wait for.
  const hostSlot = await join(HOST_FOURTEEN, room.code, 'Host');
  await start(HOST_FOURTEEN, room.roomId);

  const scored = await phoneAnswer(GUEST_FOUR, token, 'r1', 'a');
  assert.equal(scored.statusCode, 200, JSON.stringify(scored.body));
  assert.equal(scored.body.accepted, true);
  assert.equal(scored.body.correct, true);
  assert.equal(scored.body.answered, 1);
  assert.equal(scored.body.total, 2);
  // The window is still open for the other seat, so the key stays here.
  assert.equal('answerPrimary' in scored.body, false);

  const points = Number(scored.body.points);
  assert.ok(points >= 100 && points <= 160, `unexpected points ${points}`);

  const again = await phoneAnswer(GUEST_FOUR, token, 'r1', 'b');
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.code, 'already_answered');

  // The television's standings agree with the phone's own score.
  const last = await answer(HOST_FOURTEEN, room.roomId, hostSlot, 'r1', 'a');
  assert.equal(last.statusCode, 200, JSON.stringify(last.body));
  const rows = last.body.standings as Array<{ slot: number; score: number }>;
  assert.equal(rows.find(row => row.slot === slot)?.score, points);
});

test('an answer for a card that is not on screen is held, then accepted', async () => {
  const room = await openRoom(HOST_FIFTEEN, [round('r1')]);
  const phone = await phoneJoin(GUEST_FIVE, room.code, 'Early');
  assert.equal(phone.statusCode, 200, JSON.stringify(phone.body));
  const token = String(phone.body.playerToken);
  await join(HOST_FIFTEEN, room.code, 'Host');

  // The lobby has no window. The phone keeps its tile and sends again once the
  // state says `playing`; it is not scored from zero elapsed.
  const early = await phoneAnswer(GUEST_FIVE, token, 'r1', 'a');
  assert.equal(early.statusCode, 409);
  assert.equal(early.body.code, 'not_playing');
  assert.equal(early.body.phase, 'lobby');

  await start(HOST_FIFTEEN, room.roomId);
  const held = await phoneAnswer(GUEST_FIVE, token, 'r1', 'a');
  assert.equal(held.statusCode, 200, JSON.stringify(held.body));
  assert.equal(held.body.correct, true);
});

test('a token that was never minted cannot answer', async () => {
  const room = await openRoom(HOST_SIXTEEN, [round('r1')]);
  await join(HOST_SIXTEEN, room.code, 'Host');
  await join(GUEST_ONE, room.code, 'Guest');
  await start(HOST_SIXTEEN, room.roomId);

  const response = await phoneAnswer(GUEST_SIX, randomUUID(), 'r1', 'a');
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, 'not_joined');
});

// ------------------------------------------------------ Phase D: presence ----

/** Four bytes is enough: the store checks the magic, not the picture. */
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test('a camera stays dark until its phone offers it, then one frame becomes one tile', async () => {
  const room = await openRoom(HOST_SEVEN, [round('r1')]);
  const joined = await phoneJoin(GUEST_EIGHT, room.code, 'Ada');
  assert.equal(joined.statusCode, 200, JSON.stringify(joined.body));
  const token = String(joined.body.playerToken);

  // Nobody has offered a camera, so there is nothing at that address - and
  // the answer says so without leaving a face in a proxy's cache.
  const dark = await frameGet(room.code, 1);
  assert.equal(dark.statusCode, 404);
  assert.equal((dark.json() as { code: string }).code, 'no_frame');
  assert.equal(dark.headers['cache-control'], 'no-store');

  // A frame that arrives before the toggle is refused rather than stored: the
  // permission, not the picture, is what the route trusts.
  const early = await postFrame(GUEST_EIGHT, token, TINY_JPEG.toString('base64'));
  assert.equal(early.statusCode, 409);
  assert.equal(early.body.code, 'camera_off');

  const on = await postPresence(GUEST_EIGHT, token, true);
  assert.equal(on.statusCode, 200, JSON.stringify(on.body));
  assert.equal(on.body.slot, 1);
  assert.equal(on.body.on, true);

  // The camera is on but has sent nothing: still no picture to draw.
  assert.equal((await frameGet(room.code, 1)).statusCode, 404);

  const sent = await postFrame(GUEST_EIGHT, token, TINY_JPEG.toString('base64'));
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.slot, 1);
  assert.equal(sent.body.version, 1);
  assert.equal(sent.body.ttlMs, 4_000);

  // The URL carries the version because an image component caches by URL; the
  // bytes themselves are the JPEG that was posted.
  const shown = await frameGet(room.code, 1, Number(sent.body.version));
  assert.equal(shown.statusCode, 200);
  assert.equal(shown.headers['content-type'], 'image/jpeg');
  assert.equal(shown.headers['cache-control'], 'no-store, no-transform');
  assert.deepEqual(shown.rawPayload, TINY_JPEG);

  // The television's grid names the seat and points at the same live URL.
  const grid = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${room.code}/presence`,
    headers: headers(HOST_SEVEN),
  });
  assert.equal(grid.statusCode, 200, grid.body);
  const tiles = (grid.json() as { tiles: Array<Record<string, unknown>> }).tiles;
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].slot, 1);
  assert.equal(tiles[0].name, 'Ada');
  assert.equal(tiles[0].on, true);
  assert.equal(tiles[0].frameUrl, `/v1/challenge/${room.code}/presence/1.jpg?v=1`);
  assert.equal(tiles[0].event, null);
});

test('an oversized or non-JPEG frame is refused, and turning the camera off drops the bytes', async () => {
  const room = await openRoom(HOST_TWENTY_ONE, [round('r1')]);
  const joined = await phoneJoin(GUEST_EIGHT, room.code, 'Bo');
  assert.equal(joined.statusCode, 200, JSON.stringify(joined.body));
  const token = String(joined.body.playerToken);
  assert.equal((await postPresence(GUEST_EIGHT, token, true)).statusCode, 200);

  // A body big enough to be a problem is refused before base64 is decoded.
  const huge = await postFrame(GUEST_EIGHT, token, 'A'.repeat(300_000));
  assert.equal(huge.statusCode, 413);
  assert.equal(huge.body.code, 'frame_too_large');

  // So is anything that is not a JPEG, whatever its size.
  const notJpeg = await postFrame(GUEST_EIGHT, token, Buffer.from('GIF89a').toString('base64'));
  assert.equal(notJpeg.statusCode, 415);
  assert.equal(notJpeg.body.code, 'frame_invalid');

  // Neither refusal stored a byte.
  assert.equal((await frameGet(room.code, 1)).statusCode, 404);

  const sent = await postFrame(GUEST_EIGHT, token, TINY_JPEG.toString('base64'));
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  assert.equal((await frameGet(room.code, 1)).statusCode, 200);

  // Off is a deletion, not a hide: the tile falls back to an avatar and the
  // frame's address stops answering immediately.
  const off = await postPresence(GUEST_EIGHT, token, false);
  assert.equal(off.statusCode, 200, JSON.stringify(off.body));
  assert.equal(off.body.on, false);

  const dropped = await frameGet(room.code, 1);
  assert.equal(dropped.statusCode, 404);
  assert.equal((dropped.json() as { code: string }).code, 'no_frame');

  const grid = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${room.code}/presence`,
    headers: headers(HOST_TWENTY_ONE),
  });
  assert.equal(grid.statusCode, 200, grid.body);
  const tile = (grid.json() as { tiles: Array<Record<string, unknown>> }).tiles[0];
  assert.equal(tile.on, false);
  assert.equal(tile.frameUrl, null);
});

test('a vision event is mirrored to the room but never moves the score', async () => {
  const room = await openRoom(HOST_TWENTY_TWO, [round('r1')]);
  const joined = await phoneJoin(GUEST_NINE, room.code, 'Ada');
  assert.equal(joined.statusCode, 200, JSON.stringify(joined.body));
  const token = String(joined.body.playerToken);
  await join(HOST_TWENTY_TWO, room.code, 'Host');
  await start(HOST_TWENTY_TWO, room.roomId);

  const seen = await postEvent(GUEST_NINE, token, 'freeze.hold', 0.92);
  assert.equal(seen.statusCode, 200, JSON.stringify(seen.body));
  // The response says so in as many words: the phone reports, the judge scores.
  assert.equal(seen.body.scored, false);

  const grid = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${room.code}/presence`,
    headers: headers(HOST_TWENTY_TWO),
  });
  assert.equal(grid.statusCode, 200, grid.body);
  const tile = (grid.json() as { tiles: Array<Record<string, unknown>> }).tiles
    .find(candidate => candidate.slot === joined.body.slot);
  assert.ok(tile);
  const event = tile.event as { type: string; score: number } | null;
  assert.ok(event);
  assert.equal(event.type, 'freeze.hold');
  assert.equal(event.score, 0.92);

  // Half a second of confidence is not half a second of points.
  const board = await app.inject({
    method: 'GET',
    url: `/v1/tv/challenge/${room.code}`,
    headers: headers(HOST_TWENTY_TWO),
  });
  assert.equal(board.statusCode, 200, board.body);
  const players = (board.json() as { players: Array<{ score: number }> }).players;
  assert.equal(players.every(player => player.score === 0), true, board.body);

  // The event vocabulary is closed, and a score is a confidence, not a bonus.
  const unknown = await postEvent(GUEST_NINE, token, 'score.plus', 1);
  assert.equal(unknown.statusCode, 400);
  const overconfident = await postEvent(GUEST_NINE, token, 'freeze.hold', 2);
  assert.equal(overconfident.statusCode, 400);
});

test('the answer that closes a room stores it finished, as the host', async () => {
  const room = await openRoom(HOST_EIGHTEEN, [round('only')]);
  const phone = await phoneJoin(GUEST_SEVEN, room.code, 'Mobile');
  assert.equal(phone.statusCode, 200, JSON.stringify(phone.body));
  const token = String(phone.body.playerToken);
  const phoneSlot = Number(phone.body.slot);

  // A seat on the television, so the phone's answer is the one that closes the
  // room. The television never presses NEXT after the podium, so nothing else
  // will write the finished phase.
  const hostSlot = await join(HOST_EIGHTEEN, room.code, 'Host');
  await start(HOST_EIGHTEEN, room.roomId);

  const first = await answer(HOST_EIGHTEEN, room.roomId, hostSlot, 'only', 'a');
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));

  const last = await phoneAnswer(GUEST_SEVEN, token, 'only', 'a');
  assert.equal(last.statusCode, 200, JSON.stringify(last.body));
  assert.equal(last.body.phase, 'finished');

  // A restart inside the TTL loads the row, so it must not still say playing.
  const stored = storedRows.get(room.roomId);
  assert.ok(stored, 'the closing answer must persist the room');
  assert.equal(stored.phase, 'finished');
  assert.equal(stored.awarded, true);
  // The write is the host's (challenge_save refuses anyone else) and the seat
  // keeps the credential only the phone was given.
  const storedSeat = members(stored).find(row => row.slot === phoneSlot);
  assert.ok(storedSeat, 'the phone seat must survive the host write');
  assert.equal(storedSeat.playerToken, token);
});

test('a late answer is counted, stored, and read back after a restart', async () => {
  // A room this process has never seen, already on a question whose window
  // closed 20 s ago: 15 s round + 2 s grace, plus margin.
  const room = storedRoom(HOST_NINETEEN, '135790', [round('only')]);
  room.phase = 'playing';
  room.roundStartedAt = Date.now() - 20_000;
  const token = randomUUID();
  room.players = [
    {
      slot: 1,
      name: 'Slow',
      team: 0,
      score: 0,
      streak: 0,
      correct: 0,
      lateAnswers: 0,
      deviceId: GUEST_SEVEN,
      token,
      answered: {},
    },
    {
      slot: 2,
      name: 'Host',
      team: 0,
      score: 0,
      streak: 0,
      correct: 0,
      lateAnswers: 0,
      deviceId: HOST_NINETEEN,
      token: null,
      answered: {},
    },
  ];
  assert.equal(await storeCreate(room, { deviceId: HOST_NINETEEN }), 'written');

  const late = await phoneAnswer(GUEST_SEVEN, token, 'only', 'a');
  assert.equal(late.statusCode, 200, JSON.stringify(late.body));
  assert.equal(late.body.late, true);
  // Accuracy only: base points, no speed and no streak bonus.
  assert.equal(late.body.points, 100);

  // The row is what a restart reads, and the count has to be on it: without
  // this the podium shows a low score and no reason for it.
  const stored = storedRows.get(room.roomId);
  assert.ok(stored);
  assert.equal(members(stored).find(row => row.slot === 1)?.lateAnswers, 1);

  const reloaded = found(await storeLoad(room.roomId, { deviceId: HOST_NINETEEN }));
  assert.equal(reloaded.players.find(player => player.slot === 1)?.lateAnswers, 1);
});

test('a phone stream primes the board with no answer key and no token', async () => {
  const room = await openRoom(HOST_SEVENTEEN, [round('r1')]);
  const phone = await phoneJoin(GUEST_SIX, room.code, 'Watcher');
  assert.equal(phone.statusCode, 200, JSON.stringify(phone.body));
  await join(HOST_SEVENTEEN, room.code, 'Host');
  await start(HOST_SEVENTEEN, room.roomId);

  // A browser is the client here, so the stream is read off a real socket:
  // `EventSource` is the interface this route has to satisfy.
  const streamApp = Fastify();
  registerChallengeRoutes(streamApp);
  const origin = await streamApp.listen({ port: 0, host: '127.0.0.1' });
  const abort = new AbortController();

  try {
    const response = await realFetch(
      `${origin}/v1/challenge/${room.code}/stream?device_id=${GUEST_SIX}`,
      { signal: abort.signal },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);

    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: challenge.state')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    assert.match(text, /retry: 3000/);
    assert.match(text, /: open/);

    const line = text.split('\n').find(candidate => candidate.startsWith('data: '));
    assert.ok(line, text);
    const board = JSON.parse(line.slice('data: '.length)) as {
      type: string;
      state: {
        phase: string;
        endsAt: number;
        question: Record<string, unknown>;
        players: Array<Record<string, unknown>>;
      };
    };
    assert.equal(board.type, 'challenge.state');
    assert.equal(board.state.phase, 'playing');
    assert.equal(board.state.question.roundId, 'r1');
    assert.equal('answerKey' in board.state.question, false);
    assert.ok(board.state.endsAt > Date.now());

    // A phone learns *that* a seat answered, never what it chose.
    for (const player of board.state.players) {
      assert.equal(typeof player.answered, 'boolean');
      assert.equal('playerToken' in player, false);
    }
    assert.equal(text.includes('playerToken'), false);
    assert.equal(text.includes('answerKey'), false);
  } finally {
    abort.abort();
    await streamApp.close();
  }
});

test('the public door survives bad input and a burst without a 5xx', async () => {
  const malformed = await app.inject({
    method: 'POST',
    url: '/v1/challenge/join',
    headers: { ...headers(GUEST_SIX), 'content-type': 'application/json' },
    payload: '{"code":',
  });
  assert.ok(malformed.statusCode < 500, `malformed JSON answered ${malformed.statusCode}`);

  // A name longer than the freeze window is cut to 16, never a 5xx; the code
  // in this probe is simply not open.
  const longName = await phoneJoin(GUEST_SIX, '000000', 'x'.repeat(21));
  assert.ok(longName.statusCode < 500, `oversized name answered ${longName.statusCode}`);

  const badCode = await phoneJoin(GUEST_SIX, 'abc', 'Ada');
  assert.equal(badCode.statusCode, 400);

  const statuses: number[] = [];
  for (let request = 0; request < 50; request += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/challenge/join',
      headers: headers(GUEST_SIX),
      payload: { code: '000000', name: `Burst${request}` },
    });
    statuses.push(response.statusCode);
  }
  assert.equal(statuses.some(status => status >= 500), false, statuses.join(','));
});

test('a photo round carries its image from the frozen deck to the question', async () => {
  const image = 'https://cdn.globie.earth/dnp/dnp_wildlife-3.jpg';

  // The parser is the single gate both routes use; it must not strip a URL
  // just because it is longer than a clue.
  const parsed = parseGameRound({
    ...round('photo'),
    hasPhoto: true,
    image,
  });
  assert.equal(parsed?.image, image);

  // A round without a photo says so by omitting the key, not by sending null.
  const plain = parseGameRound(round('plain'));
  assert.equal(plain !== null && 'image' in plain, false);

  const room = await openRoom(HOST_TWENTY, [
    { ...round('photo'), hasPhoto: true, image },
  ]);
  await join(HOST_TWENTY, room.code, 'Ada');
  await join(HOST_TWENTY, room.code, 'Bo');
  await start(HOST_TWENTY, room.roomId);

  // Each join queues a fresh lobby, so the question is behind them.
  const pushed: Array<Record<string, unknown>> = [];
  for (let poll = 0; poll < 6; poll += 1) {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tv/commands?waitMs=1',
      headers: headers(HOST_TWENTY),
    });
    assert.equal(response.statusCode, 200, response.body);
    const command = (response.json() as { command: Record<string, unknown> | null }).command;
    if (!command) break;
    if (command.type === 'challenge.question') {
      pushed.push(command);
      break;
    }
  }

  assert.equal(pushed.length, 1, 'the room never pushed its question');
  const question = pushed[0].round as { hasPhoto: boolean; image?: string };
  assert.equal(question.hasPhoto, true);
  assert.equal(question.image, image);

  // The board only ever sees this payload, so the URL must survive the store
  // too: a restarted relay reads the deck back from its row.
  const stored = found(await storeLoad(room.roomId, { deviceId: HOST_TWENTY }));
  assert.equal(stored.deck.rounds[0].image, image);
});
