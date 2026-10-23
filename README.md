# Globie Earth — MCP server for Alexa+

A self-hosted **[Model Context Protocol](https://modelcontextprotocol.io) server**
that puts Globie Earth's reforestation backend — and the Openmind.Travel travel
catalogue — in reach of an Alexa+ (or any MCP) host: the living catalogue of
native species, sites and guardian lore, the adoption records, the site's
conditions, a self-hosted voice loop to ask about all of it, and a full travel
surface to search tours, flights, destinations and guides.

This repository **is the Amazon hackathon submission (Alexa+ track)**: the MCP
server and the demo browser MCP client that proves a real MCP host can drive it.

- **Transport:** MCP Streamable HTTP at `POST /mcp` (`GET` for the optional
  server-to-client stream, `DELETE` to end a session).
- **Protocol version:** `2025-11-25`, **pinned**. The server refuses to boot if
  the SDK's newest supported version ever moves past it, so this line cannot
  quietly become false.
- **Surface:** 55 tools (19 Globie Earth + 36 Openmind.Travel) · 8 resources
  (7 URI templates + 1 static) · 2 prompts, plus 8 browser side-routes and a
  `GET /health`.
- **Runs at:** `https://mcp.globie.earth`; the demo client at
  `https://mcp-client.globie.earth`.
- **Backend:** Fastify + TypeScript on Node 22, self-hosted on an Easypanel
  stack. Every byte of data comes over the live HTTP APIs (PostgREST, studio,
  podcast, and the Openmind.Travel catalogue) — there is no local database and
  nothing seeded.

Full detail — every tool's backend, the router, the voice cascade, the
contribution pipeline, and the honest note on what the demo auth is *not* — lives
in [`infra/mcp/README.md`](infra/mcp/README.md).

---

## Quick start

One command brings up the MCP server and the demo client. No `.env` is required:
the four data origins default to the live Globie Earth and Openmind.Travel APIs.

```bash
cd infra
docker compose up -d --build

# The MCP endpoint (loopback; the live server fronts this at mcp.globie.earth)
curl -s http://localhost:8092/health | jq
```

Then open the demo client at **http://localhost:8082** — a real browser MCP host.
It connects to the server, lists its tools, and can drive them by hand or by
voice.

To talk to the server directly, the demo accepts a static bearer token (a shared
demo secret, bounded to one device — see [Auth](#authentication-and-what-it-honestly-is-not)).
It is the value of `MCP_BEARER_TOKEN` in [`infra/.env.example`](infra/.env.example):

```bash
curl -s https://mcp.globie.earth/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer b8478ae4723f41d7f4e14a4fd8ac5f301be3cace3c100be8ce6d218ba75486bc' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## MCP surface

### Tools (55)

The surface is split into two groups: 19 **Globie Earth** tools (the site's
catalogue, deeds, soundscapes, podcasts and live web search) and 36
**Openmind.Travel** tools (`om_*` prefix) covering tours, flights, destinations,
guides, community, trip planning and impact. Three Globie tools change state
(`adopt_species`, `generate_soundscape`, `publish_soundscape`), as do the two
`om_save_*` trip tools; the rest are read-only.

#### Globie Earth (19)

| Tool | What it does |
| --- | --- |
| `search_forest_knowledge` | Search species, sites, guardian lore and the four DNP forest datasets — semantic by default, keyword fallback |
| `search_local_culture` | Search the Thai cookbook collection by dish, ingredient, region or category |
| `get_recipe` | One full recipe: names, region, ingredients, method and tips |
| `recommend_species` | Recommend species from the caller's own past adoptions |
| `get_sanctuary_conditions` | Ambient CO₂, European AQI, humidity and air temperature |
| `describe_photo` | Describe an attached photo with a vision model (DeepSeek or Amazon Bedrock Nova) |
| `describe_species` | The English Wikipedia lead section for a species, by name |
| `adopt_species` | Record an adoption (mutating; idempotent with a store transaction id) |
| `get_my_deeds` | The Living Deeds issued for this caller's adoptions |
| `get_eco_balance` | This caller's eco-token balance |
| `generate_soundscape` | Queue a generated piece of music for the site (mutating) |
| `get_soundscape` | Check a queued soundscape and return its audio URL when ready |
| `publish_soundscape` | Publish a finished soundscape to the public library (mutating) |
| `search_web` | Live web search for anything the site's own records do not hold |
| `search_podcasts` | Search the podcast library for shows about the living world |
| `get_trending_podcasts` | List trending shows, optionally by category |
| `get_podcasts_by_theme` | List listening themes, or the shows matching one theme |
| `get_podcast_episodes` | List a show's episodes, each with its audio file URL and cover art |
| `get_podcast_stream_url` | Mint a signed proxy-stream URL for an episode (for publishers that block hotlinking) |

#### Openmind.Travel (36, `om_*` prefix)

Wraps the Openmind.Travel REST catalogue (`https://bokunapi.9o9.io`). Full detail
in [`infra/mcp/README.md`](infra/mcp/README.md#openmind-travel-tools-om_).

| Group | Tools |
| --- | --- |
| **Tours** | `om_search_tours`, `om_get_tour_facets`, `om_get_tour`, `om_list_volunteer_projects`, `om_get_partner`, `om_search_suggestions` |
| **Destinations** | `om_search_destinations`, `om_list_categories`, `om_list_countries`, `om_get_popular_destinations`, `om_autocomplete_airport` |
| **Guides** | `om_list_country_guides`, `om_get_country_guide`, `om_search_youtube_videos`, `om_list_airline_guides`, `om_get_airline_guide` |
| **Flights & transport** | `om_search_flights`, `om_get_flight_calendar`, `om_search_transport` |
| **Community** | `om_get_globie_pet`, `om_list_community_posts`, `om_search_community_posts`, `om_get_community_post` |
| **Trips** | `om_plan_trip`, `om_list_trip_ideas`, `om_get_trip_idea`, `om_save_trip_idea`, `om_get_itinerary`, `om_save_itinerary` |
| **Impact** | `om_get_impact_overview`, `om_list_impact_causes`, `om_get_impact_cause`, `om_get_impact_travel_options`, `om_list_impact_treasures`, `om_get_impact_treasure`, `om_get_impact_stories` |

### Resources (8)

The three catalogue templates and `me/deeds` are listed; the four DNP
reference records are read by the id a search hit already returned (they are far
too large to enumerate). `globie://me/deeds` is device-scoped by row-level
security.

| Resource | What it is |
| --- | --- |
| `globie://species/{id}` | One species, by id |
| `globie://guardian/{id}` | One guardian's lore, by id |
| `globie://site/{id}` | One stop on the trail, by numeric id |
| `globie://dnp/{id}` | One DNP biodiversity survey record, by id (external reference) |
| `globie://dnp-plant/{id}` | One DNP national plant checklist record, by id |
| `globie://dnp-fauna/{id}` | One DNP national-park fauna observation, by id |
| `globie://dnp-wildlife/{id}` | One DNP national wildlife checklist record, by id |
| `globie://me/deeds` | This caller's Living Deeds, device-scoped by RLS |

### Prompts (2)

`forest-guide` — the persona and tool-selection guidance for a voice companion;
`adopt-a-tree` — the guided adoption flow.

### Side-routes

Beside the MCP surface, for the app, the demo client and the Alexa Skill:

| Route | Purpose |
| --- | --- |
| `POST /route` | Turn one natural-language utterance into one tool call |
| `POST /alexa` | Alexa Skill (ASK) webhook — spoken answers over the same 55 tools |
| `GET /wiki` | The Wikipedia lead `describe_species` answers with, as plain HTTP |
| `POST /voice/transcribe` / `POST /voice/speak` | The self-hosted STT/TTS voice loop |
| `POST /contribute` / `DELETE /contribute/:id` | Offer a species photograph for review |
| `GET /moderate/queue` / `POST /moderate/decision` | The human review of those contributions |
| `GET /health` | Protocol version, embedding provider, and what is configured |

Each is documented in [`infra/mcp/README.md`](infra/mcp/README.md).

**An Alexa Skill is a second front door, not a second server.** Alexa+ add-ons
hand our tools to Alexa+'s planner; a Skill is the older product, where the
developer declares intents and Amazon sends back a matched one. `POST /alexa`
carries one catch-all intent into the same router `POST /route` uses and runs the
chosen tool against the same MCP surface in-process, so the two pipelines cannot
disagree about what this server can do. The interaction model and manifest live
in [`infra/mcp/skill-package/`](infra/mcp/skill-package); every intent, sample
utterance and tool-by-tool spoken command is in
[`Dev-Docs/ALEXA-VOICE-COMMANDS.md`](Dev-Docs/ALEXA-VOICE-COMMANDS.md).

---

## How it runs

**API-backed, by design.** The server never connects to a database. It calls
PostgREST over HTTP and forwards the caller's own `X-Device-Id` / `Bearer`
headers, so the identity the row-level-security policies pin rows to is the
caller's, not the server's. A direct migration-role connection would silently
bypass RLS; calling the API is how that is avoided.

```
                     ┌──────────────────────────────┐
   Alexa+ / MCP host │  POST https://mcp.globie.earth│
   browser client ──►│  /mcp  (Streamable HTTP)      │
                     └──────────────┬───────────────┘
   Alexa Skill ─────► POST /alexa ──┘  (same router, same tools, in-process)
                                    │  X-Device-Id / Bearer, forwarded
              ┌─────────────────────┼─────────────────────┬───────────────────┐
              ▼                     ▼                     ▼                   ▼
     api.globie.earth     studio.globie.earth     podcast.globie.earth  bokunapi.9o9.io
     (PostgREST: species, (soundscape)            (podcasts)            (Openmind.Travel
      guardians, sites,                                                    tours, flights,
      deeds, DNP data)                                                      destinations)
```

Only non-browser hosts (Alexa+) send no `Origin`; browser clients are matched
against `MCP_CORS_ORIGINS` literally.

Two feature groups fail **closed and in isolation**, so the server always starts
and reports what is unconfigured on `GET /health`: an unset `SPEECH_URL` disables
only `/voice/*` (they answer a clear `503`), and unset `MINIO_*` disables only
`/contribute`. Neither touches the tools.

### Embeddings — Amazon Bedrock, self-hosted by default

`search_forest_knowledge` embeds the query with a **self-hosted
multilingual-e5-small** model (`Xenova/multilingual-e5-small` through
transformers.js/ONNX, 384 dimensions) running in-process. It needs no account and
bills nothing, so it is the default.

`EMBEDDING_PROVIDER=bedrock` selects **Amazon Titan Text Embeddings V1**
(`amazon.titan-embed-text-v1`, 1536 dimensions) instead — the AWS Builder story,
using the credentials in `infra/.env.example`. If no embedding can be computed,
the tool falls back to a keyword search and labels the answer
`"method": "keyword"`, naming the reason. It never reports a similarity it did
not compute. See [`infra/mcp/README.md`](infra/mcp/README.md#embeddings).

---

## Authentication, and what it honestly is not

Two credentials are accepted, matching the rest of the stack: **`X-Device-Id`**
(a uuid that is also the RevenueCat `appUserID`; the RLS policies pin rows to it)
and an optional **`Authorization: Bearer <GoTrue JWT>`**.

For a raw MCP client that cannot mint a JWT just to try the server, the demo also
accepts a **static bearer token** (`MCP_BEARER_TOKEN` in
[`infra/.env.example`](infra/.env.example)). The server exchanges it, at the MCP
edge, for `MCP_DEMO_DEVICE_ID` and never forwards the token onward.

**This static token is not the only auth path.** It is a shared demo secret
standing in for a device identity, bounded to the single demo device — so the
mutating tools write only to that device on the live stack. The server also
implements **MCP OAuth 2.1** (`src/oauth.ts`): a `client_credentials` grant for
machine hosts and an Authorization Code Grant with PKCE S256 for user-facing
hosts (the production path for Amazon's Alexa+ account linking). It is dormant
until `MCP_OAUTH_SECRET` is set; `GET /health` reports `oauth.configured`.

---

## Verify it speaks MCP

Verification uses the **official MCP SDK client**, not curl, because the point is
that a real MCP host can talk to it: `initialize` → `tools/list` → a live
`tools/call`, plus `resources/list` → `resources/read` and `prompts/list` →
`prompts/get`.

```bash
cd infra/mcp
npm install && npm run build
MCP_URL=https://mcp.globie.earth/mcp node scripts/verify.mjs
```

The script asserts the handshake completes, that `tools/list` returns every tool
it names, that the resources and prompts are listed and read, and that
`tools/call` round-trips a real result.

---

## License

MIT (2026 OpenmindProjects).
