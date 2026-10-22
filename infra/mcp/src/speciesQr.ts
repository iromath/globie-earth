// The species deep link, drawn as a square.
//
// A television has no browser to hand a link to, so the species page prints the
// full web address and a phone camera opens it. The app ships no QR encoder -
// exactly as with the join code - so the relay draws the PNG and the app only
// has to show it.
//
// The path is the species address itself (`/species/<type>/<id>`), not an
// arbitrary `?url=` parameter: this endpoint must never become an open QR
// printer for any address someone wants to put on a television. Only the four
// DNP tables and a numeric id are accepted.

import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';

/** The web app's own address: the QR encodes a page on it, and nothing else. */
const WEB_BASE = (process.env.GLOBIE_WEB_URL ?? 'https://globie.earth').replace(/\/+$/, '');

/**
 * The path segments the web app uses. The TV talks to `dnp_plants` (a
 * PostgREST relation) but the page is `/species/dnp_plant/<id>`.
 */
const WEB_TYPES = new Set([
  'dnp_plant',
  'dnp_wildlife',
  'dnp_fauna',
  'dnp_species',
]);

/** An id is a row number, never a path fragment. */
const ID_PATTERN = /^[0-9]{1,9}$/;

const RATE_WINDOW_MS = 60_000;
const QR_PER_IP = 120;

const rateHits = new Map<string, {count: number; resetAt: number}>();

function overLimit(key: string, limit: number, now: number): boolean {
  const hit = rateHits.get(key);
  if (!hit || now >= hit.resetAt) {
    rateHits.set(key, {count: 1, resetAt: now + RATE_WINDOW_MS});
    return false;
  }
  hit.count += 1;
  return hit.count > limit;
}

export function registerSpeciesQrRoute(app: FastifyInstance): void {
  /**
   * GET /v1/species/:type/:id/qr.png
   *
   * No identity is required because an `<Image>` cannot send a header, and the
   * address is public: it is the same page a phone would reach by typing it.
   */
  app.get('/v1/species/:type/:id/qr.png', async (request, reply) => {
    const now = Date.now();
    if (overLimit(`species-qr:${request.ip}`, QR_PER_IP, now)) {
      return reply.code(429).send({
        error: 'Too many species codes from this address.',
        code: 'rate_limited',
        retryAfterMs: RATE_WINDOW_MS,
      });
    }

    const params = request.params as {type?: unknown; id?: unknown};
    const type = typeof params.type === 'string' ? params.type.trim() : '';
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    if (!WEB_TYPES.has(type) || !ID_PATTERN.test(id)) {
      return reply.code(400).send({
        error: 'A species link is /v1/species/<dnp_plant|dnp_wildlife|dnp_fauna|dnp_species>/<id>/qr.png.',
        code: 'invalid_species',
      });
    }

    const png = await QRCode.toBuffer(`${WEB_BASE}/species/${type}/${id}`, {
      type: 'png',
      width: 512,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {dark: '#0b1a14', light: '#ffffff'},
    });
    return reply
      .header('Content-Type', 'image/png')
      // The address is the content, so the square can be cached for good.
      .header('Cache-Control', 'public, max-age=86400, immutable')
      .send(png);
  });
}
