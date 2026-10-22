// Phase D Tier 1 routes: a phone offers its camera, sends small frames, and
// the television draws them beside the seats.
//
// The transport is HTTP rather than a WebSocket (this process has no
// WebSocket server, and the television already knows how to poll a JSON
// route), so a frame is one POST and a tile is one <Image> whose URL changes
// with every frame. The television polls every 800 ms but only advances a
// tile's url every 2.5 s: a changing uri cancels the load already in flight,
// and over a long link a load outlasts the poll. Frames live for four
// seconds (FRAME_TTL_MS) so the url being drawn is still readable when the
// image request lands.
//
// Nothing here judges anything. A computer-vision event is recorded and
// mirrored to the screen; the score still comes from evaluateAnswer in
// tvGame.ts, because a phone that could score itself could also lie.

import type { FastifyInstance } from 'fastify';

import { overLimit, publish, RATE_WINDOW_MS, residentRoomByCode, roomByCode, tokenRoom } from './challenge.js';
import type { ChallengeRoom } from './challenge.js';
import { resolveCaller } from './identity.js';
import {
  FRAME_MAX_BYTES,
  FRAME_TTL_MS,
  PRESENCE_EVENTS,
  disablePresence,
  enablePresence,
  presenceFramePath,
  presenceOn,
  presenceTiles,
  putEvent,
  putFrame,
  readFrame,
  type PresenceEventType,
  type PresenceTile,
} from './presenceStore.js';
import { enqueueForTv } from './tvCommands.js';
import type { TvPresenceTile } from './tvCommands.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[0-9]{6}$/;
const SLOT = /^([1-8])\.jpg$/;

/** 5 fps per phone, four phones, a little headroom for retries. */
const FRAMES_PER_IP = 1_800;
const FRAMES_PER_SEAT = 420;
const EVENTS_PER_SEAT = 60;
/** The television polls four tiles a few times a second. */
const READS_PER_IP = 3_000;

/** base64 inflates by 4/3; refuse before decoding rather than after. */
const FRAME_CHARS_MAX = Math.ceil((FRAME_MAX_BYTES * 4) / 3) + 16;

/** The whole grid as the television draws it: one snapshot, never a delta. */
function tvTiles(room: ChallengeRoom, now: number): TvPresenceTile[] {
  return presenceTiles(room.roomId, room.players.map(player => player.slot), now).map(tile => ({
    slot: tile.slot,
    name: room.players.find(player => player.slot === tile.slot)?.name ?? `P${tile.slot}`,
    on: tile.on,
    version: tile.version,
    frameAt: tile.frameAt,
    frameUrl: presenceFramePath(room.code, tile),
    event: tile.event,
  }));
}

/**
 * Tells the television a seat's camera changed.
 *
 * Only the toggle is pushed - a frame is not, because five per second per
 * phone would fill the command queue and the queue is for state, not pixels.
 * The tiles themselves are polled from the room.
 */
function pushPresence(room: ChallengeRoom, now: number): void {
  const tiles = tvTiles(room, now);
  enqueueForTv(room.hostDeviceId, { type: 'challenge.presence', roomId: room.roomId, tiles });
}

function tilesForPhone(room: ChallengeRoom, now: number): Array<{ slot: number; on: boolean; frameUrl: string | null }> {
  return presenceTiles(room.roomId, room.players.map(player => player.slot), now).map(tile => ({
    slot: tile.slot,
    on: tile.on,
    frameUrl: presenceFramePath(room.code, tile),
  }));
}

export function registerChallengePresenceRoutes(app: FastifyInstance): void {
  /**
   * POST /v1/challenge/presence - this seat offers, or withdraws, its camera.
   *
   * Opt-in per party, and off by default: turning it off drops the last frame
   * rather than just hiding it.
   */
  app.post('/v1/challenge/presence', async (request, reply) => {
    const now = Date.now();
    const caller = resolveCaller(request.headers);
    if (!caller) return reply.code(401).send({ error: 'Presence needs a caller identity.' });

    const body = (request.body ?? {}) as { playerToken?: unknown; on?: unknown };
    const token = typeof body.playerToken === 'string' ? body.playerToken.trim() : '';
    if (!UUID.test(token)) {
      return reply.code(400).send({ error: 'Presence needs a playerToken.' });
    }
    if (typeof body.on !== 'boolean') {
      return reply.code(400).send({ error: 'Presence needs an on flag.' });
    }

    const seat = await tokenRoom(token, now, caller);
    if (!seat) return reply.code(404).send({ error: 'That player token is not in a live room.', code: 'not_joined' });

    const { room, slot } = seat;
    if (room.phase === 'finished') {
      return reply.code(409).send({ error: 'That room has finished.', code: 'finished' });
    }

    if (body.on) enablePresence(room.roomId, slot);
    else disablePresence(room.roomId, slot);

    // The phones watch the same room; a seat's camera is part of its state.
    publish(room);
    pushPresence(room, now);

    return reply.send({ slot, on: body.on });
  });

  /**
   * POST /v1/challenge/presence/frame - one JPEG, base64 in JSON.
   *
   * JSON keeps the one body parser this server has (and the 48 MB ceiling it
   * already enforces). A seat may only send while its camera is on, so an
   * outage in the toggle can never leak a frame.
   */
  app.post('/v1/challenge/presence/frame', async (request, reply) => {
    const now = Date.now();
    if (overLimit(`frame:${request.ip}`, FRAMES_PER_IP, now)) {
      return reply
        .code(429)
        .send({ error: 'Too many frames from this address.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    const caller = resolveCaller(request.headers);
    if (!caller) return reply.code(401).send({ error: 'Presence needs a caller identity.' });

    const body = (request.body ?? {}) as { playerToken?: unknown; frame?: unknown };
    const token = typeof body.playerToken === 'string' ? body.playerToken.trim() : '';
    const frame = typeof body.frame === 'string' ? body.frame : '';
    if (!UUID.test(token) || !frame) {
      return reply.code(400).send({ error: 'A frame needs a playerToken and a base64 frame.' });
    }
    if (frame.length > FRAME_CHARS_MAX) {
      return reply.code(413).send({ error: 'That frame is too large.', code: 'frame_too_large' });
    }

    const seat = await tokenRoom(token, now, caller);
    if (!seat) return reply.code(404).send({ error: 'That player token is not in a live room.', code: 'not_joined' });

    const { room, slot } = seat;
    if (room.phase === 'finished') {
      return reply.code(409).send({ error: 'That room has finished.', code: 'finished' });
    }
    if (!presenceOn(room.roomId, slot)) {
      return reply.code(409).send({ error: 'That camera is off.', code: 'camera_off' });
    }

    // A phone cannot exceed its own budget however many handsets share the
    // household's uplink.
    if (overLimit(`frame:${room.roomId}:${slot}`, FRAMES_PER_SEAT, now)) {
      return reply
        .code(429)
        .send({ error: 'That camera is sending too quickly.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    const version = putFrame(room.roomId, slot, Buffer.from(frame, 'base64'), now);
    if (version === null) {
      return reply.code(415).send({ error: 'A frame must be a JPEG under the size limit.', code: 'frame_invalid' });
    }

    return reply.send({ slot, version, ttlMs: FRAME_TTL_MS });
  });

  /**
   * POST /v1/challenge/presence/event - what the phone's own CV saw.
   *
   * Advisory by construction: it is recorded, mirrored in the room snapshot
   * and never turned into points here. Round types that use it (freeze dance,
   * charades) read it in the judge, which remains the only scorer.
   */
  app.post('/v1/challenge/presence/event', async (request, reply) => {
    const now = Date.now();
    const caller = resolveCaller(request.headers);
    if (!caller) return reply.code(401).send({ error: 'Presence needs a caller identity.' });

    const body = (request.body ?? {}) as { playerToken?: unknown; type?: unknown; score?: unknown };
    const token = typeof body.playerToken === 'string' ? body.playerToken.trim() : '';
    const type = typeof body.type === 'string' ? body.type : '';
    if (!UUID.test(token) || !(PRESENCE_EVENTS as readonly string[]).includes(type)) {
      return reply.code(400).send({ error: 'An event needs a playerToken and a known type.' });
    }
    if (typeof body.score !== 'number' || !Number.isFinite(body.score) || body.score < 0 || body.score > 1) {
      return reply.code(400).send({ error: 'An event score is a number between 0 and 1.' });
    }

    const seat = await tokenRoom(token, now, caller);
    if (!seat) return reply.code(404).send({ error: 'That player token is not in a live room.', code: 'not_joined' });

    const { room, slot } = seat;
    if (room.phase === 'finished') {
      return reply.code(409).send({ error: 'That room has finished.', code: 'finished' });
    }
    if (overLimit(`event:${room.roomId}:${slot}`, EVENTS_PER_SEAT, now)) {
      return reply
        .code(429)
        .send({ error: 'That seat is reporting too often.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    putEvent(room.roomId, slot, type as PresenceEventType, body.score, now);
    pushPresence(room, now);

    return reply.send({ slot, type, score: body.score, scored: false });
  });

  /**
   * GET /v1/challenge/:code/presence/:file - the latest frame.
   *
   * Anonymous by the room's code, exactly like qr.png: an image component
   * cannot send a header, and the bytes are a face the household already
   * chosen to show to this room. `no-store` keeps proxies and the image cache
   * from holding a frame past its four seconds.
   *
   * The segment is read whole and checked against SLOT, because a route
   * parameter cannot carry a static `.jpg` suffix here: find-my-way keeps the
   * suffix in the parameter's name.
   */
  app.get('/v1/challenge/:code/presence/:file', async (request, reply) => {
    const now = Date.now();
    if (overLimit(`frame-read:${request.ip}`, READS_PER_IP, now)) {
      return reply.code(429).send({ error: 'Too many frames from this address.', code: 'rate_limited' });
    }

    const params = request.params as { code?: unknown; file?: unknown };
    const code = typeof params.code === 'string' ? params.code.trim() : '';
    const slotMatch = typeof params.file === 'string' ? SLOT.exec(params.file.trim()) : null;
    if (!CODE.test(code) || !slotMatch) {
      return reply.code(400).send({ error: 'A frame is addressed by code and slot.', code: 'invalid_frame' });
    }

    // No header is required or expected: an image component cannot send one,
    // and the six digits are the capability - the same contract as qr.png.
    // The television's presence poll has already hydrated the room here.
    const caller = resolveCaller(request.headers);
    const room = caller
      ? await roomByCode(code, now, caller)
      : residentRoomByCode(code, now);
    if (!room) return reply.code(404).send({ error: 'No room is open with that code.', code: 'not_found' });

    const frame = readFrame(room.roomId, Number(slotMatch[1]), now);
    if (!frame) {
      return reply
        .code(404)
        .header('Cache-Control', 'no-store')
        .send({ error: 'That seat is not showing anything.', code: 'no_frame' });
    }

    return reply
      .code(200)
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-store, no-transform')
      .header('Content-Length', String(frame.length))
      .send(frame);
  });

  /**
   * GET /v1/tv/challenge/:code/presence - the grid for the television.
   *
   * Polled while any tile is on; each answer carries fresh versions, so the
   * image URLs change at the frame rate and the browser never serves a cached
   * face.
   */
  app.get('/v1/tv/challenge/:code/presence', async (request, reply) => {
    const now = Date.now();
    if (overLimit(`presence-read:${request.ip}`, READS_PER_IP, now)) {
      return reply
        .code(429)
        .send({ error: 'Too many presence reads from this address.', code: 'rate_limited', retryAfterMs: RATE_WINDOW_MS });
    }

    const params = request.params as { code?: unknown };
    const code = typeof params.code === 'string' ? params.code.trim() : '';
    if (!CODE.test(code)) {
      return reply.code(400).send({ error: 'A challenge is watched by its six-digit code.', code: 'invalid_code' });
    }

    const caller = resolveCaller(request.headers);
    if (!caller) return reply.code(401).send({ error: 'Watching a challenge needs a caller identity.' });

    const room = await roomByCode(code, now, caller);
    if (!room) return reply.code(404).send({ error: 'No room is open with that code.', code: 'not_found' });

    return reply.send({ roomId: room.roomId, code: room.code, tiles: tvTiles(room, now) });
  });
}

/** The phone's view of presence, for phoneStateOf in challenge.ts. */
export function phonePresence(room: ChallengeRoom, now: number): Array<{ slot: number; on: boolean; frameUrl: string | null }> {
  return tilesForPhone(room, now);
}

export type { TvPresenceTile };
