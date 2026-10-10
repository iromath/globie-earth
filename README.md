# Globie Earth — MCP server for Alexa+

A self-hosted **[Model Context Protocol](https://modelcontextprotocol.io) server**
that puts Globie Earth's reforestation backend in reach of an Alexa+ (or any MCP)
host: the living catalogue of native species, sites and guardian lore, the
adoption records, the sanctuary's conditions, and a self-hosted voice loop to ask
about all of it.

This repository **is the Amazon hackathon submission (Alexa+ track)**: the MCP
server and the demo browser MCP client that proves a real MCP host can drive it.

- **Transport:** MCP Streamable HTTP at `POST /mcp` (`GET` for the optional
  server-to-client stream, `DELETE` to end a session).
- **Protocol version:** `2025-11-25`, **pinned**. The server refuses to boot if
  the SDK's newest supported version ever moves past it, so this line cannot
  quietly become false.
- **Surface:** 11 tools · 8 resources (7 URI templates + 1 static) · 2 prompts,
  plus 8 browser side-routes and a `GET /health`.
- **Runs at:** `https://mcp.globie.earth`; the demo client at
  `https://mcp-client.globie.earth`.
- **Backend:** Fastify + TypeScript on Node 22, self-hosted on an Easypanel
  stack. Every byte of data comes over the live Globie Earth HTTP APIs — there is
  no local database and nothing seeded.

Full detail — every tool's backend, the router, the voice cascade, the
contribution pipeline, and the honest note on what the demo auth is *not* — lives
in [`infra/mcp/README.md`](infra/mcp/README.md).

---

## Quick start

One command brings up the MCP server and the demo client. No `.env` is required:
the three data origins default to the live Globie Earth APIs.

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

### Tools (11)

Two change state (`adopt_species`, `generate_soundscape`); the rest are
read-only.

| Tool | What it does |
| --- | --- |
| `search_forest_knowledge` | Search species, sites and guardian lore — semantic by default, keyword fallback |
| `recommend_species` | Recommend species from the caller's own past adoptions |
| `get_sanctuary_conditions` | Ambient CO₂, European AQI, humidity and air temperature |
| `describe_photo` | Describe an attached photo with a vision model |
| `describe_species` | The English Wikipedia lead section for a species, by name |
| `adopt_species` | Record an adoption (mutating; idempotent with a store transaction id) |
| `get_my_deeds` | The Living Deeds issued for this caller's adoptions |
| `get_eco_balance` | This caller's eco-token balance |
| `generate_soundscape` | Queue a generated piece of music for the sanctuary (mutating) |
| `search_podcasts` | Search the podcast library for shows about the living world |
| `get_trending_podcasts` | List trending shows, optionally by category |

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

### Browser side-routes

Beside the MCP surface, for the app and the demo client:

| Route | Purpose |
| --- | --- |
| `POST /route` | Turn one natural-language utterance into one tool call |
| `GET /wiki` | The Wikipedia lead `describe_species` answers with, as plain HTTP |
| `POST /voice/transcribe` / `POST /voice/speak` | The self-hosted STT/TTS voice loop |
| `POST /contribute` / `DELETE /contribute/:id` | Offer a species photograph for review |
| `GET /moderate/queue` / `POST /moderate/decision` | The human review of those contributions |
| `GET /health` | Protocol version, embedding provider, and what is configured |

Each is documented in [`infra/mcp/README.md`](infra/mcp/README.md).

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
                                    │  X-Device-Id / Bearer, forwarded
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
     api.globie.earth     studio.globie.earth     podcast.globie.earth
     (PostgREST: species, (soundscape)            (podcasts)
      guardians, sites,
      deeds, DNP data)
```

Only non-browser hosts (Alexa+) send no `Origin`; browser clients are matched
against `MCP_CORS_ORIGINS` literally.

Two feature groups fail **closed and in isolation**, so the server always starts
and reports what is unconfigured on `GET /health`: an unset `SPEECH_URL` disables
only `/voice/*` (they answer a clear `503`), and unset `MINIO_*` disables only
`/contribute`. Neither touches the eleven tools.

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

**This static token is not MCP OAuth 2.1, and this repository does not claim it
is.** It is a shared demo secret standing in for a device identity, bounded to
the single demo device — so the two mutating tools write only to that device on
the live stack. The production path is Amazon's Alexa+ account linking (the OAuth
2.1 Authorization Code Grant with PKCE S256); it is **not built here**.

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
