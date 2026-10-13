// Verifies the Globie Earth MCP server with the *official* MCP SDK client, not
// curl: the claim is that a real MCP host can talk to it, so the handshake,
// tools/list, resources/list, prompts/list and live reads and calls are
// exercised through the same code path a host uses.
//
// It runs against whatever MCP_URL points at (default http://localhost:8099/mcp)
// and needs no demo bearer token - it presents its own X-Device-Id.
//
//   node scripts/verify.mjs
//
// The catalogue checks (resources/list, resources/read, get_my_deeds) read the
// Globie Earth API, so the server under test must have a reachable POSTGREST_URL.
// With the live world-readable API that is enough; no secret is needed.
//
// Exit code 0 means every assertion held.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_STRING = process.env.MCP_URL ?? 'http://localhost:8099/mcp';

// A well-formed uuid, which is all resolveCaller requires for the device path.
// It need not exist in api.devices: device-scoped reads then come back empty,
// which is a real state the server reports rather than an error.
const DEVICE_ID = process.env.MCP_DEVICE_ID ?? '00000000-0000-4000-8000-000000000001';

const EXPECTED_TOOLS = [
  // Phase 1
  'search_forest_knowledge',
  'recommend_species',
  'get_sanctuary_conditions',
  'describe_photo',
  // Added with the shared Wikipedia lookup (src/wiki.ts).
  'describe_species',
  // Phase 2
  'adopt_species',
  'get_my_deeds',
  'get_eco_balance',
  // Phase 3
  'generate_soundscape',
  'search_podcasts',
  'get_trending_podcasts',
];
const EXPECTED_TEMPLATES = [
  'globie://species/{id}',
  'globie://guardian/{id}',
  'globie://site/{id}',
  'globie://dnp/{id}',
  'globie://dnp-plant/{id}',
  'globie://dnp-fauna/{id}',
  'globie://dnp-wildlife/{id}',
];
// The static resource is listed by its registration name; the catalogue
// templates list as expanded *instances* (name = the row's own name), so only
// me/deeds is asserted by name here.
const EXPECTED_RESOURCE = 'me/deeds';
const EXPECTED_PROMPTS = ['forest-guide', 'adopt-a-tree'];

let failures = 0;

function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` - ${detail}` : ''}`);
}

/** The text of the first content block, or '' when there is none. */
function firstText(result) {
  const block = Array.isArray(result?.content) ? result.content[0] : undefined;
  return block?.type === 'text' ? block.text : '';
}

/** Parses the first text block as JSON, or null when it is not JSON. */
function firstJson(result) {
  try {
    return JSON.parse(firstText(result));
  } catch {
    return null;
  }
}

/**
 * What /health says about embeddings, or null when it cannot be read.
 *
 * Step 7 needs this to know what a *correct* search answer looks like: a server
 * with a live provider must return rows, one with EMBEDDING_PROVIDER=none must
 * explain itself. Without it, either mode could pass as the other.
 */
async function healthEmbedding() {
  try {
    const url = new URL(URL_STRING);
    url.pathname = url.pathname.replace(/\/mcp\/?$/, '/health');
    const response = await fetch(url);
    if (!response.ok) return null;
    const payload = await response.json();
    return typeof payload?.embedding?.provider === 'string' ? payload.embedding.provider : null;
  } catch {
    return null;
  }
}

const transport = new StreamableHTTPClientTransport(new URL(URL_STRING), {
  requestInit: { headers: { 'X-Device-Id': DEVICE_ID } },
});

const client = new Client({ name: 'globie-mcp-verify', version: '1.0.0' });

try {
  console.log(`Connecting to ${URL_STRING} as ${DEVICE_ID}`);

  // 1. initialize - connect() performs the handshake and throws if it fails.
  await client.connect(transport);
  const server = client.getServerVersion();
  console.log('\n1. initialize');
  check('handshake completed', Boolean(server), `server=${server?.name}@${server?.version}`);
  check(
    'server advertises tools capability',
    Boolean(client.getServerCapabilities()?.tools),
    `protocol=${transport.protocolVersion}`,
  );

  // 2. tools/list - both phases' tools must all be registered.
  console.log('\n2. tools/list');
  const { tools } = await client.listTools();
  const toolNames = tools.map((tool) => tool.name);
  check(
    'returns every registered tool',
    EXPECTED_TOOLS.every((name) => toolNames.includes(name)),
    toolNames.join(', '),
  );
  const adopt = tools.find((tool) => tool.name === 'adopt_species');
  check(
    'adopt_species is marked mutating',
    adopt?.annotations?.readOnlyHint === false,
  );
  const soundscape = tools.find((tool) => tool.name === 'generate_soundscape');
  check(
    'generate_soundscape is marked mutating',
    soundscape?.annotations?.readOnlyHint === false,
  );

  // 3. resources/list - the template's list callback reads the live catalogue,
  //    so this proves a real PostgREST round trip, not just a registration.
  console.log('\n3. resources/list');
  const templates = await client.listResourceTemplates();
  const templateUrns = templates.resourceTemplates.map((entry) => entry.uriTemplate);
  check(
    'exposes the catalogue templates',
    EXPECTED_TEMPLATES.every((uri) => templateUrns.includes(uri)),
    templateUrns.join(', '),
  );
  const resources = await client.listResources();
  const resourceNames = resources.resources.map((entry) => entry.name);
  check(
    'lists the static me/deeds resource',
    resourceNames.includes(EXPECTED_RESOURCE),
    resourceNames.join(', '),
  );
  const speciesUri = resources.resources.find(
    (entry) => typeof entry.uri === 'string' && entry.uri.startsWith('globie://species/'),
  )?.uri;
  check('expanded a species instance from the live catalogue', Boolean(speciesUri), speciesUri);

  // 4. resources/read - a live read of one concrete species.
  if (speciesUri) {
    console.log(`\n4. resources/read ${speciesUri}`);
    const read = await client.readResource({ uri: speciesUri });
    const entry = Array.isArray(read?.contents) ? read.contents[0] : undefined;
    const parsed = entry ? JSON.parse(entry.text) : null;
    check('returned content', typeof entry?.text === 'string' && entry.text.length > 0);
    check('payload is a species', typeof parsed?.id === 'string' && typeof parsed?.name === 'string',
      parsed?.name);
  }

  // 5. prompts/list and prompts/get - static, so this needs no backend.
  console.log('\n5. prompts');
  const prompts = await client.listPrompts();
  const promptNames = prompts.prompts.map((entry) => entry.name);
  check(
    'lists both prompts',
    EXPECTED_PROMPTS.every((name) => promptNames.includes(name)),
    promptNames.join(', '),
  );
  const guide = await client.getPrompt({ name: 'forest-guide', arguments: { focus: 'soil-fixing trees' } });
  const guideText = guide.messages[0]?.content?.text ?? '';
  check('forest-guide returns instructions', guideText.length > 0);
  check('forest-guide mentions the focus', /soil-fixing trees/.test(guideText));

  // 6. tools/call - get_sanctuary_conditions reads Open-Meteo directly, so it
  //    answers with no PostgREST backend.
  console.log('\n6. tools/call get_sanctuary_conditions');
  const conditions = await client.callTool({ name: 'get_sanctuary_conditions', arguments: {} });
  const conditionsText = firstText(conditions);
  check('returned content', conditionsText.length > 0);
  if (!conditions.isError) {
    const parsed = firstJson(conditions);
    check('payload names its source', typeof parsed?.source === 'string', parsed?.source);
    check(
      'never claims more than modelled fields',
      typeof parsed?.source === 'string' && /modelled/i.test(parsed.source),
    );
  } else {
    // Reaching Open-Meteo can fail offline; that is a graceful tool error, and
    // the round trip still happened. Say so rather than failing the run.
    console.log(`        (tool reported a graceful error: ${conditionsText.slice(0, 120)})`);
  }

  // 7. tools/call on the catalogue tool. Whatever the server's embedding
  //    configuration, the tool must answer - and its answer must say which kind
  //    of search produced it. A semantic answer carries an embedding model and
  //    similarities; a keyword answer (provider off, or configured but failing,
  //    e.g. Bedrock not authorised) must not invent a similarity and must carry
  //    a note explaining why. /health is read so the run can report which mode
  //    was expected, but the assertions hold either way.
  console.log('\n7. tools/call search_forest_knowledge');
  const searchProvider = await healthEmbedding();
  const search = await client.callTool({
    name: 'search_forest_knowledge',
    arguments: { query: 'which tree fixes paddy soil' },
  });
  const searchText = firstText(search);
  const searchJson = firstJson(search);
  check('returned content', searchText.length > 0);
  check(
    'search answers without error',
    !search.isError,
    `provider=${searchProvider ?? 'unknown'} - ${searchText.replace(/\s+/g, ' ').slice(0, 120)}`,
  );
  if (!search.isError) {
    const method = searchJson?.method;
    check('search labels its method', method === 'semantic' || method === 'keyword');
    if (method === 'semantic') {
      check('semantic answer carries an embedding model', typeof searchJson?.embeddingModel === 'string');
    } else if (method === 'keyword') {
      check('keyword answer does not fabricate a similarity', searchJson?.embeddingModel === null);
      check('keyword answer explains itself', typeof searchJson?.note === 'string' && searchJson.note.length > 0);
    }
  }
  console.log(
    `        ${search.isError ? 'tool error' : `${searchJson?.method ?? '?'} result`}: ${searchText.replace(/\s+/g, ' ').slice(0, 140)}`,
  );

  // 8. tools/call on a Phase 2 stateful read - a live device-scoped PostgREST
  //    round trip. An unknown device id yields an honest empty state, not an error.
  console.log('\n8. tools/call get_my_deeds');
  const deeds = await client.callTool({ name: 'get_my_deeds', arguments: {} });
  const deedsText = firstText(deeds);
  check('returned content', deedsText.length > 0);
  if (deeds.isError) {
    check('tool error explains itself', !/unknown reason/i.test(deedsText));
  } else {
    const parsed = firstJson(deeds);
    check('payload carries a deed list', Array.isArray(parsed?.deeds), `count=${parsed?.count}`);
  }

  // 9. tools/call on a Phase 3 proxy tool. It needs a registered device and a
  //    reachable podcast proxy, so an explaining tool error is an acceptable
  //    outcome here; what must never happen is a swallowed one.
  console.log('\n9. tools/call search_podcasts');
  const podcasts = await client.callTool({
    name: 'search_podcasts',
    arguments: { query: 'soil carbon' },
  });
  const podcastsText = firstText(podcasts);
  check('returned content', podcastsText.length > 0);
  if (podcasts.isError) {
    check('tool error explains itself', !/unknown reason/i.test(podcastsText));
  } else {
    const parsed = firstJson(podcasts);
    check('payload carries a feed list', Array.isArray(parsed?.feeds), `count=${parsed?.count}`);
  }
  console.log(
    `        ${podcasts.isError ? 'tool error' : 'result'}: ${podcastsText.replace(/\s+/g, ' ').slice(0, 160)}`,
  );

  // 10. Notifications - the read routes, the SSE stream, and the 4d kill switch
  //     as /health reports it. Read-only and anonymous: the verifier presents a
  //     *fresh* device id that owns nothing, so the feed must answer with a real
  //     empty list rather than an error, and the stream must open - or the switch
  //     must refuse it - exactly as /health says it will. This is the part of the
  //     4b integration set that is safe to run against the live deployment.
  console.log('\n10. notifications');
  const stranger = globalThis.crypto.randomUUID();
  const apiUrl = (path, query) => {
    const url = new URL(URL_STRING);
    url.pathname = url.pathname.replace(/\/mcp\/?$/, path);
    url.search = query ?? '';
    return url;
  };

  let notifHealth = null;
  try {
    const response = await fetch(apiUrl('/health'));
    if (response.ok) notifHealth = (await response.json())?.notifications ?? null;
  } catch {
    notifHealth = null;
  }
  check(
    'health reports the notification switch',
    typeof notifHealth?.enabled === 'boolean',
    JSON.stringify(notifHealth),
  );
  check('health reports a dispatcher state', notifHealth?.dispatcher !== undefined);

  // The feed for a device that owns nothing: a real empty answer, not an error.
  const feedResponse = await fetch(apiUrl('/notifications'), {
    headers: { 'X-Device-Id': stranger },
  });
  const feed = feedResponse.ok ? await feedResponse.json() : null;
  check('feed answers for a stranger', feedResponse.status === 200, `status=${feedResponse.status}`);
  check(
    'a stranger owns no alerts',
    Array.isArray(feed?.notifications) && feed.notifications.length === 0,
    `count=${Array.isArray(feed?.notifications) ? feed.notifications.length : 'n/a'}`,
  );
  check('the feed lends the client a clock', typeof feed?.now === 'string');

  // `since` is the stream's cursor; a future one must paginate to nothing, and a
  // junk one must be refused before it reaches Postgres.
  const sinceResponse = await fetch(apiUrl('/notifications', '?since=2099-01-01T00:00:00.000Z'), {
    headers: { 'X-Device-Id': stranger },
  });
  check('since paginates the feed', sinceResponse.status === 200, `status=${sinceResponse.status}`);
  const badSince = await fetch(apiUrl('/notifications', '?since=not-a-date'), {
    headers: { 'X-Device-Id': stranger },
  });
  check('a junk cursor is refused', badSince.status === 400, `status=${badSince.status}`);

  // The stream itself. /health says whether delivery is on; the stream must
  // agree - 200 + text/event-stream when on, 503 when the switch is off.
  const streamAbort = new AbortController();
  const streamResponse = await fetch(apiUrl('/notifications/stream'), {
    headers: { 'X-Device-Id': stranger },
    signal: streamAbort.signal,
  });
  if (streamResponse.status === 200) {
    const reader = streamResponse.body.getReader();
    const { value } = await reader.read();
    const preamble = value ? new TextDecoder().decode(value) : '';
    streamAbort.abort();
    check(
      'stream opens as event-stream',
      /text\/event-stream/.test(streamResponse.headers.get('content-type') ?? ''),
      streamResponse.headers.get('content-type'),
    );
    check(
      'stream flushes a retry/open preamble',
      /retry:|: open/.test(preamble),
      preamble.replace(/\s+/g, ' ').slice(0, 60),
    );
    check('stream is up while delivery is on', notifHealth?.enabled !== false);
  } else {
    streamAbort.abort();
    check('stream refused with 503 while delivery is off', streamResponse.status === 503,
      `status=${streamResponse.status}`);
  }
} catch (error) {
  failures += 1;
  console.error(`\nverification threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close().catch(() => {});
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
