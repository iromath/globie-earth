// The species-enrichment route: the same Wikipedia lookup the MCP tool makes,
// exposed as a plain GET so the app's species page can read it too.
//
// It sits beside /mcp for the same reason /route, /voice and /contribute do:
// the page holds no third-party credential and this lookup needs none, but the
// server's pattern is that every side-route resolves the caller's identity in
// one place. Here that keeps the endpoint from being an anonymous relay to
// Wikipedia's API.

import type { FastifyInstance } from 'fastify';
import { resolveCaller } from './identity.js';
import { fetchWikiSummary } from './wiki.js';

/** A species name longer than this is not a lookup, it is abuse of the query. */
const MAX_NAME_LENGTH = 200;

export function registerWikiRoute(app: FastifyInstance): void {
  app.get('/wiki', async (request, reply) => {
    // The same identity /mcp requires, for the same reason /route does: one
    // place checks who is calling. The browser host already holds a device id.
    if (!resolveCaller(request.headers)) {
      return reply.code(401).send({
        error:
          'The species lookup needs a caller identity: the same X-Device-Id (or demo ' +
          'Authorization bearer) that /mcp accepts. See infra/mcp/README.md.',
      });
    }

    const query = request.query as { name?: unknown };
    const name = typeof query.name === 'string' ? query.name.trim() : '';
    if (!name) {
      return reply.code(400).send({ error: 'The lookup needs ?name=<scientific or common name>.' });
    }
    if (name.length > MAX_NAME_LENGTH) {
      return reply
        .code(400)
        .send({ error: `The species name must be ${MAX_NAME_LENGTH} characters or fewer.` });
    }

    // A null lookup is a normal 404, not an error: Wikipedia has no article for
    // that name, and the page shows nothing rather than inventing a summary.
    // `hostImage` copies a freely-licensed lead image into our own object
    // storage, so the page serves the picture from our origin rather than
    // hot-linking Wikimedia's CDN.
    const summary = await fetchWikiSummary(name, { hostImage: true });
    if (!summary) {
      return reply.code(404).send({ error: `No Wikipedia article for "${name}".` });
    }

    return reply.send(summary);
  });
}
