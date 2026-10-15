// Simulates an Alexa+ style MCP host connecting with a *credential only* - the
// static bearer from decision D4 - and no X-Device-Id header. Production should
// use MCP OAuth 2.1; this script exists to demonstrate the hackathon's static
// bearer exchange honestly, rather than dress it up as OAuth.
//
// It presents only:
//
//   Authorization: Bearer <MCP_BEARER_TOKEN>
//
// and nothing else. The server exchanges that, at the MCP edge, for
// MCP_DEMO_DEVICE_ID; this script never sends a device id, so a successful run
// is proof the exchange happened. Pair it with the browser host in
// infra/mcp-client (which presents its own X-Device-Id) to show both identity
// paths.
//
//   npm run simulate:alexa                          (from infra/mcp; loads ../.env)
//   npm run simulate:alexa -- --negative
//   node --env-file=../.env scripts/simulate-alexa-plus.mjs
//   MCP_URL=http://localhost:8092/mcp node --env-file=../.env scripts/simulate-alexa-plus.mjs
//
// Add --negative to send a deliberately wrong token and show the server refuse
// it, which proves the credential is enforced rather than decorative. That run
// needs no real token.
//
// It also proves protocol negotiation. Alexa+'s MCP client advertises
// protocolVersion "2025-03-26", while our server pins "2025-11-25" as its newest
// (server.ts, REQUIRED_PROTOCOL_VERSION). The SDK's Client.connect() hardcodes
// LATEST_PROTOCOL_VERSION in its initialize request, so this script rewrites
// just that one field on the wire and asserts the version the server echoed
// back - a down-negotiation, not a rejection. Override with MCP_PROTOCOL.
//
//   MCP_PROTOCOL=2025-11-25 node --env-file=../.env scripts/simulate-alexa-plus.mjs
//
// Exit 0 = the run behaved as expected, 2 = no token configured.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_STRING = process.env.MCP_URL ?? 'https://mcp.globie.earth/mcp';
const REAL_TOKEN = (process.env.MCP_BEARER_TOKEN ?? '').trim();
const NEGATIVE = process.argv.includes('--negative');
// The version this simulated host puts on the wire. Defaults to the version the
// Alexa+ client advertises; the server is expected to negotiate down to it.
const ADVERTISED_VERSION = (process.env.MCP_PROTOCOL ?? '2025-03-26').trim();

/** Shows only enough of a secret to recognise it, never the whole value. */
function redact(token) {
  return token.length > 8 ? `${token.slice(0, 8)}…` : '(empty)';
}

function firstText(result) {
  const block = Array.isArray(result?.content) ? result.content[0] : undefined;
  return block?.type === 'text' ? block.text : '';
}

/** One line of the first content block, so long tool payloads stay readable. */
function oneLine(result, limit = 200) {
  return firstText(result).replace(/\s+/g, ' ').slice(0, limit);
}

/** The /health sibling of the configured MCP URL, for the auth banner. */
async function showHealth() {
  const url = new URL(URL_STRING);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, '/health');
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await response.json();
    console.log(`   health  ${response.status}  auth=${JSON.stringify(body?.auth ?? null)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`   health  unreachable (${message})`);
  }
}

if (!REAL_TOKEN && !NEGATIVE) {
  console.error('MCP_BEARER_TOKEN is not set. Run with:');
  console.error('  node --env-file=../.env scripts/simulate-alexa-plus.mjs');
  process.exit(2);
}

const token = NEGATIVE ? `wrong-${'0'.repeat(32)}` : REAL_TOKEN;

let failures = 0;

console.log('Simulated Alexa+ style host - static bearer exchange (NOT OAuth 2.1)');
console.log(`   target  ${URL_STRING}`);
console.log(`   sends   Authorization: Bearer ${redact(token)}   (no X-Device-Id)`);
if (NEGATIVE) console.log('   mode    NEGATIVE - this token must be refused');

console.log('\n0. health (unauthenticated)');
await showHealth();

const transport = new StreamableHTTPClientTransport(new URL(URL_STRING), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'globie-alexa-plus-sim', version: '1.0.0' });

// Client.connect() always advertises LATEST_PROTOCOL_VERSION, so rewrite that one
// field of the initialize request in flight to ADVERTISED_VERSION. Everything else
// the SDK sends is untouched; the transport then carries whatever the server
// negotiated in the mcp-protocol-version header on every later request.
const sendRequest = client.request.bind(client);
client.request = (request, schema, options) => {
  if (request?.method === 'initialize' && request.params) {
    request.params.protocolVersion = ADVERTISED_VERSION;
  }
  return sendRequest(request, schema, options);
};

try {
  console.log('\n1. initialize');
  await client.connect(transport);
  const server = client.getServerVersion();
  const capabilities = Object.keys(client.getServerCapabilities() ?? {}).join(', ');
  const negotiated = transport.protocolVersion;
  console.log(`   ← ${server?.name}@${server?.version}, protocol ${negotiated}`);
  console.log(`   protocol  advertised ${ADVERTISED_VERSION} → negotiated ${negotiated}`);
  console.log(`   capabilities: ${capabilities}`);
  if (negotiated !== ADVERTISED_VERSION) {
    failures += 1;
    console.error(`   ! expected the server to negotiate ${ADVERTISED_VERSION}, got ${negotiated}`);
  }

  console.log('\n2. tools/list');
  const { tools } = await client.listTools();
  console.log(`   ← ${tools.length} tool(s): ${tools.map((tool) => tool.name).join(', ')}`);

  // With no X-Device-Id in play, this reads the *exchanged* identity's own rows.
  console.log('\n3. tools/call get_my_deeds  (which identity did the token resolve to?)');
  const deeds = await client.callTool({ name: 'get_my_deeds', arguments: {} });
  console.log(`   ← ${oneLine(deeds)}`);

  console.log('\n4. tools/call get_sanctuary_conditions  (a live read)');
  const conditions = await client.callTool({ name: 'get_sanctuary_conditions', arguments: {} });
  console.log(`   ← ${oneLine(conditions)}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (NEGATIVE) {
    console.log(`\n   ← refused as expected: ${message}`);
  } else {
    failures += 1;
    console.error(`\nfailed: ${message}`);
  }
} finally {
  await client.close().catch(() => {});
}

if (failures === 0) {
  console.log(
    NEGATIVE
      ? '\nA wrong token was refused, so the credential is enforced.'
      : '\nAccepted with Authorization only - the static bearer was exchanged for the demo device at the MCP edge.',
  );
  if (!NEGATIVE) console.log('Reminder: a shared demo secret, not MCP OAuth 2.1.');
}
process.exit(failures === 0 ? 0 : 1);
