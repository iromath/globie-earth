// The Globie Earth MCP server.
//
// It exposes the app's existing catalogue, adoption and sanctuary capabilities
// as MCP tools over Streamable HTTP, so an Alexa+ (or any MCP) host can drive a
// real reforestation backend by voice. It is self-hosted on the same Easypanel
// stack as `studio`/`podcast` (decision D2) and is deliberately host-agnostic:
// the coupling is three origins (POSTGREST_URL, STUDIO_URL, PODCAST_URL) and the
// two identity headers.
//
// Sessions: stateful, one transport and one McpServer per MCP session, keyed by
// the `mcp-session-id` header the transport issues on initialize. Each session's
// tools close over the identity resolved from its own request headers, so the
// device/account credential is bound once at connect time and cannot be swapped
// mid-session.
//
// Responses: enableJsonResponse, so a POST is answered with a plain JSON body
// instead of an SSE stream. The spec allows either; JSON survives the reverse
// proxies in front of the container with no buffering surprises, which matters
// more here than server-initiated streaming.

import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { contributeHealth, registerContributeRoute } from './contribute.js';
import { getEmbeddingProvider } from './embed.js';
import { resolveCaller, type Caller } from './identity.js';
import { registerModerateRoute } from './moderate.js';
import { registerForestPrompts } from './prompts/forest.js';
import { registerCatalogResources } from './resources/catalog.js';
import { registerDeedResources } from './resources/deeds.js';
import { registerRouterRoute, routerHealth } from './router.js';
import { registerSpeechRoutes, speechHealth } from './speech.js';
import { registerAdoptionTools } from './tools/adoption.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerConditionsTools } from './tools/conditions.js';
import { registerPhotoTools } from './tools/photo.js';
import { registerPodcastTools } from './tools/podcast.js';
import { registerStudioTools } from './tools/studio.js';
import { registerWikiTools } from './tools/wiki.js';
import { registerWikiRoute } from './wiki-route.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = '0.0.0.0';

/**
 * The protocol version this submission claims. The SDK negotiates from its own
 * supported list; the guard in main() fails the boot if that list's newest
 * version ever moves past this one, so the claim in the README cannot silently
 * become a lie (AMAZON-MCP-PLAN.md 13, "spec drift").
 */
const REQUIRED_PROTOCOL_VERSION = '2025-11-25';

/**
 * Origins allowed to call /mcp from a browser. Read from the comma-separated
 * list compose passes through and matched literally by @fastify/cors, exactly
 * like STUDIO_CORS_ORIGINS - a bare '*' would never match a real Origin. The
 * default is the local dev origins, because non-browser MCP clients send no
 * Origin at all and are unaffected by this list.
 */
const CORS_ORIGINS = (process.env.MCP_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// A contribution arrives as data URLs inside a JSON body: stills (up to 5 MB
// each) and a short clip (up to 24 MB) plus its sampled frames. Base64 inflates
// bytes ~4/3 and the JSON envelope adds a little more, so the raw total can
// reach ~32 MB (MAX_TOTAL_BYTES in contribute.ts) - the body limit must clear
// that with headroom. Fastify's 1 MiB default would 413 a clip before any
// handler runs.
const BODY_LIMIT_BYTES = 48 * 1024 * 1024;

const app = Fastify({ logger: true, bodyLimit: BODY_LIMIT_BYTES });

/** The first value of a possibly repeated header, trimmed, or null. */
function headerString(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || null;
}

/** One live MCP session: its transport and the server bound to the caller. */
interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

const sessions = new Map<string, Session>();

/** A server with the caller's identity closed over its tools. */
function buildServer(caller: Caller): McpServer {
  const server = new McpServer(
    { name: 'globie-earth', version: '1.0.0' },
    {
      instructions:
        'Globie Earth is a reforestation sanctuary in Isaan, Thailand. Use these tools ' +
        'to answer questions about its native species, sites and guardian lore, to ' +
        'recommend a species the listener might adopt, to report live sanctuary ' +
        'conditions, and to find podcasts about the living world. A listener may also attach a ' +
        'photo: describe_photo reads any photo, not only trees, using the vision model rather ' +
        'than the catalogue. describe_species reads the English Wikipedia lead for one species ' +
        'by name - that is external reference text under CC BY-SA, so name Wikipedia as the ' +
        'source and never present it as Globie data. Adoption and soundscape ' +
        'tools are mutating and must be confirmed by the listener first; a soundscape is ' +
        'queued, not produced, so never say one is ready. When you report sanctuary ' +
        'conditions, say that they are modelled fields rather than on-site sensor readings.',
    },
  );

  registerCatalogTools(server, caller);
  registerConditionsTools(server);
  registerWikiTools(server);
  registerPhotoTools(server);
  registerAdoptionTools(server, caller);
  registerStudioTools(server, caller);
  registerPodcastTools(server, caller);

  registerCatalogResources(server, caller);
  registerDeedResources(server, caller);

  registerForestPrompts(server);

  return server;
}

app.get('/health', () => {
  const embeddings = getEmbeddingProvider();
  return {
    // `ok` describes this service: it answered, so it is up.
    ok: true,
    protocolVersion: REQUIRED_PROTOCOL_VERSION,
    embedding: embeddings
      ? { provider: embeddings.name, model: embeddings.model, dims: embeddings.dims }
      : { provider: 'none' },
    // The natural-language front door the browser host posts to. Unset only
    // makes that host fall back to its own wording; the MCP surface is
    // unaffected, exactly as a missing embedding provider only quiets search.
    router: routerHealth(),
    // The self-hosted speech cascade behind /voice/transcribe and /voice/speak.
    // Unset only disables the voice loop, never the MCP surface - and unlike the
    // router it holds no credential at all, because the whole point of
    // self-hosting is that the loop is free, private and unlimited.
    speech: speechHealth(),
    // Photo contributions: the vision scan and the object store must both be
    // set for the route to accept anything, so they are reported together.
    contribute: contributeHealth(),
    // A distinction worth keeping: the server can be up while the API it reads
    // is not configured. The container itself refuses to start without it.
    postgrest: { configured: Boolean(process.env.POSTGREST_URL?.trim()) },
    // Optional neighbours: unset only disables their tools, which then explain
    // themselves rather than looking like the whole server is down.
    proxies: {
      studio: Boolean(process.env.STUDIO_URL?.trim()),
      podcast: Boolean(process.env.PODCAST_URL?.trim()),
    },
    auth: {
      staticBearer: Boolean(process.env.MCP_BEARER_TOKEN?.trim()),
      demoDevice: Boolean(process.env.MCP_DEMO_DEVICE_ID?.trim()),
    },
  };
});

/**
 * The one MCP endpoint. POST carries JSON-RPC messages, GET opens the optional
 * server-to-client stream, DELETE ends the session - all three are handled by
 * the transport, which is why the route forwards the raw Node request/response
 * rather than using Fastify's reply.
 */
app.all('/mcp', async (request, reply) => {
  // A caller this server will not act for. Resolved before any session work, so
  // an anonymous request never allocates a transport.
  const caller = resolveCaller(request.headers);
  if (!caller) {
    return reply.code(401).send({
      error:
        'This MCP server needs a caller identity: a valid X-Device-Id header, or ' +
        'Authorization: Bearer <MCP_BEARER_TOKEN> when a demo device id is configured. ' +
        'See infra/mcp/README.md.',
    });
  }

  const sessionId = headerString(request.headers['mcp-session-id']);
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (existing) {
    return forward(existing.transport, request, reply);
  }

  // A session id that names nothing must not silently start a new session - the
  // host would then be talking to a server it did not initialize.
  if (sessionId) {
    return reply.code(404).send({ error: 'Unknown MCP session. Re-initialize to start a new one.' });
  }

  // Only the initialize POST may create a session. A GET or DELETE with no
  // session is a client mistake, and the transport's own wording is clearer.
  if (request.method !== 'POST') {
    return reply.code(400).send({ error: 'An MCP session must be started with a POST request.' });
  }

  const server = buildServer(caller);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server });
      app.log.info({ sessionId: id }, 'mcp: session opened');
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      app.log.info({ sessionId: id }, 'mcp: session closed');
    },
  });

  // The backstop for a transport that closes without a DELETE (client drop,
  // network loss), so a dead session does not leak its server object.
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
  };

  await server.connect(transport);
  return forward(transport, request, reply);
});

/**
 * Hands the raw request to the transport.
 *
 * `reply.hijack()` tells Fastify this route writes the response itself; the
 * transport talks to the Node objects directly. The try/catch is the only
 * error path left once Fastify has stepped away.
 */
async function forward(
  transport: StreamableHTTPServerTransport,
  request: { raw: import('node:http').IncomingMessage; body?: unknown },
  reply: {
    raw: import('node:http').ServerResponse;
    hijack: () => void;
    getHeader: (name: string) => number | string | string[] | undefined;
  },
): Promise<void> {
  // hijack() hands the response to the transport, which writes to the raw Node
  // object - so the CORS headers @fastify/cors set on the Fastify reply during
  // onRequest never reach the wire. Re-apply them first, or a browser host
  // passes the preflight and then sees the real reply blocked as if CORS were
  // misconfigured.
  for (const name of [
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-expose-headers',
    'vary',
  ]) {
    const value = reply.getHeader(name);
    if (value !== undefined) reply.raw.setHeader(name, value);
  }

  reply.hijack();
  try {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch (error) {
    app.log.error(error, 'mcp: request failed');
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
    }
    reply.raw.end(JSON.stringify({ error: 'The MCP server failed to handle the request.' }));
  }
}

async function main(): Promise<void> {
  if (LATEST_PROTOCOL_VERSION !== REQUIRED_PROTOCOL_VERSION) {
    // Shipping a different protocol than the README claims is a compliance
    // problem, not a warning: fail loudly and make someone re-verify.
    throw new Error(
      `The MCP SDK now defaults to protocol ${LATEST_PROTOCOL_VERSION}, but this server ` +
        `is written and documented against ${REQUIRED_PROTOCOL_VERSION}. ` +
        'Re-verify the transport, update REQUIRED_PROTOCOL_VERSION, and say so in the README.',
    );
  }

  if (!process.env.POSTGREST_URL?.trim()) {
    // Scoped to the one service that needs it. Without an API origin every tool
    // would fail at the first call, so the container says why and exits.
    throw new Error(
      'POSTGREST_URL is not set, so no Globie Earth data can be read. ' +
        'Set it to https://api.globie.earth (or the local stack) - see infra/.env.example.',
    );
  }

  await app.register(cors, {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    // The browser MCP client reads the session id off the initialize response,
    // so it has to be an exposed header on a cross-origin reply.
    exposedHeaders: ['mcp-session-id'],
  });

  // The natural-language router. It sits beside /mcp rather than inside it: the
  // browser host reads tools/list over MCP, posts the utterance here, then makes
  // the returned tool call itself - so the runtime proof stays on /mcp and the
  // model credential never reaches the page.
  registerRouterRoute(app);

  // The voice cascade's ears and mouth. They sit beside /mcp for the same
  // reason /route does: the page posts audio here and this server relays it to
  // the self-hosted speech service, so the endpoint and the models stay
  // server-side and the identity check happens in one place.
  registerSpeechRoutes(app);

  // Contributed photographs. It sits beside /mcp for the same reason: the page
  // posts an image here, and this server - which holds the vision key and the
  // storage key - scans it, refuses anything unsafe, and stores only what
  // passes. The page never holds a credential.
  registerContributeRoute(app);

  // The other half of that feature: the queue /contribute fills is reviewed
  // here. It sits beside /mcp for the same reason - the identity check happens
  // in one place - but unlike /contribute the decision it makes is scoped by
  // api.moderators through RLS, not by this process.
  registerModerateRoute(app);

  // Species enrichment. It sits beside /mcp so the app's species page can read
  // the same Wikipedia lead the describe_species tool answers with, without the
  // page holding any credential - the house reason for every side-route here.
  registerWikiRoute(app);

  await app.listen({ port: PORT, host: HOST });
  app.log.info({ protocolVersion: REQUIRED_PROTOCOL_VERSION }, 'mcp: listening on /mcp');
}

main().catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
