// Phase D Tier 1: the phones are the cameras, the television is the table.
//
// A frame here is one JPEG held in this process for four seconds and never
// written anywhere - not to Postgres, not to disk, not to S3. A seat
// turns its camera on for one party, every frame replaces the last one, and
// turning it off drops the bytes immediately. Nothing here records.
//
// This module is deliberately dependency-free, so challenge.ts can compose a
// phone's presence without importing the routes and the routes can import the
// room engine without a cycle.

/**
 * A frame older than this is not worth drawing; the tile falls back.
 *
 * Four seconds, not one and a half: the television does not request the
 * picture the instant it polls. It holds a url for 2.5 s so the <Image> can
 * finish (a 2.6 KB jpeg takes ~1.3 s from Bangkok to this relay), and the
 * frame behind that url can already be up to a second old. The old 1.5 s
 * expired before the image request arrived, so every tile drew its
 * placeholder instead of a face.
 */
export const FRAME_TTL_MS = 4_000;

/** 640x360 JPEG at a phone's quality is ~40 KB; this refuses anything larger. */
export const FRAME_MAX_BYTES = 160 * 1024;

/**
 * What the phone's on-device computer vision may report.
 *
 * The list is closed on purpose: an event is advisory, and the television and
 * the judge only ever branch on a name they already know. Adding a game means
 * adding its event here, not accepting whatever a client sends.
 */
export const PRESENCE_EVENTS = ['pose.match', 'freeze.hold', 'species.match', 'photo.ready'] as const;
export type PresenceEventType = (typeof PRESENCE_EVENTS)[number];

export interface PresenceEvent {
  type: PresenceEventType;
  /** 0..1, as the phone measured it. The judge never reads this. */
  score: number;
  at: number;
}

export interface PresenceSeat {
  on: boolean;
  frame: Buffer | null;
  frameAt: number;
  /**
   * Bumped on every accepted frame so the drawing URL changes. An image
   * component caches by URL, so a new frame that kept its URL would never
   * appear.
   */
  version: number;
  event: PresenceEvent | null;
}

/** The part of a seat a room snapshot carries; the bytes never travel in JSON. */
export interface PresenceTile {
  slot: number;
  on: boolean;
  version: number;
  frameAt: number;
  event: PresenceEvent | null;
}

/** At most one entry per seat, at most one room's worth per party. */
const SLOTS_CAP = 8;
/** Rooms are pruned by the room engine's own TTL; this is the safety net. */
const ROOMS_CAP = 256;

const rooms = new Map<string, Map<number, PresenceSeat>>();

function seatsOf(roomId: string): Map<number, PresenceSeat> {
  let seats = rooms.get(roomId);
  if (!seats) {
    seats = new Map();
    rooms.set(roomId, seats);
  }
  return seats;
}

/** Drops the oldest room when the map outgrows its cap. */
function capRooms(): void {
  if (rooms.size <= ROOMS_CAP) return;
  const oldest = rooms.keys().next();
  if (!oldest.done) rooms.delete(oldest.value);
}

export function enablePresence(roomId: string, slot: number): void {
  const seats = seatsOf(roomId);
  const seat = seats.get(slot);
  if (seat) {
    seat.on = true;
  } else {
    if (seats.size >= SLOTS_CAP) return;
    seats.set(slot, { on: true, frame: null, frameAt: 0, version: 0, event: null });
  }
  capRooms();
}

/** Turning the camera off forgets the last frame as well as the permission. */
export function disablePresence(roomId: string, slot: number): void {
  const seat = rooms.get(roomId)?.get(slot);
  if (!seat) return;
  seat.on = false;
  seat.frame = null;
  seat.frameAt = 0;
  seat.version += 1;
}

export function presenceOn(roomId: string, slot: number): boolean {
  return rooms.get(roomId)?.get(slot)?.on === true;
}

/** The house rule: no camera means no bytes, however they arrived. */
export function putFrame(roomId: string, slot: number, data: Buffer, now: number): number | null {
  if (!presenceOn(roomId, slot)) return null;
  if (data.length === 0 || data.length > FRAME_MAX_BYTES) return null;
  if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return null;

  const seat = rooms.get(roomId)?.get(slot);
  if (!seat) return null;
  seat.frame = data;
  seat.frameAt = now;
  seat.version += 1;
  return seat.version;
}

/** Null when the seat is off, has never sent, or its last frame has gone stale. */
export function readFrame(roomId: string, slot: number, now: number): Buffer | null {
  const seat = rooms.get(roomId)?.get(slot);
  if (!seat || !seat.on || !seat.frame) return null;
  if (now - seat.frameAt > FRAME_TTL_MS) return null;
  return seat.frame;
}

export function putEvent(roomId: string, slot: number, type: PresenceEventType, score: number, now: number): void {
  const seats = seatsOf(roomId);
  let seat = seats.get(slot);
  if (!seat) {
    if (seats.size >= SLOTS_CAP) return;
    seat = { on: false, frame: null, frameAt: 0, version: 0, event: null };
    seats.set(slot, seat);
  }
  seat.event = { type, score, at: now };
  capRooms();
}

/** One entry per player in the room, whether or not their camera is on. */
export function presenceTiles(roomId: string, slots: number[], now: number): PresenceTile[] {
  const seats = rooms.get(roomId);
  return [...slots]
    .sort((left, right) => left - right)
    .map(slot => {
      const seat = seats?.get(slot);
      return {
        slot,
        on: seat?.on === true,
        version: seat?.version ?? 0,
        frameAt: seat?.frameAt ?? 0,
        event: seat?.event ?? null,
      };
    });
}

/**
 * The path a television draws for one seat.
 *
 * A path rather than an absolute URL because the television and the phone
 * reach the relay on different hosts; each prefixes its own base. A frame is
 * only ever addressed while it can still be read.
 */
export function presenceFramePath(code: string, tile: PresenceTile): string | null {
  if (!tile.on || tile.frameAt === 0) return null;
  return `/v1/challenge/${code}/presence/${tile.slot}.jpg?v=${tile.version}`;
}

/** Called when a room closes: the party is over, so are its cameras. */
export function forgetPresence(roomId: string): void {
  rooms.delete(roomId);
}
