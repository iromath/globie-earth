# Runtime evidence — Globie Earth MCP server

The MCP plan (§20 risk table) names **"MCP named in README but never called"** as
an explicit disqualifier and asks for *"a transcript/log in the repo as
evidence"*. The plan's §14 definition of done asks for proof that a real MCP
client connects over Streamable HTTP, lists the tools, and **calls them**.

This file is that evidence: three transcripts, captured verbatim — the **official
MCP SDK client** (`scripts/verify.mjs`), the **browser MCP host**
(`infra/mcp-client/`), and the **simulated Alexa+ host**
(`scripts/simulate-alexa-plus.mjs`). None is a curl imitation; all speak the real
protocol. Nothing here is reconstructed or tidied — where a check is skipped or a
proxy is down, the transcript says so.

> **Note (2026-10-15):** These three transcripts were captured against a build
> that advertised **15 Globie tools**. On 2026-10-15 the server gained **36
> Openmind.Travel `om_*` tools** (tours, destinations, flights, guides,
> community, trip planning, impact), bringing the live surface to **51 tools**.
> The transcripts below are historical and intentionally unchanged — they prove
> the MCP handshake, protocol negotiation and tool-call mechanics. The live
> `tools/list` at `https://mcp.globie.earth/mcp` now returns 51 tools; see
> `README.md` §"Openmind Travel tools" for the catalogue.

## The run

| | |
| --- | --- |
| Captured (UTC) | `2026-10-14T21:24Z` (local `2026-10-15`, Asia/Bangkok) |
| Working tree | `034a1e1` |
| Server | `globie-mcp-1` — image `sha256:b01d6ce7f3b7521add96787226d97754f47d5fc3170bbdbe709bfc39f5dea7ed` |
| Endpoint | `http://localhost:8092/mcp` (compose maps loopback `8092` → container `8080`) |
| Protocol | `2025-11-25` (pinned) |
| Embedding provider | `local` — `Xenova/multilingual-e5-small`, 384 dims |
| Cookbook | `api.cookbook_recipes` — 25 recipes imported, 25 embedded into the shared space |
| Docker | 29.5.3 · Compose 5.1.4 |
| Node | v22.16.0 |

The stack was brought up credential-free: `db`, `rest`, `minio`, `mcp` and
`mcp-client`. The `speech`, `studio` and `podcast` services were **not** started,
so the two podcast tools and the soundscape tools answer with their own
self-explaining error — which the verifier explicitly accepts (checks 9 and 9b
below assert exactly that) — and the browser host's read-aloud reports the speech
service unreachable rather than failing the call. No AWS, DeepSeek, Podcast Index
or Gemini credential was used; the local embedding model ran in-process.

The cookbook layer was applied to the same run: `schema/254_cookbook.sql` against
the local `db`, the book imported (`25 row(s) upserted`), its 25 passages embedded,
and `rest` restarted so PostgREST re-read the schema cache and exposed
`api.cookbook_recipes` plus the widened 4-argument `api.catalog_search`. That is
what makes check **7b** below a live call rather than a registration.

### Reproduce it

```bash
# infra/.env must exist (see infra/.env.example); PGRST_JWT_SECRET and
# PGRST_CORS_ORIGINS are hard-required by compose.
cd infra
docker compose up -d --no-deps db rest minio
docker compose up -d --no-deps --build mcp mcp-client

# The cookbook layer: the schema, then the book, then its vectors.
psql 'postgres://globietree:globietree@localhost:5434/globietree' -f schema/254_cookbook.sql
docker compose restart rest          # reload PostgREST's schema cache
cd mcp
npm run build
export DATABASE_URL='postgres://globietree:globietree@localhost:5434/globietree'
npm run import:cookbook
npm run backfill:embeddings -- recipe

MCP_URL=http://localhost:8092/mcp node scripts/verify.mjs      # transcript 1
# open http://localhost:8082/ and click Connect                  # transcript 2

# The Alexa+ host path (transcript 3): give the local mcp the demo bearer, then
# run the simulated host - once with the real token, once with a wrong one.
cd ..                                                          # back to infra
MCP_BEARER_TOKEN='globie-demo-bearer-2026' \
  MCP_DEMO_DEVICE_ID='00000000-0000-4000-8000-000000000001' \
  docker compose up -d --no-deps mcp
cd mcp
MCP_URL=http://localhost:8092/mcp MCP_BEARER_TOKEN='globie-demo-bearer-2026' \
  node scripts/simulate-alexa-plus.mjs                         # 3a - accepted
MCP_URL=http://localhost:8092/mcp node scripts/simulate-alexa-plus.mjs --negative  # 3b - refused
```

## Transcript 1 — the official SDK client (`scripts/verify.mjs`)

Run as `MCP_URL=http://localhost:8092/mcp node scripts/verify.mjs`. Exit code
**0**. The client is the MCP SDK's own `Client` over `StreamableHTTPClientTransport`,
so this is a genuine host handshake, not a hand-rolled HTTP call.

```
Connecting to http://localhost:8092/mcp as 00000000-0000-4000-8000-000000000001

1. initialize
  [PASS] handshake completed - server=globie-earth@1.0.0
  [PASS] server advertises tools capability - protocol=2025-11-25

2. tools/list
  [PASS] returns every registered tool - search_forest_knowledge, recommend_species, search_local_culture, get_recipe, get_sanctuary_conditions, describe_species, describe_photo, adopt_species, get_my_deeds, get_eco_balance, generate_soundscape, get_soundscape, search_podcasts, get_trending_podcasts, get_podcasts_by_theme
  [PASS] adopt_species is marked mutating
  [PASS] generate_soundscape is marked mutating

3. resources/list
  [PASS] exposes the catalogue templates - globie://species/{id}, globie://guardian/{id}, globie://site/{id}, globie://dnp/{id}, globie://dnp-plant/{id}, globie://dnp-fauna/{id}, globie://dnp-wildlife/{id}
  [PASS] lists the static me/deeds resource - me/deeds, Kae Na, Yang Na, The Mother Tree, The Father Tree, Bamboo Rhizome Sovereign, Stop 1: Wetland Basin & Retention Dykes, Stop 2: The Ancestral Creek, Stop 3: Bio-Swale Nursery & Seed Bank, Stop 4: Sacred Yang Na Oleoresin Grove
  [PASS] expanded a species instance from the live catalogue - globie://species/kae-na

4. resources/read globie://species/kae-na
  [PASS] returned content
  [PASS] payload is a species - Kae Na

5. prompts
  [PASS] lists both prompts - forest-guide, adopt-a-tree
  [PASS] forest-guide returns instructions
  [PASS] forest-guide mentions the focus

6. tools/call get_sanctuary_conditions
  [PASS] returned content
  [PASS] payload names its source - Open-Meteo modelled fields (not an on-site sensor)
  [PASS] never claims more than modelled fields

7. tools/call search_forest_knowledge
  [PASS] returned content
  [PASS] search answers without error - provider=local - { "query": "which tree fixes paddy soil", "entityType": null, "method": "semantic", "embeddingModel": "Xenova/multilingu
  [PASS] search labels its method
  [PASS] semantic answer carries an embedding model
        semantic result: { "query": "which tree fixes paddy soil", "entityType": null, "method": "semantic", "embeddingModel": "Xenova/multilingual-e5-small", "ranki

7b. tools/call search_local_culture / get_recipe
  [PASS] search_local_culture returned content
  [PASS] search_local_culture answers without error - method=semantic - { "query": "how do I make green curry", "method": "semantic", "embeddingModel": "Xenova/multilingual-e5-small", "ranking
  [PASS] search_local_culture labels its method
  [PASS] search_local_culture carries a hit list - count=8
  [PASS] a hit names its recipe entity - Green Curry with Chicken (Gaeng Keow Wan Gai)
  [PASS] get_recipe returned content
  [PASS] get_recipe answers without error - Green Curry with Chicken (Gaeng Keow Wan Gai)
  [PASS] get_recipe carries the full ingredients list - ingredients=11
  [PASS] get_recipe carries the method - steps=7
  [PASS] get_recipe names its source - Openmind Projects — Cookbook Version Kai & Shea

8. tools/call get_my_deeds
  [PASS] returned content
  [PASS] payload carries a deed list - count=0

9. tools/call search_podcasts
  [PASS] returned content
  [PASS] tool error explains itself
        tool error: Could not reach the podcast service: fetch failed

9b. tools/call get_podcasts_by_theme
  [PASS] returned content
  [PASS] tool error explains itself
  [PASS] returned content
  [PASS] tool error explains itself
        tool error: Could not reach the podcast service: fetch failed

10. notifications
  [PASS] health reports the notification switch - {"enabled":true,"stream":true,"push":false,"dispatcher":{"configured":false,"running":false,"tokenExpiresAt":null}}
  [PASS] health reports a dispatcher state
  [PASS] feed answers for a stranger - status=200
  [PASS] a stranger owns no alerts - count=0
  [PASS] the feed lends the client a clock
  [PASS] since paginates the feed - status=200
  [PASS] a junk cursor is refused - status=400
  [PASS] stream opens as event-stream - text/event-stream; charset=utf-8
  [PASS] stream flushes a retry/open preamble - retry: 3000 : open
  [PASS] stream is up while delivery is on

11. MCP OAuth 2.1 discovery
  [PASS] serves the protected-resource metadata - status=200
  [PASS] PRM names an authorization server - ["https://localhost:8092"]
  [PASS] PRM points at /mcp - https://localhost:8092/mcp
  [PASS] serves the authorization-server metadata - status=200
  [PASS] advertises the token endpoint - https://localhost:8092/oauth/token
  [PASS] advertises PKCE S256 (mandatory) - ["S256"]
  [PASS] supports both grant types - ["client_credentials","authorization_code"]
        (skipped token mint: set MCP_OAUTH_CLIENT_ID / MCP_OAUTH_CLIENT_SECRET to exercise it)

All checks passed.
```

## Transcript 2 — the browser MCP host (`infra/mcp-client/`)

The demo client at `http://localhost:8082/` is a real MCP host: it drives the
official SDK's `Client` in the browser, so the handshake and the call below are
the same code path an Alexa+ host uses. This is the client's own **Transcript**
tab, read back after clicking **Connect** and then calling `search_local_culture` from
its form (the form is built from the JSON Schema the server returned, not
hard-coded).

```
21:24:03  • connect  Opening http://localhost:8092/mcp as device 7ced10b5-953f-431c-bf19-4f976496c8a9.
21:24:03  ← initialize  globie-earth@1.0.0, protocol 2025-11-25, capabilities: prompts, resources, tools.
21:24:04  ← tools/list  15 tool(s): search_forest_knowledge, recommend_species, search_local_culture, get_recipe, get_sanctuary_conditions, describe_species, describe_photo, adopt_species, get_my_deeds, get_eco_balance, generate_soundscape, get_soundscape, search_podcasts, get_trending_podcasts, get_podcasts_by_theme
21:24:04  ← prompts/list  2 prompt(s): forest-guide, adopt-a-tree
21:24:04  ← resources/list  10 resource(s) and 7 template(s).
21:24:14  → tools/call  search_local_culture {"query":"how do I make green curry"}
21:24:14  ← tools/call  search_local_culture → ok: { "query": "how do I make green curry", "method": "semantic", "embeddingModel": "Xenova/multilingual-e5-small", "ranking": "cosine", "rerank…
```

The Handshake panel reported session `858b6e76-a37d-4317-84e3-df1472b7faa1`,
server `globie-earth@1.0.0`, protocol `2025-11-25`, capabilities
`prompts, resources, tools`. The read-aloud step was the only thing that failed —
`reading it aloud failed: The speech service could not be reached at
http://speech:8000` — because `speech` was deliberately not started; the tool call
itself returned `ok`.

## Transcript 3 — the simulated Alexa+ host (`scripts/simulate-alexa-plus.mjs`)

Captured after the two runs above, against the same local server but with the demo
bearer enabled (`MCP_BEARER_TOKEN` set; `MCP_DEMO_DEVICE_ID` =
`00000000-0000-4000-8000-000000000001`). This host presents **only**
`Authorization: Bearer …` and **no** `X-Device-Id`, so a successful run proves the
server exchanged the bearer for the demo device *at the MCP edge* (decision D4) —
the identity path an Alexa+ host uses. It also rewrites the single
`protocolVersion` field of the SDK's `initialize` to `2025-03-26`, the version the
Alexa+ client advertises, to show the server **down-negotiating** to it instead of
rejecting it.

### 3a — the real token is accepted (exit 0)

```
Simulated Alexa+ style host - static bearer exchange (NOT OAuth 2.1)
   target  http://localhost:8092/mcp
   sends   Authorization: Bearer globie-d…   (no X-Device-Id)

0. health (unauthenticated)
   health  200  auth={"staticBearer":true,"demoDevice":true}

1. initialize
   ← globie-earth@1.0.0, protocol 2025-03-26
   protocol  advertised 2025-03-26 → negotiated 2025-03-26
   capabilities: prompts, resources, tools

2. tools/list
   ← 15 tool(s): search_forest_knowledge, recommend_species, search_local_culture, get_recipe, get_sanctuary_conditions, describe_species, describe_photo, adopt_species, get_my_deeds, get_eco_balance, generate_soundscape, get_soundscape, search_podcasts, get_trending_podcasts, get_podcasts_by_theme

3. tools/call get_my_deeds  (which identity did the token resolve to?)
   ← { "count": 0, "deeds": [], "note": "This device has not adopted anything yet." }

4. tools/call get_sanctuary_conditions  (a live read)
   ← { "carbonDioxidePpm": 459, "europeanAqi": 23, "humidityPct": 88, "temperatureC": 24.7, "observedAt": "2026-10-14T21:00", "aqiLabel": "Fair", "coordinate": { "latitude": 16.482, "longitude": 102.819 },

Accepted with Authorization only - the static bearer was exchanged for the demo device at the MCP edge.
Reminder: a shared demo secret, not MCP OAuth 2.1.
```

Step 3 is the proof of the edge exchange: the host never sent a device id, yet
`get_my_deeds` answered as a device ("This device has not adopted anything yet")
rather than being refused — the bearer resolved to `MCP_DEMO_DEVICE_ID`.

### 3b — a wrong token is refused (exit 0)

```
Simulated Alexa+ style host - static bearer exchange (NOT OAuth 2.1)
   target  http://localhost:8092/mcp
   sends   Authorization: Bearer wrong-00…   (no X-Device-Id)
   mode    NEGATIVE - this token must be refused

0. health (unauthenticated)
   health  200  auth={"staticBearer":true,"demoDevice":true}

1. initialize

   ← refused as expected: Streamable HTTP error: Error POSTing to endpoint: {"error":"This MCP server needs a caller identity: a valid X-Device-Id header, an MCP OAuth 2.1 access token, or Authorization: Bearer <MCP_BEARER_TOKEN> when a demo device id is configured. See infra/mcp/README.md."}

A wrong token was refused, so the credential is enforced.
```

## The server's own account of itself — `GET /health`

Same process, same run:

```json
{
  "ok": true,
  "protocolVersion": "2025-11-25",
  "embedding": { "provider": "local", "model": "Xenova/multilingual-e5-small", "dims": 384 },
  "router": { "configured": false, "model": "deepseek-flash" },
  "speech": { "configured": true, "ttsProvider": "speaches" },
  "contribute": { "configured": false, "storage": { "configured": true, "bucket": "globie-media" } },
  "notifications": { "enabled": true, "stream": true, "push": false, "dispatcher": { "configured": false, "running": false, "tokenExpiresAt": null } },
  "postgrest": { "configured": true },
  "proxies": { "studio": true, "podcast": true },
  "auth": { "staticBearer": false, "demoDevice": false },
  "oauth": { "configured": false, "client": false, "redirectUris": 0, "userDevice": false, "issuer": null }
}
```

This is the main run's shape, where the demo bearer is **off**
(`auth.staticBearer: false`). In the Alexa+ run (transcript 3) the same endpoint
reported `auth: {"staticBearer":true,"demoDevice":true}` — the switch the simulator
exercised.

## What this proves — and what it does not

**Proves.** A real MCP client, over Streamable HTTP and the pinned `2025-11-25`
protocol, completes `initialize`, enumerates `tools/list` (all 15 tools, with the
two mutating hints), `resources/list` + `resources/read`, `prompts/list`, and
round-trips live `tools/call`s — including a **semantic** search whose payload
carries the embedding model that produced the ranking (`method: "semantic"`,
`embeddingModel: "Xenova/multilingual-e5-small"`) and a **cookbook** round trip
that goes from `search_local_culture` ("how do I make green curry" → *Green Curry with
Chicken (Gaeng Keow Wan Gai)*) to `get_recipe` reading the whole dish back (11
ingredients, 7 steps, source *Openmind Projects — Cookbook Version Kai & Shea*).
The OAuth 2.1 discovery documents are served. A **simulated Alexa+ host** — sending
only `Authorization: Bearer`, no device id — is accepted after the server
down-negotiates the protocol to the client's advertised `2025-03-26`, and the same
host with a **wrong** token is refused. All of it runs with no third-party
credential.

**Does not prove, and is not claimed.** This is a **local** run on a Docker VM —
it is not the deployed `https://mcp.globie.earth`. The two podcast tools and the
soundscape tools returned their *explaining* error here because their upstream
proxies were deliberately not started, and the browser host's read-aloud reported
the speech service unreachable; the verifier accepts that as a pass, and it is
recorded here rather than hidden. The OAuth token mint (check 11b) was skipped for
want of a registered client. The deployed image, the Titan/Bedrock embedding path
and the `< 3-minute` demo video are separate, credential-gated steps — see
`DEVPOST-SUBMISSION.md` §9 and `PRODUCT-FEEDBACK.md`.
