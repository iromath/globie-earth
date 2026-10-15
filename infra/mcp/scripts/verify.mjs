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

import { readFile } from 'node:fs/promises';

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
  'get_soundscape',
  'search_podcasts',
  'get_trending_podcasts',
  'get_podcasts_by_theme',
  // Phase 4 - the sanctuary's own Local Culture / Thai cookbook (src/tools/cookbook.ts).
  'search_local_culture',
  'get_recipe',
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

/**
 * Calls a tool that must be refused, and asserts the refusal is legible.
 *
 * Amazon's guide asks for tools to be called with invalid input during isolated
 * testing, and for failures to be structured enough that a host can ask a
 * specific follow-up. Two refusals are therefore acceptable: a JSON-RPC
 * InvalidParams error (a schema violation, which the SDK raises before the
 * handler runs) and an `isError` tool result (a semantic failure the tool
 * explains itself). What must never happen is a silent success or a crash.
 */
async function expectRefusal(label, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result?.isError) {
      check(label, firstText(result).length > 0, `tool error: ${firstText(result).replace(/\s+/g, ' ').slice(0, 80)}`);
    } else {
      check(label, false, 'the server accepted invalid input without an error');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, /invalid|error|not found|unknown/i.test(message), message.replace(/\s+/g, ' ').slice(0, 110));
  }
}

/**
 * Every icon and image the add-on manifest points at must be an image.
 *
 * The web host answers an unknown path with the SPA shell at HTTP 200, so a
 * missing asset and a present one share a status code: only the content type
 * tells them apart. The set is read from addon.json rather than hard-coded, so
 * a URI edited there is checked here, and this runs after the MCP session so it
 * still reports when the server is unreachable.
 */
async function checkAddonAssets() {
  console.log('\n14. add-on store assets');
  const manifestPath = new URL('../addon-package/addon.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const uris = [];
  for (const locale of Object.values(manifest.storeListing?.locales ?? {})) {
    const media = locale.mediaAssets ?? {};
    for (const icon of media.icons?.light ?? []) uris.push(icon.uri);
    for (const icon of media.icons?.dark ?? []) uris.push(icon.uri);
    for (const image of media.carouselImages ?? []) uris.push(image.uri);
    for (const image of media.bannerImages ?? []) uris.push(image.uri);
  }

  for (const uri of uris) {
    try {
      const response = await fetch(uri);
      const type = response.headers.get('content-type') ?? '';
      check(
        `${uri} is an image`,
        response.ok && /^image\//.test(type),
        `status=${response.status} type=${type || '(none)'}`,
      );
    } catch (error) {
      check(`${uri} is an image`, false, error instanceof Error ? error.message : String(error));
    }
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

  // 7b. tools/call on the Local Culture tools (src/tools/cookbook.ts).
  //     search_local_culture reads the shared embedding space narrowed to
  //     entity_type 'recipe', and get_recipe reads the whole dish back through
  //     PostgREST. Both are read-only. Like step 7, the answer depends on the
  //     server's embedding configuration, so the assertions require only that a
  //     returned hit can be opened in full - not that any particular dish exists.
  console.log('\n7b. tools/call search_local_culture / get_recipe');
  const recipes = await client.callTool({
    name: 'search_local_culture',
    arguments: { query: 'how do I make green curry' },
  });
  const recipesText = firstText(recipes);
  const recipesJson = firstJson(recipes);
  check('search_local_culture returned content', recipesText.length > 0);
  check(
    'search_local_culture answers without error',
    !recipes.isError,
    `method=${recipesJson?.method ?? '?'} - ${recipesText.replace(/\s+/g, ' ').slice(0, 120)}`,
  );
  if (!recipes.isError) {
    check(
      'search_local_culture labels its method',
      recipesJson?.method === 'semantic' || recipesJson?.method === 'keyword',
    );
    check(
      'search_local_culture carries a hit list',
      Array.isArray(recipesJson?.hits),
      `count=${recipesJson?.hits?.length}`,
    );
    const hit = Array.isArray(recipesJson?.hits) ? recipesJson.hits[0] : undefined;
    check('a hit names its recipe entity', hit?.entityType === 'recipe', hit?.title);
    if (hit?.entityId) {
      const recipe = await client.callTool({
        name: 'get_recipe',
        arguments: { recipe: String(hit.entityId) },
      });
      const recipeText = firstText(recipe);
      const recipeJson = firstJson(recipe);
      check('get_recipe returned content', recipeText.length > 0);
      check(
        'get_recipe answers without error',
        !recipe.isError,
        recipeJson?.nameEn ?? recipeText.replace(/\s+/g, ' ').slice(0, 100),
      );
      if (!recipe.isError) {
        check(
          'get_recipe carries the full ingredients list',
          Array.isArray(recipeJson?.ingredients),
          `ingredients=${recipeJson?.ingredients?.length}`,
        );
        check('get_recipe carries the method', Array.isArray(recipeJson?.steps), `steps=${recipeJson?.steps?.length}`);
        check('get_recipe names its source', typeof recipeJson?.source === 'string', recipeJson?.source);
      }
    } else {
      console.log('        (the cookbook holds no recipes on this server, so get_recipe was not exercised)');
    }
  }

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

  // 9b. tools/call on the theme tool. Called with no theme it lists the themes;
  //     called with one it returns that theme's shows. Same proxy dependency as
  //     step 9, so an explaining tool error is again acceptable.
  console.log('\n9b. tools/call get_podcasts_by_theme');
  const themeList = await client.callTool({ name: 'get_podcasts_by_theme', arguments: {} });
  const themeListText = firstText(themeList);
  check('returned content', themeListText.length > 0);
  if (themeList.isError) {
    check('tool error explains itself', !/unknown reason/i.test(themeListText));
  } else {
    const parsed = firstJson(themeList);
    check('payload carries a theme list', Array.isArray(parsed?.themes), `count=${parsed?.count}`);
  }
  const themed = await client.callTool({
    name: 'get_podcasts_by_theme',
    arguments: { theme: 'meditation' },
  });
  const themedText = firstText(themed);
  check('returned content', themedText.length > 0);
  if (themed.isError) {
    check('tool error explains itself', !/unknown reason/i.test(themedText));
  } else {
    const parsed = firstJson(themed);
    check('payload carries a feed list', Array.isArray(parsed?.feeds), `count=${parsed?.count}`);
  }
  console.log(
    `        ${themed.isError ? 'tool error' : 'result'}: ${themedText.replace(/\s+/g, ' ').slice(0, 160)}`,
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

  // 11. MCP OAuth 2.1 discovery (src/oauth.ts). Alexa+ reads these two documents
  //     before it will register the add-on, so they must be reachable and must
  //     advertise S256. The token surface itself is only exercised when a client
  //     secret is in scope - discovery is public, minting is not.
  console.log('\n11. MCP OAuth 2.1 discovery');
  const prmResponse = await fetch(apiUrl('/.well-known/oauth-protected-resource'));
  const prm = prmResponse.ok ? await prmResponse.json() : null;
  check('serves the protected-resource metadata', prmResponse.status === 200, `status=${prmResponse.status}`);
  check('PRM names an authorization server', Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length > 0,
    JSON.stringify(prm?.authorization_servers));
  check('PRM points at /mcp', typeof prm?.resource === 'string' && /\/mcp$/.test(prm.resource), prm?.resource);

  const asResponse = await fetch(apiUrl('/.well-known/oauth-authorization-server'));
  const asMeta = asResponse.ok ? await asResponse.json() : null;
  check('serves the authorization-server metadata', asResponse.status === 200, `status=${asResponse.status}`);
  check('advertises the token endpoint', typeof asMeta?.token_endpoint === 'string', asMeta?.token_endpoint);
  check(
    'advertises PKCE S256 (mandatory)',
    Array.isArray(asMeta?.code_challenge_methods_supported) && asMeta.code_challenge_methods_supported.includes('S256'),
    JSON.stringify(asMeta?.code_challenge_methods_supported),
  );
  check(
    'supports both grant types',
    ['client_credentials', 'authorization_code'].every((gt) => asMeta?.grant_types_supported?.includes(gt)),
    JSON.stringify(asMeta?.grant_types_supported),
  );

  const clientId = process.env.MCP_OAUTH_CLIENT_ID ?? '';
  const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET ?? '';
  if (clientId && clientSecret) {
    console.log('\n11b. Tier 1 client_credentials token is accepted by /mcp');
    const tokenResponse = await fetch(apiUrl('/oauth/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    const tokenBody = tokenResponse.ok ? await tokenResponse.json() : null;
    check('token endpoint issues a bearer token', typeof tokenBody?.access_token === 'string', `status=${tokenResponse.status}`);
    check('token carries the service scope', tokenBody?.scope === 'mcp:service', tokenBody?.scope);
    check('token has no refresh token', tokenBody?.refresh_token === undefined);
    if (typeof tokenBody?.access_token === 'string') {
      const oauthTransport = new StreamableHTTPClientTransport(new URL(URL_STRING), {
        requestInit: { headers: { Authorization: `Bearer ${tokenBody.access_token}` } },
      });
      const oauthClient = new Client({ name: 'globie-mcp-oauth-verify', version: '1.0.0' });
      try {
        await oauthClient.connect(oauthTransport);
        const { tools: oauthTools } = await oauthClient.listTools();
        check('an OAuth token completes the handshake and lists tools', oauthTools.length === EXPECTED_TOOLS.length,
          `${oauthTools.length} tool(s)`);
      } finally {
        await oauthClient.close().catch(() => {});
      }
    }
  } else {
    console.log('        (skipped token mint: set MCP_OAUTH_CLIENT_ID / MCP_OAUTH_CLIENT_SECRET to exercise it)');
  }

  // 12. Invalid input. The guide's isolated-testing step asks for tools to be
  //     called with invalid input, and its tool-design step asks for failures
  //     to be structured - enough for a host to ask a specific follow-up. Every
  //     case below must be refused with an explanation: a schema violation (the
  //     SDK raises InvalidParams before the handler runs) or a tool-level error
  //     the tool writes itself. Silence, a crash or a bogus success all fail.
  //     Nothing here can change state: adopt_species is refused on its range,
  //     which is checked before its handler is reached.
  console.log('\n12. invalid input');
  await expectRefusal('search_local_culture refuses a missing query', 'search_local_culture', {});
  await expectRefusal('get_recipe refuses a missing recipe', 'get_recipe', {});
  await expectRefusal(
    'search_forest_knowledge refuses an unknown entity_type',
    'search_forest_knowledge',
    { query: 'teak', entity_type: 'not-a-real-entity' },
  );
  await expectRefusal(
    'adopt_species refuses an out-of-range quantity before it writes',
    'adopt_species',
    { species_id: 'kae-na', quantity: 0 },
  );
  await expectRefusal('the surface refuses an unknown tool', 'no_such_tool', {});

  // A valid-schema call whose dish simply does not exist: the tool must explain
  // itself and point at the recovery, rather than reporting a protocol error a
  // host could only surface as "something went wrong".
  const unknownDish = await client.callTool({
    name: 'get_recipe',
    arguments: { recipe: 'zzz not a dish in this book' },
  });
  check('get_recipe refuses an unknown dish', unknownDish.isError === true);
  check(
    'and tells the caller how to recover',
    /search_local_culture/i.test(firstText(unknownDish)),
    firstText(unknownDish).replace(/\s+/g, ' ').slice(0, 110),
  );

  // 13. MCP Apps UI (SEP-1865). Every tool names a `ui://` resource a host
  //     mounts in a sandboxed iframe. Four archetype documents serve all
  //     fifteen tools (src/ui/apps.ts), so this asserts: each document is
  //     discoverable and reads as an MCP App (text/html;profile=mcp-app),
  //     every tool declares _meta.ui.resourceUri pointing at one of them, and
  //     a call returns the rich shape so a host without the extension still
  //     gets the JSON text block.
  console.log('\n13. MCP Apps UI (SEP-1865)');
  const uiResources = resources.resources.filter(
    (entry) => typeof entry.uri === 'string' && entry.uri.startsWith('ui://'),
  );
  const ARCHETYPE_SLUGS = ['card', 'list', 'carousel', 'map'];
  for (const slug of ARCHETYPE_SLUGS) {
    const entry = uiResources.find((resource) => resource.uri.startsWith(`ui://globie/${slug}-`));
    check(`resources/list advertises the ${slug} App`, Boolean(entry), entry?.uri);
    check(
      `the ${slug} App is served as text/html;profile=mcp-app`,
      entry?.mimeType === 'text/html;profile=mcp-app',
      entry?.mimeType,
    );
  }

  // Every tool must point at a document that was actually listed: a dangling
  // resourceUri is a broken App, not a fallback.
  const advertisedUris = new Set(uiResources.map((entry) => entry.uri));
  const UI_WIRED_TOOLS = [
    'describe_species', 'describe_photo', 'get_recipe', 'get_eco_balance',
    'adopt_species', 'generate_soundscape', 'get_soundscape',
    'search_forest_knowledge', 'search_local_culture', 'recommend_species',
    'get_my_deeds', 'search_podcasts', 'get_trending_podcasts',
    'get_podcasts_by_theme', 'get_sanctuary_conditions',
  ];
  for (const name of UI_WIRED_TOOLS) {
    const tool = tools.find((entry) => entry.name === name);
    const uri = tool?._meta?.ui?.resourceUri;
    check(
      `${name} declares an advertised _meta.ui.resourceUri`,
      typeof uri === 'string' && advertisedUris.has(uri),
      uri ?? '(none)',
    );
  }

  // One document read in full: the bytes must be a valid HTML5 page and the
  // read content item must repeat the ui metadata the list entry declared.
  const cardResource = uiResources.find((entry) => entry.uri.startsWith('ui://globie/card-'));
  if (cardResource) {
    const uiRead = await client.readResource({ uri: cardResource.uri });
    const uiEntry = Array.isArray(uiRead?.contents) ? uiRead.contents[0] : undefined;
    check(
      'resources/read returns the App as text/html;profile=mcp-app',
      uiEntry?.mimeType === 'text/html;profile=mcp-app',
      uiEntry?.mimeType,
    );
    check(
      'the document is a valid HTML5 page',
      typeof uiEntry?.text === 'string' &&
        /^\s*<!doctype html>/i.test(uiEntry.text) &&
        /<html[\s>]/i.test(uiEntry.text),
      typeof uiEntry?.text === 'string' ? `${uiEntry.text.length} bytes` : '(no text)',
    );
    check(
      'the read content item repeats the ui metadata',
      uiEntry?._meta?.ui?.prefersBorder === true,
      JSON.stringify(uiEntry?._meta?.ui),
    );
  }

  // The conditions call (made earlier) must carry the rich shape too.
  const conditionsTool = tools.find((tool) => tool.name === 'get_sanctuary_conditions');
  const conditionsUri = conditionsTool?._meta?.ui?.resourceUri;
  if (!conditions.isError) {
    check(
      'a rich call carries structuredContent',
      conditions.structuredContent !== undefined && typeof conditions.structuredContent === 'object',
      typeof conditions.structuredContent,
    );
    check(
      'and points at the same ui:// resource',
      conditions._meta?.ui?.resourceUri === conditionsUri,
      conditions._meta?.ui?.resourceUri,
    );
  } else {
    console.log('        (skipped rich-result checks: the conditions call errored)');
  }
} catch (error) {
  failures += 1;
  console.error(`\nverification threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close().catch(() => {});
}

await checkAddonAssets();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
