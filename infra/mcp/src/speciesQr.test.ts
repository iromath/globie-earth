// Tests for the species deep-link square.
//
// The contract is narrow on purpose: only a species page can be encoded, so a
// scan can never open an address someone else chose. These tests drive the real
// route - the PNG magic proves an image, and two ids producing two payloads
// proves the id is part of what is encoded.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { registerSpeciesQrRoute } from './speciesQr.js';

let app: FastifyInstance;

before(async () => {
  app = Fastify();
  registerSpeciesQrRoute(app);
  await app.ready();
});

after(async () => {
  await app.close();
});

test('a species page is drawn as a PNG', async () => {
  const qr = await app.inject({method: 'GET', url: '/v1/species/dnp_fauna/7/qr.png'});
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.headers['content-type'], 'image/png');
  assert.equal(qr.rawPayload.subarray(1, 4).toString('ascii'), 'PNG');
  // The address is the content, so the square never needs to be redrawn.
  assert.match(String(qr.headers['cache-control']), /max-age=86400/);
});

test('every table the web app serves has a square', async () => {
  for (const type of ['dnp_plant', 'dnp_wildlife', 'dnp_fauna', 'dnp_species']) {
    const qr = await app.inject({method: 'GET', url: `/v1/species/${type}/12/qr.png`});
    assert.equal(qr.statusCode, 200, type);
  }
});

test('the id is part of the code, not decoration', async () => {
  const seven = await app.inject({method: 'GET', url: '/v1/species/dnp_fauna/7/qr.png'});
  const eight = await app.inject({method: 'GET', url: '/v1/species/dnp_fauna/8/qr.png'});
  const again = await app.inject({method: 'GET', url: '/v1/species/dnp_fauna/7/qr.png'});
  assert.notEqual(seven.rawPayload.toString('base64'), eight.rawPayload.toString('base64'));
  assert.equal(seven.rawPayload.toString('base64'), again.rawPayload.toString('base64'));
});

test('anything that is not a species page is refused', async () => {
  // The TV's table name is plural; the web path is not. A plural path is a bug
  // on the caller's side, not a second address to encode.
  for (const url of [
    '/v1/species/dnp_plants/7/qr.png',
    '/v1/species/https%3A%2F%2Fevil.test/7/qr.png',
    '/v1/species/dnp_fauna/seven/qr.png',
    '/v1/species/dnp_fauna/7%2F..%2F..%2Fadmin/qr.png',
  ]) {
    const refused = await app.inject({method: 'GET', url});
    assert.ok(
      refused.statusCode === 400 || refused.statusCode === 404,
      `${url} -> ${refused.statusCode}`,
    );
  }
});
