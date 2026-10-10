# Globie Earth MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
Globie Earth's reforestation backend — its living catalogue of native species,
sites and guardian lore, its adoption records and its sanctuary conditions — as
tools an Alexa+ (or any other MCP) host can call.

This service is the **Alexa+ track submission**. It is self-hosted on the same
Easypanel stack as `studio` and `podcast` (reached at `https://mcp.globie.earth`)
and is deliberately host-agnostic: the only coupling to the rest of the stack is
three origins (`POSTGREST_URL`, `STUDIO_URL`, `PODCAST_URL`) and two request
headers. One tool and one route also reach the English Wikipedia Action API,
which is keyless and outside the stack entirely.

- **Transport:** MCP Streamable HTTP at `POST /mcp` (also `GET` for the optional
  server-to-client stream and `DELETE` to end a session).
- **Protocol version:** `2025-11-25`, pinned. The server refuses to boot if the
  SDK's newest supported version ever moves past it, so this line cannot quietly
  become false.
- **Responses:** `enableJsonResponse`, so a POST is answered with a plain JSON
  body rather than an SSE stream. The spec allows either; JSON survives the
  reverse proxy in front of the container with no buffering surprises.

## Tools

Eleven tools. Two change state (`adopt_species` and `generate_soundscape`); the
rest are read-only:

| Tool | What it does | Backend |
| --- | --- | --- |
| `search_forest_knowledge` | Search across species, sites and guardian lore. Semantic when a provider is configured, keyword otherwise. | Self-hosted multilingual-e5-small by default (Amazon Titan V1 optional) → `catalog_search` RPC; keyword fallback reads the catalogue tables |
| `recommend_species` | Recommends species from the caller's own past adoptions. | `recommend_species` RPC |
| `get_sanctuary_conditions` | Ambient CO₂, European AQI, humidity and air temperature at the sanctuary. | Open-Meteo (keyless, modelled fields) |
| `describe_photo` | Describes an attached photo — a plant, landscape, object, room or document. | DeepSeek `deepseek-v4-flash-vision-exp` (not the catalogue) |
| `describe_species` | The English Wikipedia lead section for one species, by scientific or common name. | Wikipedia Action API (keyless, CC BY-SA 4.0, text only) |
| `adopt_species` | Records an adoption (mutating). Idempotent when a store transaction id is supplied. | `create_adoption` + `award_eco_tokens` RPCs |
| `get_my_deeds` | The Living Deeds issued for this caller's adoptions, newest first. | `living_deeds` read (RLS-scoped) |
| `get_eco_balance` | This caller's eco-token balance. | `eco_token_balance` read (RLS-scoped) |
| `generate_soundscape` | Queues a generated piece of music for the sanctuary (mutating). | Studio proxy `POST /v1/studio/tracks` |
| `search_podcasts` | Searches the podcast library for shows about the living world. | Podcast proxy `GET /v1/podcast/search` |
| `get_trending_podcasts` | Lists shows trending in the podcast library, optionally by category. | Podcast proxy `GET /v1/podcast/trending` |

`adopt_species` changes real state, so it is annotated mutating
(`readOnlyHint: false`). When the host passes the store's `reference`, a retry
resolves to the original deed and reports `replayed: true` instead of issuing a
second one. The tool records the adoption; it does not itself take payment.

`describe_photo` is the one tool that reads an image rather than the sanctuary's
own data: it hands the attached photo to the vision model and returns the model's
description, so a photo of *anything* — a tree or not — has a tool to match. Its
payload names the model and says the description is the model's reading of the
image, not a catalogue fact, so a host never presents it as Globie Earth data.

`describe_species` is the one tool that reads text from outside the stack: it
fetches the English Wikipedia lead section for a species by name and returns it
verbatim. That text is **external reference under CC BY-SA 4.0**, not Globie
data, so the payload carries the article URL and a `source` line, and the tool's
spoken form names Wikipedia and says the text may be incomplete or unverified. It
pulls **text only** — never Wikipedia's lead image, which would collide with the
app's strict photo-attribution model — and returns a clear "no article"
explanation rather than an empty record when the name matches nothing.

`generate_soundscape` is mutating too, and it spends the stack's shared daily
render quota, which the studio proxy enforces. Rendering is asynchronous — the
tool returns a track id and a status of `queued`, never a finished recording, so
it must never be reported as produced. The studio and podcast proxies hold the
Suno and Podcast Index credentials; this server holds neither.

## Resources

The same catalogue and deed data, addressed by URI for hosts that prefer to read
rather than call. URIs use the `globie://` scheme (the SDK parses a resource uri
with `new URL()` before dispatch, so it must be absolute).

| Resource | What it is |
| --- | --- |
| `globie://species/{id}` | One species, by id. `list` expands the live catalogue. |
| `globie://guardian/{id}` | One guardian's lore, by id. |
| `globie://site/{id}` | One stop on the trail, by numeric id. |
| `globie://me/deeds` | This caller's Living Deeds — the read-only mirror of `get_my_deeds`. |

The three catalogue templates are world-readable; `globie://me/deeds` is
device-scoped by row-level security, exactly like the tool it mirrors.

## Prompts

| Prompt | What it is |
| --- | --- |
| `forest-guide` | The persona and tool-selection guidance for a voice companion to the sanctuary. |
| `adopt-a-tree` | The guided adoption flow: choose, confirm, then read back the Living Deed. |

`get_sanctuary_conditions` returns Open-Meteo **modelled** fields for the
sanctuary's coordinates, not readings from a sensor on site. The tool
description says so, the payload says so, and the server's `instructions` tell
the model to say so too — because "if we can't prove something happened, the app
doesn't claim it did".

## Tool router — `POST /route`

The tools above are called *by* the host. This route is the front door in the
other direction: it turns one natural-language utterance into one tool call. The
MCP client's *Ask the forest by voice* panel posts the utterance plus the tool
list it just read from `tools/list`, and gets back the single tool to call — which
the host then calls itself, over MCP, so the runtime proof stays on the MCP
surface rather than on this helper.

```
POST /route          X-Device-Id (or demo bearer) required — the same identity /mcp takes
{
  "utterance": "which tree fixes paddy soil",
  "tools": [ { "name": "search_forest_knowledge", "description": "…", "inputSchema": { … } } ],
  "model": "deepseek-v4-flash-vision-exp",   // optional
  "image": "data:image/jpeg;base64,…"        // optional — needs the vision model
}
→ { "tool": "search_forest_knowledge", "arguments": { "query": "…" },
    "rationale": "…", "model": "deepseek-v4-flash-vision-exp" }
```

The model is an OpenAI-compatible chat-completions endpoint with function
calling. `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` / `DEEPSEEK_API_KEY` configure it,
read per request so an env change needs no restart; a missing key is a clear
`503` rather than a boot failure. The route is gated by the same identity as
`/mcp`, because an open `/route` would be a relay that spends this server's key
for anyone who finds it.

**Models.** A caller may name one of two — the allowlist `ROUTER_MODELS` in
`src/router.ts`:

| Model id | Vision | Notes |
| --- | --- | --- |
| `deepseek-flash` | no | The default, and what `DEEPSEEK_MODEL` falls back to. |
| `deepseek-v4-flash-vision-exp` | **yes** | Reads a photo alongside the utterance. |

A name off that list is refused (`400`) rather than forwarded, so the allowlist
cannot be walked past to bill some other model to this server's key. Omitting
`model` behaves exactly as it did before the vision model existed.

**Images.** With the vision model, an optional `image` turns the user message into
multimodal content. It must be a `data:image/…;base64,…` URL or an `http(s)` URL,
capped at 4,000,000 characters; the client downscales a photo to a 1024-px edge as
JPEG first, so it stays well under the cap and under the request body limit. An
image sent with a text-only model is refused (`400`) rather than silently ignored
— the text model would otherwise drop the photo without a word.

A photo is not just context for the routing decision. The router picks
`describe_photo` — the one tool that can read an image — and the host fills the
attached photo into that call's `image` argument itself, because the router
returns only a tool name and small JSON arguments, never a data URL. The tool then
sends the photo to the vision model and returns its description, so photos of
anything — a tree or not — are answered rather than declined for want of a tool.

The route holds the credential and the page holds none: the browser sends a model
*name*, never a key. The model that answered is echoed back in the response
(`"model"`), so the client can say which one did, and `GET /health` lists the
allowlist under `models`.

## Wikipedia lookup — `GET /wiki`

The same Wikipedia lead `describe_species` answers with, as a plain HTTP read,
so the app's own species page can show it without speaking MCP. It is text the
app only ever *adds* to a record, so a species with no article — or a moment when
Wikipedia is unreachable — simply leaves the section out.

```
GET /wiki?name=Dipterocarpus%20alatus   X-Device-Id (or demo bearer) required — the same identity /mcp takes
→ { "title": "Dipterocarpus alatus", "extract": "…",
    "url": "https://en.wikipedia.org/wiki/Dipterocarpus_alatus",
    "license": "Wikipedia · CC BY-SA 4.0" }
→ 404 when Wikipedia has no article for that name
```

Attribution is not optional: a caller that renders the text must name Wikipedia
and link to `url`, because the text is CC BY-SA 4.0. No lead image is returned —
only the plain-text lead. Implemented once in `src/wiki.ts`, and shared by this
route, the `describe_species` tool, and the `wikipedia` field on the
species-bearing resources.

## Voice cascade — `POST /voice/transcribe` and `POST /voice/speak`

DeepSeek ships no audio surface, so *Ask the forest by voice* is a composed loop
rather than one model: the browser records an utterance, **this server** turns it
into text with Whisper, `/route` sends that text to DeepSeek, and the reply is
read back with Kokoro. These two routes are the ears and the mouth — both relay
to the `speech` service (Speaches) in `infra/docker-compose.yml`, which speaks
OpenAI-compatible HTTP.

```
POST /voice/transcribe   X-Device-Id (or demo bearer) required — the same identity /mcp takes
{ "audio": "data:audio/webm;base64,…" }   // or bare base64
→ { "text": "which tree fixes paddy soil", "model": "Systran/faster-whisper-base" }

POST /voice/speak        X-Device-Id (or demo bearer) required
{ "text": "Kae Na fixes paddy soil." }
→ audio/mpeg  (Kokoro, af_heart)
```

This is the free, private, unlimited alternative to a native realtime vendor
(OpenAI Realtime, Gemini Live): there is no per-minute bill and no audio leaves
this machine. The cost is that it is a cascade, not one model — the turnaround is
the sum of its parts rather than a single streaming generation.

The browser never calls `speech` directly. It posts here, and these routes hold
the two things the page must not have: the caller's identity check, and the
cascade's endpoint and model names (so they never reach the shipped bundle — Vite
inlines every `VITE_` variable, so anything the page knows is public). An open
relay would let any anonymous poster spend this server's CPU on STT and TTS.

`SPEECH_URL` points at the service (`http://speech:8000` inside the compose
network); **unset is a valid configuration, not a broken one** — the two routes
then answer `503` and the rest of the MCP surface is untouched, exactly as
`EMBEDDING_PROVIDER=none` only quiets search. `GET /health` reports the cascade
under `speech`.

The Speaches image bakes in **no** weights. A request for a model that has not
been fetched yet answers `404 "is not installed locally"`, so the routes install
it themselves (`POST /v1/models/{url-encoded-id}`) and retry once. The first
utterance after a cold start is slow; every later one is not. That is deliberate —
a fresh clone works with no out-of-band download step. Weights land in the
`speech_models` named volume, so `docker compose down -v` is the one honest way to
reclaim them and a container recreate does not re-download.

**Sizing.** The compose stack's Docker VM reports ~958 MiB of RAM and one CPU, so
`SPEECH_STT_MODEL` defaults to the multilingual `Systran/faster-whisper-base` at
`int8` — the same size class as the English `base.en` but able to output the Thai
the DNP reference data carries — which fits alongside Kokoro (~480 MiB resident
for both). The multilingual `whisper-small` alongside Kokoro is OOM-killed at that
size; raise it once the VM grows. Both models unload after `WHISPER__TTL` (300 s)
idle.

### The mouth reads prose, not JSON

`/voice/speak` should never be handed a pretty-printed object — a synthesizer
will read `\n\n`, `{`, `}` and `"key":` aloud, which is not human speech. So every
tool result carries **two** text blocks: the JSON a screen shows, and a
plain-language line a reader says. The spoken block is tagged
`annotations: { audience: ["user"] }`; the client picks exactly that block for
`/voice/speak`, and only falls back to the JSON when a result carries no line.

```
content: [
  { type: "text", text: "{\n  \"query\": …\n}" },                       // screens
  { type: "text", text: "I found 5 keyword matches for …",              // the mouth
    annotations: { audience: ["user"] } }
]
```

`jsonResult(value, spoken)` in `src/tools/result.ts` is the one place that builds
this; each tool passes its own sentence (whitespace is collapsed first, so no
`\n` can reach the mouth). The JSON stays first, so `scripts/verify.mjs` and the
tool forms are unchanged.

## Photo contributions — `POST /contribute` and `DELETE /contribute/:id`

A species page may hold no photograph, and the visitor standing in front of the
plant has one. This route is where that photograph is offered. It sits beside
`/route` and `/voice/*` rather than on the MCP surface because it is a **browser
form, not a tool call**: the page posts the images, and this server — which holds
both the vision key and the storage key — does everything the page cannot do
safely. It is gated by the same `X-Device-Id` identity as `/mcp`.

Four things happen in **one order that cannot be reordered**:

1. **Scanned before anything is written.** Globie's vision model reads the
   photographs first, told the species by scientific name *and* family as well as
   its local name, with each photo labelled by the organ it shows. It returns one
   strict JSON object rating the set `safe`/`unsafe` and giving **each photo** its
   own identity verdict — `match` / `unsure` / `mismatch` — not a bare yes/no. A
   single leaf can be a thistle or it can be Acanthus, so the model may answer
   "unsure, show me the flower" rather than being forced into a wrong rejection.
2. **Unsafe is refused and never stored.** The filter is **fail-closed** — only an
   explicit `safe = true` passes — and it runs *before* the write, so a harmful
   upload leaves no bytes in object storage and no row in the database.
3. **Identity is judged per photograph.** One visitor may bundle a good leaf, a
   good flower and a fruit that belongs to a different species; a frame the model
   clearly contradicts is dropped before its bytes reach storage. Only when **no**
   frame matches *and* none is merely unclear is the whole set refused.
4. **Only the safe, on-subject frames are stored** — as **one `pending`
   contribution** (`220`/`230`/`233`), each frame carrying its own pending status
   and a zeroed tally so the crowd votes on the media file. Accepting a frame is a
   separate human act, which is `POST /moderate/decision` below.

```
POST /contribute        X-Device-Id (or demo bearer) required — the same identity /mcp takes
{
  "speciesType": "dnp_plant",     // dnp_plant | dnp_fauna | dnp_wildlife | dnp_species
  "speciesId": 12,                // the DNP row id
  "speciesName": "…",             // optional label
  "attempt": 1,                   // 2 after the visitor adds the organs Globie asked for
  "photos": [                     // up to 4 media files; at most 1 video
    { "image": "data:image/jpeg;base64,…", "organ": "leaf" },
    { "mediaType": "video", "image": "data:video/webm;base64,…",
      "frames": [ "data:image/jpeg;base64,…" ] }   // stills sampled from the clip for the scan
  ]
}
→ { "status": "accepted", "id": "…", "photoUrl": "https://…", "pending": true,
    "verdict": "match", "organs": ["leaf", "whole"], "model": "deepseek-v4-flash-vision-exp" }
```

`organ` is one of `whole · leaf · flower · fruit · bark · head · body · habitat ·
other` (anything unrecognised is kept as `other`, not refused). A single-photo
`{ "image": "…", "organ": "whole" }` shorthand is also accepted. `status` is one of:

- `accepted` — the media passed the scan and are stored as one pending row;
- `need_more` — the first scan was *unsure* and asked for specific organs; the
  visitor may resend with `"attempt": 2`, after which an unresolved but safe frame
  is stored **for a steward** rather than bounced again (the loop is bounded at
  exactly one extra round);
- `off_topic` — every frame looked like the wrong species;
- `blocked` — the scan flagged the set unsafe (nothing was stored).

Limits: ≤ 4 media files, ≤ 1 video, ≤ 4 sampled frames per video; 5 MB per photo,
24 MB per video, 1 MB per frame, 32 MB total (base64-decoded). A `503` means the
route is unconfigured — `DEEPSEEK_API_KEY` for the scan, or the `MINIO_*` set for
storage.

```
DELETE /contribute/<uuid>   X-Device-Id (the owner's) required
→ { "status": "removed", "id": "…" }
```

Removal pins ownership by `device_id` and deletes the stored objects **before** the
row, so a withdrawn upload is not left fetchable; a second delete is a no-op.
Votes cast on the row cascade away with it. The bytes never travel through
Postgres — the row records a **key** into object storage, which is
`infra/mcp/src/minio.ts`: MinIO speaks the S3 API, so the AWS SDK's S3 client talks
to it with `forcePathStyle`. The credential is **server-side only** — the browser
holds a device id, never a bucket key. The bucket is created if missing and given a
**public-read** policy on first accepted upload, so an approved photo loads from any
device's `<img>` while its random-uuid URL stays unguessable until then.

## The review queue — `GET /moderate/queue` and `POST /moderate/decision`

`/contribute` ends by storing a photograph as a `pending` row and saying that
accepting it is *a separate human act*. This is that act. It lets a moderator read
the queue and move a row `pending → approved | rejected`; an `approved` row is the
one a species page may show.

```
GET /moderate/queue     X-Device-Id (a moderator's) required
→ { "pending": 12, "contributions": [ { "id": "…", "species_type": "dnp_plant",
    "photo_url": "…", "ai_category": "…", "ai_subject": "…", "ai_reason": "…",
    "ai_model": "…", "created_at": "…" } ] }        // 403 when the device is not a moderator

POST /moderate/decision
{ "id": "<uuid>", "decision": "approve" }           // approve | reject
→ { "status": "approved", "contribution": { … } }   // 404 when the row is already decided
```

Two things are deliberately **not** decided here. **Who may moderate** is
`api.moderators`, tested by RLS through `private.is_moderator()` — this route checks
the same thing first only so a non-moderator gets a clear `403` instead of a
misleading empty list; the database is the authority, and the update is refused by
policy even if that check were wrong. **What an update may change** is three columns
only — `status`, `reviewed_by`, `reviewed_at` — so the route could not rewrite a
photo or its scanner verdict. The queue returns the scanner's own verdict beside the
photo because the queue is a decision, and a decision wants its evidence. A
moderator is an ordinary device that happens to have a row in `api.moderators`; no
service key is involved. The decision is pinned to `status=eq.pending`, so a
contribution can be decided exactly once.

## Authentication (and what this demo honestly is not)

Two credentials are accepted, matching the rest of the stack:

- **`X-Device-Id`** — a uuid that is also the RevenueCat `appUserID`. The RPCs
  read it as their identity, and the row-level-security policies pin every
  device-scoped row to it.
- **`Authorization: Bearer <GoTrue JWT>`** — the optional account credential.
  A device-only caller omits it. The JWT is forwarded to PostgREST untouched.

For a raw MCP client that cannot mint a GoTrue JWT just to try the server, the
demo also accepts a **static bearer token** (`MCP_BEARER_TOKEN`). The server
exchanges it, at the MCP edge, for `MCP_DEMO_DEVICE_ID` and never forwards the
token itself onward.

**This static token is not MCP OAuth 2.1, and this README does not claim it is.**
It is a shared demo secret standing in for a device identity. The production
path is Amazon's Alexa+ MCP account linking — the **OAuth 2.1 Authorization Code
Grant with PKCE S256**, implicit not supported — which is **not built here**.
Treat the token like
any other secret: server-side only, never a `VITE_` variable.

## Configuration

These are the names the process reads. In `infra/.env` the four origins carry the `MCP_` prefix — `MCP_POSTGREST_URL`, `MCP_STUDIO_URL`, `MCP_PODCAST_URL`, `MCP_SPEECH_URL` — which `infra/docker-compose.yml` maps onto the container-level names below; every other variable keeps the same name in both places. See `infra/.env.example` for the full commentary.

| Variable | Required | Meaning |
| --- | --- | --- |
| `POSTGREST_URL` | **yes** | API origin, e.g. `https://api.globie.earth`. The container refuses to start without it. Locally, compose defaults it to `http://rest:3000`. |
| `STUDIO_URL` | no | Origin of the studio proxy, for `generate_soundscape`. Unset only disables that tool, which then explains itself. Locally, compose defaults it to `http://studio:8080`. |
| `PODCAST_URL` | no | Origin of the podcast proxy, for the two podcast tools. Unset only disables those tools, which then explain themselves. Locally, compose defaults it to `http://podcast:8080`. |
| `PORT` | no | Listen port. Defaults to `8080`, which is what the image exposes. |
| `MCP_BEARER_TOKEN` | no | The demo static bearer. Unset disables the demo path. |
| `MCP_DEMO_DEVICE_ID` | no | The uuid the demo token resolves to. Must exist in `api.devices`. |
| `MCP_CORS_ORIGINS` | no | Comma-separated literal origin list for browser clients. Non-browser MCP hosts send no `Origin` and are unaffected. |
| `EMBEDDING_PROVIDER` | no | `local` (default), `bedrock` or `none`. `none` is a valid configuration, not a broken one — see below. |
| `EMBEDDING_CACHE_DIR` | no | Where the local model's weights are cached. Defaults to `.cache`; the image sets it to `/app/.cache`. |
| `BEDROCK_REGION` / `AWS_REGION` | no | Region for Bedrock. Either works. Only read by `EMBEDDING_PROVIDER=bedrock`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | Credentials for a service running off AWS. An instance role is the production path on AWS. |
| `DEEPSEEK_BASE_URL` | no | OpenAI-compatible base for the tool router (`POST /route`). Defaults to `https://api.deepseek.com/v1`. |
| `DEEPSEEK_MODEL` | no | Default router model. Defaults to `deepseek-flash`; a caller may override it with an id from the router's allowlist (see *Tool router*). |
| `DEEPSEEK_API_KEY` | no | Key for the tool router. Unset leaves `/route` a clear `503`; the MCP tools are unaffected. |
| `RERANK_ENABLED` | no | `true` (default) or `false`. Turns the `search_forest_knowledge` rerank stage on/off (MCP plan §16). |
| `RERANK_POOL` | no | Candidate rows fetched before reranking, then sliced to 8. Defaults to `20`. |
| `RERANK_TIMEOUT_MS` | no | Per-call budget for the rerank model. Defaults to `20000` (matches the router's upstream timeout; a live VPS→DeepSeek call measured ~9s); expiry falls back to the cosine order. |
| `DEEPSEEK_RERANK_MODEL` | no | Model for the rerank pass. Defaults to `DEEPSEEK_MODEL`; needs no key of its own. |
| `MINIO_ENDPOINT` | no | S3-compatible origin for the media bucket, e.g. `http://minio:9000` locally. Unset disables `/contribute`, which then answers a clear `503`. |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | no | Bucket credentials. **Server-side only** — never a `VITE_` variable, never sent to a browser. Unset disables `/contribute` (`503`). |
| `MINIO_BUCKET` | no | The bucket photos are written to. Created with a public read policy on first upload. Defaults to the app's media bucket (`globie-media`). |
| `MINIO_REGION` | no | S3 region string. Defaults to `us-east-1`; MinIO accepts it and ignores it. |
| `MINIO_PUBLIC_URL` | no | The URL prefix a browser can actually read, when it differs from `MINIO_ENDPOINT` (e.g. an internal hostname vs. a public relay). Defaults to `${MINIO_ENDPOINT}/${MINIO_BUCKET}`. |
| `SPEECH_URL` | no | Origin of the speech service (Speaches: STT + TTS) for `/voice/*`. Unset leaves those routes a clear `503`; the MCP tools are unaffected. |
| `SPEECH_STT_MODEL` | no | Speech-to-text model id. Defaults to the multilingual `Systran/faster-whisper-base`. |
| `SPEECH_TTS_MODEL` | no | Text-to-speech model id. Defaults to `speaches-ai/Kokoro-82M-v1.0-ONNX`. |
| `SPEECH_TTS_VOICE` | no | TTS voice id. Defaults to `af_heart`. |

The two media/speech feature groups fail closed and in isolation: an unset
`MINIO_*` group disables only `/contribute`, and an unset `SPEECH_URL` disables
only `/voice/*`. Neither affects the eleven MCP tools, and neither crashes the
process — the server starts and reports what is unconfigured on `/health`.

### Embeddings

`search_forest_knowledge` embeds the query with a **self-hosted
multilingual-e5-small** model (`Xenova/multilingual-e5-small` through
transformers.js/ONNX, 384 dimensions) running in-process. It needs no account
and bills nothing, so it is the default; the `vector(384)` column and
`catalog_search`'s parameter match its width.

`EMBEDDING_PROVIDER=bedrock` selects **Amazon Titan Text Embeddings V1**
(`amazon.titan-embed-text-v1`, 1536 dimensions) instead, kept for the AWS
Builder story. It needs an AWS account whose Bedrock data plane is not gated,
and `api.embeddings` migrated back to `vector(1536)`. Both providers sit behind
the one interface in `src/embed.ts`; the local model is the one that always runs.

One rule the code cannot enforce: catalogue rows must be embedded by the *same*
model as the queries, or cosine similarity compares two unrelated spaces. The
seed data ships **no** embeddings on purpose, so this is a fresh choice rather
than a swap. Until a backfill runs with this exact model, the semantic path
finds no rows and says so rather than pretending.

When no embedding can be computed — `EMBEDDING_PROVIDER=none`, or a configured
provider that fails (for example an AWS account without Bedrock access) — the
tool does **not** fail. It falls back to a **keyword search** over the same
catalogue text a vector would have been built from, and labels the answer
`"method": "keyword"` with a `note` naming the reason. It never reports a cosine
similarity it did not compute. Every answer therefore carries `method` as
`"semantic"` or `"keyword"`, so a host can tell the two apart. Every other tool
works with no embedding provider at all, and the local model needs no AWS
credentials or account.

## Run locally

```bash
cd infra/mcp
npm install
npm run build

# POSTGREST_URL just has to be set for the server to boot; tools that do not
# need the API still work.
POSTGREST_URL=http://localhost:3001 EMBEDDING_PROVIDER=none npm start
```

`GET /health` reports the protocol version, the embedding provider, whether the
API origin is configured, and whether the two optional proxy origins are set.

## Run in the stack

The service is declared in `infra/docker-compose.yml` as `mcp`, on loopback port
`8092` (mapped to the container's `8080`). On the live server an Easypanel domain
points `mcp.globie.earth` at it.

```bash
docker compose -f infra/docker-compose.yml up -d --build mcp
```

## Verify it speaks MCP

Verification uses the **official MCP SDK client**, not curl, because the point is
that a real MCP host can talk to it: `initialize` → `tools/list` → a live
`tools/call`, plus `resources/list` → `resources/read` and `prompts/list` →
`prompts/get`.

```bash
cd infra/mcp
npm run build

# Start a server for the check (or reuse the compose one).
POSTGREST_URL=http://localhost:3001 EMBEDDING_PROVIDER=none PORT=8099 node dist/server.js &

# Run the official SDK client against it.
MCP_URL=http://localhost:8099/mcp node scripts/verify.mjs
```

The script asserts that the handshake completes, that `tools/list` returns every
tool it names, that the resources and prompts are listed and read, and that
`tools/call` round-trips a real result. It uses `X-Device-Id`, so no demo token
is needed.

## Measure it, and what we learned

`scripts/bench-embed.mjs` measures the configured embedding path — it imports the
same `embedWithUsage()` the server calls, so the latency belongs to the real
request rather than a copy of it. It prints min/p50/p95/max/mean latency, and
prices the run at Titan V1's `$0.10` per 1M input tokens only when the provider
reports them (the local model reports none), and it refuses to invent numbers
when it cannot run.

```bash
npm run build
node scripts/bench-embed.mjs 50     # local model by default; EMBEDDING_PROVIDER=bedrock for a Titan run
```

[PRODUCT-FEEDBACK.md](./PRODUCT-FEEDBACK.md) is the per-SDK build log the
hackathon asks for — the MCP TypeScript SDK, Amazon Bedrock, PostgREST, GoTrue,
Fastify, Open-Meteo, Podcast Index and Suno — written from what actually happened
while building this server. Titan's latency and cost rows stay pending until the
bench runs against an account with Bedrock access.
