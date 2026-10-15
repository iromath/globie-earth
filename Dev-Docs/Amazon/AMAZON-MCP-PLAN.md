# Globie Earth × Amazon Developer Hackathon — an Alexa+ MCP server

**Status:** built and verified through Phase 5; Phase 6 (deploy + submit) in progress. `infra/mcp/` (**51 tools** — 15 Globie forest/cookbook tools + 36 Openmind.Travel `om_*` tools — 7 resource templates, 2 prompts, plus 8 side routes — `/route`, `/wiki`, `/voice/*`, `/contribute`, `/moderate/*`) and `infra/mcp-client/` (a real browser MCP client) both exist and are verified with the official SDK client. Remaining: live host bring-up, the submission video, the Devpost fields, and the deferred Bedrock bench. Decisions D1–D5 are locked (§12); D6 (rerank) is built (§16) and §19 adds Amazon Bedrock **Nova** as a selectable chat/vision provider alongside DeepSeek.
**Requested shape:** enter the *Build, Ship, Shape: Amazon Developer Hackathon* on the **Alexa+** track by building a **self-hosted MCP server** (spec ≥ 2025-11-25, Streamable HTTP) over the Globie Earth backend, demonstrated by a small web client that is a real MCP client. Bolt on **AWS Builder** and **Open Source** mini challenges on the same artifact.

**Decisions locked (from the request):**

| Decision | Value |
|---|---|
| Primary track | **Alexa+** |
| Submission shape | **Real MCP server + web client** (not simulation-only, not an Alexa Agent Skill) |
| Transport / spec | **Streamable HTTP**, MCP spec **2025-11-25 or later** |
| AWS Builder | **Yes** — Amazon Bedrock wired in for embeddings (optional provider; the self-hosted model is the default) (hosting is *not* required for this mini challenge) |
| MCP host | **We self-host** — new `mcp` service on our own Easypanel stack (`mcp.globie.earth`); code stays host-agnostic |
| Repo visibility | **Public** — the submission repo carries a root `LICENSE` (D5 = Option A, §10/§12); the six Amazon DevRel users + `testing@devpost.com` are added as collaborators at submission time as a courtesy |
| Repo scope | `Shipaton-2026/` excluded; Firebase admin key and `google-services.json` kept out of the repo |
| This turn's deliverable | **This document**; no code |

**Read alongside**

| Doc | Why |
|---|---|
| [`../PROJECT-MEMORY.md`](../PROJECT-MEMORY.md) | Infra/release conventions any new service must match |
| [`../SOUND-STUDIO-INTEGRATION-PLAN.md`](../SOUND-STUDIO-INTEGRATION-PLAN.md) | The proxy template this service copies: secret-in-container-env, `X-Device-Id` credential, degradation rule |
| [`../PODCAST-INTEGRATION-PLAN.md`](../PODCAST-INTEGRATION-PLAN.md) | The second proxy; also the evidence that a service can be added beside `rest`/`auth` cheaply |
| [`../../infra/docker-compose.yml`](../../infra/docker-compose.yml) | The service pattern (`studio`, `podcast`) the new `mcp` service mirrors |
| [`../../infra/schema/040_functions.sql`](../../infra/schema/040_functions.sql) | The RPCs the MCP tools wrap |
| [`../../infra/schema/180_embeddings_local.sql`](../../infra/schema/180_embeddings_local.sql) | The `vector(384)` embedding table that the self-hosted model writes into |

**External source of truth:** the hackathon rules — <https://amazonappdev2026.devpost.com/rules>.

---

## 1. Why Alexa+, and what "fit" actually means here

The app that ships in `src/` is a Capacitor/React mobile SPA. **None of the four primary tracks is a mobile-GUI track**, so the existing screens are irrelevant to judging. What matters is the *backend capability* an Alexa+ MCP can expose — and that backend is already built.

| Track | Fit | Reason |
|---|---|---|
| **Alexa+** | **High** | The stack is already self-hosted (Postgres + PostgREST + GoTrue + two Fastify proxies). An MCP server is one more service in the same shape. |
| Fire TV | Low | Needs a 10-foot TV UI, a Fire OS/Vega build, and a device/simulator demo. |
| Bee | None | No Bee device and no Bee data anywhere in the repo. |
| Ring | None | No Ring API/SDK/device integration. |

**The reframe.** Alexa+ does not require the Globie UI. It requires a working MCP server that turns the existing data and actions into tools a voice agent can call. Globie already has, in MCP terms:

- **Resources** — a read-only catalogue of species, guardians and sites, plus per-user deeds and balances.
- **Tools** — search, recommendation, adoption, eco-token read, soundscape generation, podcast lookup, sanctuary conditions.
- **A reason to exist** — a voice companion for a real reforestation app is a *specific, credible* story, which is exactly what the **Potential Impact** and **Quality of the Idea** criteria reward.

### 1.1 The honesty framing (house rule)

Two of the four judging criteria are narrative, so the claim discipline from [`../PODCAST-INTEGRATION-PLAN.md`](../PODCAST-INTEGRATION-PLAN.md) applies verbatim: **if we can't prove something happened, we don't claim it did.**

- The MCP server is **net-new**. The plan says so in every submission field.
- Sanctuary conditions come from **Open-Meteo modelled fields**, not a sensor in the wetland (already stated in `src/lib/openMeteo.ts`). The tool description must carry that caveat. Open-Meteo's free tier is **non-commercial** — the demo is fine; a commercial claim is not.
- Adoption is **real state** in `api.adoptions` / `api.living_deeds`, backed by a RevenueCat transaction. The MCP tool wraps the same idempotent RPC the app calls.

---

## 2. Target architecture

```
        Alexa+ / test harness            web client (NEW, demo + runtime hook)
                 │                                   │  MCP over Streamable HTTP
                 └───────────────┬───────────────────┘
                                 ▼
                    ┌───────────────────────────────┐
                    │  mcp  (NEW service)           │
                    │  Node 22 · Fastify · TS       │
                    │  @modelcontextprotocol/sdk    │
                    │  • 53 tools (17 Globie + 36 Openmind Travel) · 7 templates      │
                    │  • self-hosted e5-small → embed  │
                    │  • calls PostgREST over HTTPS  │
                    └──────────┬────────────────────┘
                               │  X-Device-Id + Bearer (existing auth)
                               ▼
             ┌─────────────────┴──────────────────┐
             ▼                                     ▼
      PostgREST (api.globie.earth)          studio / podcast proxies
      db · pgvector · RLS · RPCs            Open-Meteo (keyless)
```

**Where the new service runs — decided in D2: self-hosted on our own infrastructure (Option B).**

| | **Option A — MCP on AWS** | **Option B — MCP on our own Easypanel stack ✅ (chosen)** |
|---|---|---|
| Runtime | App Runner / ECS Fargate container | New service in `infra/docker-compose.yml` |
| Talks to the stack via | the **existing PostgREST HTTPS API** (`api.globie.earth`) | direct `DATABASE_URL` (same connection the other services use) |
| DB credentials leave Easypanel? | **No** | Yes, into the container env (as today) |
| AWS Builder story | Bedrock **and** AWS hosting | Bedrock only |
| Public endpoint | App Runner's own HTTPS URL | Easypanel domain `mcp.globie.earth` |

**Decision (D2): Option B — we host the MCP server ourselves.** It runs as a new `mcp` service on the existing Easypanel stack, beside `studio`/`podcast`, exposed at `mcp.globie.earth`. Easypanel already provides a public HTTPS endpoint for free and matches the existing service pattern, so this keeps AWS **off** the critical path. The code stays host-agnostic (`POSTGREST_URL` + auth via env), so it can still be lifted onto AWS App Runner later if time allows — but that is optional, because **AWS Builder is satisfied by Bedrock alone**.

**Bedrock Auth trade-off:** running off AWS means the container cannot assume an **IAM role**, so Bedrock is called with credentials supplied through container env (`infra/.env`). Instance-role / short-lived credentials remain the production path and a product-feedback talking point.

---

## 3. What to build (repo layout)

| Path | New? | Purpose |
|---|---|---|
| `infra/mcp/` | new | The MCP server (Fastify + TS + `@modelcontextprotocol/sdk`) |
| `infra/mcp/src/server.ts` | new | Streamable-HTTP endpoint at `/mcp`, health at `/health` |
| `infra/mcp/src/tools/*.ts` | new | One file per tool group (catalog, adoption, conditions, audio, podcast) |
| `infra/mcp/src/resources/*.ts` | new | `species/{id}`, `guardian/{id}`, `site/{id}`, `me/deeds` |
| `infra/mcp/src/prompts/*.ts` | new | `forest-guide` persona, `adopt-a-tree` flow |
| `infra/mcp/src/embed.ts` | new | Embedding provider behind one interface — **self-hosted model** default, Bedrock Titan optional |
| `infra/mcp/Dockerfile` | new | Mirrors `infra/studio/Dockerfile` |
| `infra/mcp/README.md` | new | Setup/run instructions (a **submission requirement**) |
| `infra/docker-compose.yml` | edit (D2 = B) | `mcp` service beside `studio`/`podcast` |
| `infra/mcp-client/` | new | The demo MCP client (D1: its own small Vite app — kept in tracked `infra/`, not gitignored `Dev-Docs/`) |

The MCP server must be usable **standalone** (`npm run dev` + env) so a judge can run it from the README without the whole Android stack.

---

## 4. MCP surface

Every tool returns the same facts the app already produces — no new claims, no invented data.

| Tool | Backing source | Notes |
|---|---|---|
| `search_forest_knowledge(query, entity_type?)` | Embed `query` (self-hosted default) → `POST /rpc/catalog_search` (`040_functions.sql`) | The core voice tool. `entity_type` ∈ `species\|site\|guardian\|...`. |
| `recommend_species(match_count?)` | `POST /rpc/recommend_species` | Taste profile from the caller's own adoptions (device-scoped RPC). |
| `get_sanctuary_conditions()` | `src/lib/openMeteo.ts` logic → Open-Meteo keyless APIs | CO₂ + European AQI + humidity + temp; carries the modelled-not-measured caveat. |
| `adopt_species(species_id, quantity?)` | `POST /rpc/create_adoption` | Idempotent per `(device_id, rc_transaction_id, species_id)`; returns deed + replayed flag. |
| `get_my_deeds()` | `GET /living_deeds` (`api.ts` shape) | Per-user; echoes the Living Deed number. |
| `get_eco_balance()` | `GET /eco_token_balance` | Sum across the caller's devices, as `fetchEcoTokenBalance()` computes. |
| `generate_soundscape(prompt, style)` | studio proxy `/v1/studio/tracks` | Returns a job id to poll; 429 on the daily quota. |
| `search_podcasts(query)` / `get_trending_podcasts()` | podcast proxy `/v1/podcast/*` | Search + freshness; trending 503s until Podcast Index keys exist. |

URIs carry the `globie://` scheme (an absolute URI is required — the SDK runs
`new URL()` on a resource uri before dispatch, so a bare relative `species/kae-na`
throws JSON-RPC `-32603`).

| Resource | URI | Backing |
|---|---|---|
| Species | `globie://species/{id}` | `GET /species?select=*` |
| Guardian | `globie://guardian/{id}` | `GET /guardians?select=*` |
| Site | `globie://site/{id}` | `GET /sites?select=*` |
| My deeds | `globie://me/deeds` | `GET /living_deeds` (device-scoped) |

| Prompt | Purpose |
|---|---|
| `forest-guide` | Persona + tool-selection guidance for the voice layer. |
| `adopt-a-tree` | The guided adopt flow (pick species → confirm → deed). |

**Capability honesty:** tools are marked read-only vs. mutating in their descriptions, so a host can gate `adopt_species` and `generate_soundscape` behind confirmation. This is what makes the "Alexa, adopt a tree" moment safe to demo — and it's a product-feedback point about MCP tool annotation.

---

## 5. Embedding integration (self-hosted default, Bedrock optional)

The embedding dimension is the only coupling. `api.embeddings.embedding` is now `vector(384)` (`infra/schema/180_embeddings_local.sql`) with default model `Xenova/multilingual-e5-small`. `catalog_search` takes a **caller-computed** query vector, so the MCP server is free to compute that vector with any provider — the RPC signature never depends on the width, only the vector's own dimension does.

The default provider is **self-hosted** (`EMBEDDING_PROVIDER=local`, the default): `intfloat/multilingual-e5-small` through transformers.js/ONNX, 384 dims, CPU-only, multilingual (Thai + English), needing no account and billing nothing. Amazon Bedrock's **Titan Text Embeddings V1** stays selectable (`EMBEDDING_PROVIDER=bedrock`) for the AWS Builder story, but it needs an account whose Bedrock data plane is not gated, and the column migrated back to `vector(1536)`.

| Provider | Model | Dims | Schema change? | Re-embed needed? |
|---|---|---|---|---|
| **Self-hosted (default)** | `Xenova/multilingual-e5-small` | **384** | `vector(384)` — set by `180_embeddings_local.sql` | Yes — full re-embed of `api.embeddings` |
| Amazon Titan Text Embeddings V1 (`EMBEDDING_PROVIDER=bedrock`) | `amazon.titan-embed-text-v1` | 1536 | `vector(384)` → `vector(1536)` | Yes — full re-embed of `api.embeddings` |

**Decision D3 (revised):** default to the **self-hosted multilingual-e5-small (384 dims)**. It needs no AWS account, no credentials and bills nothing, so semantic search runs on any host — which is what let the demo survive the new-account Bedrock gate (`ValidationException: Operation not allowed`, support case 179122138300151). Amazon Titan V1 remains selectable behind `EMBEDDING_PROVIDER=bedrock`, so the AWS Builder mini-challenge story stays honest; enabling it is a full re-embed plus a `vector(384)` → `vector(1536)` migration away. Either way, the catalogue rows must be produced by the *same* model as the queries, and `060_seed_catalog.sql` deliberately ships no embeddings so the choice is explicit.

**Product-feedback angle (required for every SDK):** MCP TypeScript SDK *and* Bedrock are both logged — setup friction, doc clarity, latency of the self-hosted model vs. Titan, and whether we'd build with them again.

---

## 6. Auth & identity

Alexa+ MCP over Streamable HTTP needs an authenticated caller; the app's identity model already answers "who".

| Tier | Credential | How it maps |
|---|---|---|
| Device | `X-Device-Id` (uuid, checked against `api.devices`) | The RevenueCat `appUserID`; scopes deeds/balance via RLS (`030_rls.sql`) |
| Account (optional) | GoTrue-issued JWT in `Authorization: Bearer` | Same token PostgREST already verifies (`070_accounts.sql`, `080_account_ownership.sql`) |

**Decision D4:** for the hackathon, a **static bearer token** exchanged at the MCP edge for a device/account identity is enough for the demo. Note in the doc and in product feedback that production should use the MCP OAuth 2.1 flow; GoTrue is a candidate authorization server but is not MCP-shaped out of the box. Do **not** overclaim OAuth support unless it's actually built.

---

## 7. Security — fix before anything is published

The repo is **not a git repository yet** and already carries a leaked credential.

| Finding | Action | Blocking? |
|---|---|---|
| `play-integrity-samajbmben6ljys-firebase-adminsdk-fbsvc-a494b0a695.json` (Firebase **admin** service-account key) at repo root, **not** in `.gitignore` | **Rotate the key in Google Cloud, delete the file, and confirm `.gitignore` covers `*adminsdk*.json`** before any repo is made public or shared | **Yes — do first** |
| `.env`, `.env.local`, `.env.production.local`, `infra/.env` | Confirm each is ignored; ship `.env.example` only | Yes |
| No `LICENSE` file | Add one (needed for the public/OSS path) | Yes (public path) |
| `Dev-Docs/All-keys.md` | Never ship; confirm ignored | Yes |

The hackathon repo must be **public + OSS-licensed** *or* **private shared with `testing@devpost.com` and the six Amazon DevRel GitHub users** (`chris-trag, knmeiss, giolaq, anishamalde, mosesroth, emersonsklar`). Collaborator invitations **expire after 7 days** — invite at submission time, not now.

---

## 8. Deployment

1. **Container** — `infra/mcp/Dockerfile` (Node 22, same base as `studio`/`podcast`).
2. **Host (D2 = B)** — add the `mcp` service to `infra/docker-compose.yml` with an Easypanel domain, exactly like `studio`/`podcast`; health check on `/health`.
3. **Public HTTPS URL** — `https://mcp.globie.earth`; the MCP endpoint is `/mcp` (Streamable HTTP).
4. **Config** — `POSTGREST_URL` (`https://api.globie.earth`), `MCP_BEARER_TOKEN`, `EMBEDDING_PROVIDER=local` (the default; no credentials needed), optionally `BEDROCK_REGION` / `AWS_REGION` plus Bedrock credentials in `infra/.env` when `EMBEDDING_PROVIDER=bedrock`. No `VITE_` prefix anywhere (Vite inlines those into the shipped bundle).
5. **Deferred (optional)** — App Runner/ECS with an IAM role for Bedrock; not on the critical path.

### 8.1 Live routing state (probed 2026-10-05)

Cloudflare carries a wildcard `*.globie.earth`, so **every** subdomain resolves to the origin, and an unrouted hostname answers the Easypanel edge's HTML 404 (a dark Nunito "Not Found" page) rather than failing DNS. That is why an unrouted service reads as "the app is down" instead of "the hostname was never added". Probe the service's *own* health route, never `/`, to tell the two apart — `/` 404s on a healthy Fastify service too.

| Hostname | Service | Probe | Result | State |
|---|---|---|---|---|
| `globie.earth` | `web` | `/` | 200 `text/html` | routed |
| `api.globie.earth` | `rest` | `/` | 200 `application/openapi+json` | routed |
| `auth.globie.earth` | `auth` | `/health` | 200 `application/json` | routed |
| `studio.globie.earth` | `studio` | `/v1/studio/health` | 200 `{"ok":true,"provider":"up"}` | routed |
| `podcast.globie.earth` | `podcast` | `/v1/podcast/health` | 200 `{"ok":true,...,"feeds":336765}` | **routed** |
| `mcp.globie.earth` | `mcp` | `/health` | 200 `{"ok":true,"protocolVersion":"2025-11-25",...}` | **routed** |
| `mcp-client.globie.earth` | `mcp-client` | `/index.html` | 200 `text/html` (5277 B) | **routed** (re-probed 2026-10-05) |

**Correction to the Phase 3 note:** `studio.globie.earth` is **not** down. Its root path answers a JSON 404 because a Fastify service has no `/` route; its real health route answers 200. `podcast` and `mcp` are now routed too. **`mcp-client` is also deployed and routed** — it serves the real "Globie Earth — MCP client" HTML, and a CORS preflight on `https://mcp.globie.earth/mcp` from `Origin: https://mcp-client.globie.earth` returns `204` with the origin allowed, so the browser host can reach the server end-to-end.

**How the domains got added — the panel API, not a manual step.** Earlier drafts of this section claimed "there is no CLI and no API token on this machine". That was wrong: the Easypanel panel exposes an API at `https://51.159.81.116/api/<operationId>`, authenticated with the panel session token (`localStorage['easypanel']` → `JSON.parse(...).state.token`; the `relays` project token used this session was `cmuu6m0n700xt07o1h00h8apn`). All panel mutations — `updateAppEnv`, `updateAppSourceImage`, `createMount`/`updateMount`, `deployAppService`, `createAppService`/`destroyAppService` — are `POST`s to that origin; reads are `GET /inspectAppService`, `/inspectProject`, `/listVolumeMounts`, `/getDockerContainers`, `/listProjectsAndServices`. This is the access path for every routing/deploy change; no SSH and no panel clicking were required.

**Per-service volume namespacing (learned this session — bit us once).** Easypanel namespaces Docker volumes per service: a mount named `podcast_index` on service A becomes `relays_globie-A_podcast_index`, and the *same* mount name on service B becomes `relays_globie-B_podcast_index`. Two services that declare the same mount name therefore get **two different volumes** and do **not** share storage. That is exactly why the one-shot `globie-maintenance` container seeded `relays_globie-maintenance_podcast_index` while the `podcast` service read `relays_globie-podcast_podcast_index` — the index stayed empty and `/health` reported `feeds:null`. The fix was to repoint the maintenance mount at the podcast volume's host path as a **bind** mount: `POST /api/updateMount {projectName:'relays', serviceName:'globie-maintenance', index:0, values:{hostPath:'/var/lib/docker/volumes/relays_globie-podcast_podcast_index/_data', mountPath:'/data', type:'bind'}}`, then redeploy → `/health` reports `feeds:336765`. Mount shapes accepted by `createMount`/`updateMount`: `{hostPath, mountPath, type:'bind'}` | `{mountPath, name, type:'volume'}` | `{content, mountPath, type:'file'}`; `updateMount` takes `{projectName, serviceName, index, values}`.

**Gotcha when probing containers:** `GET /getDockerContainers?service=` needs the **full Swarm name** (e.g. `service=relays_globie-podcast`), not the short service name — the short name silently returns `[]`, which reads as "no container" when the container is in fact running. Also note there is **no "run job" / "exec into container"** panel operation, hence the one-shot-maintenance-container pattern above.

Re-probe the *health* routes after any domain change; a 200 on `/health` (or `/v1/…/health`) is the proof the domain reached the container. Each hostname must also be on the corresponding service's origin allow-list (`PODCAST_CORS_ORIGINS`, `MCP_CORS_ORIGINS`) or a browser caller passes preflight and then fails the real request — see the note in `infra/.env.example`.

---

## 9. Phases

| Phase | Deliverable | State |
|---|---|---|
| **0 · Compliance** | Move the Firebase key out; `git init`; harden ignores; verify first commit | **done** (key rotation still a user action) |
| **1 · MCP core** | `infra/mcp/` scaffold; Streamable-HTTP `/mcp`; device/bearer auth; `search_forest_knowledge`, `recommend_species`, `get_sanctuary_conditions` | **done** — verified with the official SDK client (initialize / tools/list / live tools/call) against a built container; `infra/mcp/scripts/verify.mjs` |
| **2 · Stateful tools** | `adopt_species`, `get_my_deeds`, `get_eco_balance`, resources, prompts | **done** — 6 tools, 4 resources, 2 prompts; `scripts/verify.mjs` green against a built server (initialize / tools / resources / prompts) |
| **3 · Audio + podcast tools** | `generate_soundscape`, `search_podcasts`, `get_trending_podcasts` (reuse the two proxies) | **done** — 9 tools at this phase; the vision `describe_photo` and Wikipedia `describe_species` tools landed afterwards, bringing the surface to 11; `scripts/verify.mjs` green through the official SDK client (`generate_soundscape` asserted mutating; `search_podcasts` round-trips). **Deployment gap closed:** `https://podcast.globie.earth` was answering an Easypanel edge 404 because the hostname was absent from the panel and the podcast index volume was empty; the service now serves a live index — `/v1/podcast/health` reports `feeds:336765`, and `/categories`, `/search`, `/featured` and `/trending` all answer 200 with real data. See §8.1 for the volume-namespacing fix. The curated `featured` shelf is still empty (`{"shelves":[]}`), so the soundscapes tab shows search + browsing rather than an editor's shortlist — a data-curation follow-up, not a routing gap. |
| **4 · Bedrock swap** | `embed.ts` behind an interface; Titan V1 default; latency/cost measured for feedback | **done (code), measurement deferred** — Titan V1 stays behind the existing interface; `scripts/bench-embed.mjs` measures the *production* path (imports the same `embedWithUsage()` the server calls) and reports p50/p95 latency + Bedrock-billed input tokens + cost at $0.10/1M. `infra/mcp/PRODUCT-FEEDBACK.md` holds the per-SDK log. **Live run pending AWS credentials** (Phase 6), so Titan's latency/cost rows are still unmeasured — the bench is built to refuse to invent them (exit 2 when the provider is off, exit 1 when a call fails). |
| **5 · Web client** | A real MCP-SDK client that lists and calls tools (runtime-hook compliance) + voice-ish UI | **done** — `infra/mcp-client/` (D1: its own tiny Vite app). Connects over Streamable HTTP with the official SDK, runs `initialize`, then renders the surface from the returned JSON Schemas. Verified: `typecheck` + `build` green (252 modules, SDK in the bundle); `scripts/verify.mjs` green against a fresh build (9 tools, 3 templates, 2 prompts, live calls); **live browser session** against a local server — handshake `globie-earth@1.0.0 / 2025-11-25`, session id, capabilities `prompts, resources, tools`, and a real `tools/call get_sanctuary_conditions` returning Open-Meteo modelled fields. The Transcript tab exports the session JSON as the runtime-hook evidence. **Fixed this phase:** the `/mcp` route `hijack()`s the reply, so `@fastify/cors` headers were dropped on the real POST (preflight passed, browser then blocked the reply) — `forward()` now re-applies the CORS headers to `reply.raw` before hijacking. |
| **6 · Deploy + submit** | AWS host live; README run instructions; video; product feedback; Devpost fields | **in progress** — client deploy wiring done: `infra/mcp-client/` gains a `Dockerfile` (Node build stage → nginx) + `nginx.conf` + `.dockerignore`, and an `mcp-client` service in `infra/docker-compose.yml` (nginx static, loopback `${MCP_CLIENT_PORT:-8082}:80`, mirroring `web`); `MCP_CORS_ORIGINS` in `infra/.env.example` now carries the client's live origin. Verified: image builds (252 modules) and the container serves `index.html` `no-cache` / hashed assets `immutable` / SPA fallback 200. `globie.earth` runs `tradex367/globie-earth:20261004-193459` (registry creds wired) and its served bundle carries `podcast.globie.earth`, `api.globie.earth` and `studio.globie.earth`; `mcp.globie.earth/health` answers `200 {"ok":true,"protocolVersion":"2025-11-25","proxies":{"studio":true,"podcast":true},...}`. **Routing resolved (§8.1):** `podcast`, `mcp` **and `mcp-client`** are all routed and healthy (`mcp-client.globie.earth` serves the real client HTML and passes a CORS preflight against `mcp.globie.earth/mcp`). **Deploy update (2026-10-14):** the Nova-capable build is verified locally — `scripts/verify.mjs` green (all check groups) against a built server on `:8099` wired to the live `api/studio/podcast.globie.earth` origins; the `mcp` + `mcp-client` images (only) were pushed to `tradex367/globie-mcp` / `tradex367/globie-mcp-client` at tag `20261014-145553` (+ `latest`; digests `sha256:e836a577…` / `sha256:0b7098b0…`); podcast, speech and all other services were left untouched. `mcp.globie.earth/health` still reports the older **2-model** router (`ROUTER_MODELS` locally has 4, incl. `amazon.nova-lite-v1:0` / `amazon.nova-pro-v1:0`), so the live flip lands on the next Easypanel repoint. Remaining: turn on live embeddings (AWS creds + Titan V1 so `search_forest_knowledge` actually answers), optionally set `MCP_BEARER_TOKEN`/`MCP_DEMO_DEVICE_ID`, submission video + Devpost fields, `git init` + public repo + `LICENSE`, and the deferred Bedrock bench once AWS credentials exist. |

**Verification per phase:** the MCP server must answer an MCP `initialize` + `tools/list` + a live `tools/call` from the official SDK client, not just curl. Phase 5's client is the end-to-end proof.

---

## 10. Submission compliance checklist (Alexa+)

- [ ] Self-hosted **MCP server**, spec **≥ 2025-11-25**, **Streamable HTTP** — version pinned explicitly, not left to an SDK default
- [ ] The track tech is **imported and actually called at runtime** — the web client is a genuine MCP client, so this is satisfied by construction
- [ ] Public HTTPS endpoint live at submission time
- [ ] GitHub repo with **all source + assets + setup/run instructions**; **this submission = public + an `LICENSE` at the root** (required by D5 = Option A — a private repo cannot be "open source"), and the six Amazon users + `testing@devpost.com` added as collaborators at submission time as a courtesy
- [ ] Demo **video < 3 minutes**, public on YouTube/Vimeo, English, shows the MCP client driving the server
- [ ] **Product feedback** on *every* tool/API/SDK: MCP TypeScript SDK, Amazon Bedrock, PostgREST, GoTrue, Fastify, Open-Meteo, OpenStreetMap-free services, Podcast Index, Suno — what worked, what needs work, onboarding, would-you-build-again
- [ ] Track = Alexa+; mini challenges = **AWS Builder + Open Source** (D5 = Option A: the submission repo is the OSS entry)
- [ ] Explain what is **new during the window** (all of it — the MCP server did not exist before)
- [ ] Optional but worth it: **feature requests** + **friction log entries** (up to **10% judging bonus**)

**Open Source mini challenge — decision D5 is locked (Option A).** The submission repo *is* the open-source project: it is published under a license, and the MCP server did not exist before the window, so it is a new project in its own right — which is what the challenge accepts ("a new licensed repo, *or* a branch/fork/PR to a public repo"). The Devpost fields still need: repo URL, license, GitHub username, and a short description. This is the artifact we submit.

*Optional stretch (does not change the submission unless it lands).* A single PR to `modelcontextprotocol/typescript-sdk` would upgrade the story. Two candidates from the friction log, both verified in the shipped v1.32.0 package:
1. **Document the absolute-URI requirement** in `registerResource` and/or improve the `-32603 Invalid URL` that `resources/read` throws — the SDK calls `new URL(request.params.uri)` *before* dispatch (`server/mcp.js`), so a bare `species/1` fails before any handler runs and the message points at the transport, not the URI. The JSDoc for `registerResource` never states the URI must be absolute.
2. **Document the `resources/list` naming semantics** for templated vs. static resources, which currently coexist under two undocumented rules.

**Targeting:** `main` is now SDK **v2** (`@modelcontextprotocol/server` / `/client`, spec `2026-07-28`); the monolith this project builds against lives on the long-lived **`v1.x`** branch, so a v1 fix (the above) must be opened against `v1.x`. Upstream is **currently limiting PRs to 1 per new contributor** while v2 settles and steering feedback to issues, so a PR is possible but not guaranteed to land. The 10% friction-log bonus is earned by `PRODUCT-FEEDBACK.md` regardless.

---

## 11. Hackathon reference (facts, not interpretation)

| Item | Value |
|---|---|
| Submission period | Aug 31, 2026 → **Oct 23, 2026, 12:00 pm PT** |
| Deadline in local time | **Oct 24, 2026, 02:00 (Asia/Bangkok)** |
| Judging | Nov 9 – Nov 20, 2026 · Winners ~Dec 3, 2026 |
| Judging criteria | Tech Implementation · Design · Potential Impact · Quality of the Idea |
| Prizes (Alexa+) | **$25,000 / $15,000 / $4,000** (+ AWS credits, DevRel meeting, Amazon featuring) |
| Mini challenge prizes | AWS Builder **$5,000** · Open Source **$5,000** |
| AWS credits | $150 promotional credits requestable via the form, by **Oct 21, 2026 12pm PT** |
| Alexa+ requirement | Agent Skill **or** self-hosted MCP server (spec ≥ 2025-11-25, Streamable HTTP); simulated web experience is the sanctioned alternative |

---

## 12. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Web client as a **separate tiny app** vs. a route inside the existing `web` build | Separate tiny app — keeps the runtime hook unmistakable and the demo clean |
| **D2** | MCP host: AWS (A) vs. our own Easypanel stack (B) | **Locked — B: we self-host** the MCP server (`mcp.globie.earth`). AWS Builder is satisfied by Bedrock alone; AWS hosting is an optional later lift. |
| **D3** | Embedding provider: **self-hosted multilingual-e5-small (384)** vs. Bedrock **Titan V1 (1536)** | **Self-hosted (default)** — needs no AWS account and no re-embed gate on the critical path; Titan V1 stays selectable behind `EMBEDDING_PROVIDER=bedrock` for the AWS Builder story |
| **D4** | MCP client auth: **static bearer (demo)** vs. **full MCP OAuth** | Static bearer, stated honestly; OAuth noted as the production path |
| **D5** | Open Source mini challenge: reuse the MCP repo vs. a separate contribution | **Locked — A: the submission repo *is* the open-source project**, published under a license. The repo must be public + carry a visible license for the standard Devpost fields anyway, and the MCP server did not exist before the window, so it is a *new* OSS project in its own right (exactly what the challenge accepts). **Option B is kept only as an optional stretch** (see §10) — a single PR to `modelcontextprotocol/typescript-sdk` must now target the long-lived **`v1.x`** branch (`main` is the 2.0.0 split-package line), and upstream is **currently limiting PRs to 1 per new contributor** while v2 settles, so it is not the guaranteed artifact. The friction-log 10% bonus is earned either way. |
| **D6** | Search relevance: leave `search_forest_knowledge` as pure cosine vs. add an AI rerank stage | **Add a listwise rerank** over a wider candidate pool, using the server-side DeepSeek key already wired for the router/vision — it **reorders only** the rows the database returned, so it can improve the answer but can never fabricate one (§16). Keep it default-on, degrade to the cosine order on any failure, and keep a local cross-encoder (`bge-reranker-v2-m3`) as the future no-egress upgrade. |

---

## 13. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Spec drift** — MCP `2025-11-25` is newer than most SDK defaults and examples | High | Pin the version explicitly; test `initialize` negotiation against a current client; keep the server's advertised `protocolVersion` in one constant |
| **Runtime-hook failure** — "MCP named in README but never called" is an explicit disqualifier | High | Phase 5's client is a real MCP client; ship a transcript/log in the repo as evidence |
| **Leaked Firebase admin key** published with the repo | High | Phase 0 rotation + ignore rule before *any* push; see §7 |
| **Collaborator invites expire (7 days)** | Medium | Invite the six Amazon users + `testing@devpost.com` at submission, not in advance |
| **Streamable HTTP on serverless** — Lambda request/response streaming quirks | Medium | Prefer App Runner/ECS (long-lived container) over Lambda for the MCP endpoint |
| **Bedrock region/model availability** | Medium | Confirm `amazon.titan-embed-text-v1` is enabled in the chosen region before Phase 4; keep a provider flag so the demo can fall back |
| **Schedule** — ~19 days to the deadline, critical path is MCP server → client → video | High | Compliance + MCP core first; audio/podcast tools are droppable if time runs short |
| **Product feedback is mandatory, not optional** | Medium | Log friction *as each phase is built*, not retroactively; this is also the 10% friction-log bonus |

---

## 14. Definition of done (submission)

An MCP client (the Phase 5 web app) connects to the deployed server over Streamable HTTP, lists the tools, and successfully calls `search_forest_knowledge`, `recommend_species`, `adopt_species`, and `get_sanctuary_conditions` against real Globie data — captured in a < 3-minute English video, with the source, README, and per-SDK product feedback in the repo.

---

## 15. Cross-track sequencing — Alexa+ first, Fire TV second (decided 2026-10-10)

**Alexa+ is submitted first; a separate Fire TV project is built and submitted afterwards.**
This plan covers **submission #1 only**. The rules allow multiple submissions when each is
*"unique and substantially different"* (a Sponsor/Devpost call), and each project can win only
one track prize + one mini challenge prize — so Alexa+ and Fire TV, being different primary
tracks, are each eligible for their own track prize.

Consequences:

- The Fire TV project must be a **distinct artifact** — its own repo, UI, code, demo video and
  product-feedback log. **This MCP server cannot double as the Fire TV submission.**
- Fire TV is **not started**: it needs a demo-ready app on Fire OS or Vega OS (any framework)
  and a demo video filmed on an actual Fire TV device or the Fire TV/Vega simulator. The
  existing Capacitor phone SPA does not run there.
- Nothing in this plan is reused as the Fire TV artifact; do not share one repo or one video
  across the two.

The Fire TV requirements, priority categories and deferred scope are recorded in
[`../PROJECT-MEMORY.md`](../PROJECT-MEMORY.md) §26.

---

## 16. Search quality — AI-enhanced retrieval (rerank) — decided 2026-10-11

**Why.** `search_forest_knowledge` is the core voice tool, and its retrieval path
was deliberately **LLM-free**: the query is embedded by the small self-hosted
model (`Xenova/multilingual-e5-small`, 384 dims) and `api.catalog_search`
returns the nearest passages, with a title-only lexical lift added by
`247_catalog_search_ranking.sql`. That fix closed the *"Yang na"* repro (the
router no longer invents an `entity_type` filter, and a row actually named
"Yang Na" is lifted above its butterfly near-neighbours). But a 384-dim e5
model's cosine floor is high and its near-neighbours differ by ~0.01, so the
**order** of the returned rows is still often wrong even when the right passage
is present in the pool — the tool is "not smart" because the first line it reads
aloud is the wrong passage, not because the answer is missing.

**What we add (D6).** One narrow, optional **listwise rerank** stage between the
`catalog_search` call and the spoken answer:

1. Fetch a **wider candidate pool** (`RERANK_POOL`, default 20) instead of 8.
2. Ask the model — the same server-side DeepSeek key the router and the vision
   tool already use — to **reorder** those candidates by how directly each
   answers the listener's question, returning `{"order": [...]}` at
   `temperature 0`.
3. Answer from the reranked **top 8** (`SEARCH_RESULTS`).

The stage **only reorders rows the database already returned** — it never adds a
passage, so a rerank can improve the answer but can never fabricate one. This is
the honesty house rule (§1.1) applied to ranking.

**Graceful degradation (the whole point).** Any failure — no `DEEPSEEK_API_KEY`,
timeout, non-200, malformed JSON, or an `order` that is not a full permutation —
returns `null`, and the tool keeps the cosine order and reports
`ranking: "cosine"`. A candidate the model omits is appended in its original
position, so the pool is always whole and no row is ever dropped. The response
carries `ranking: "reranked" | "cosine"` (and the rerank model when it ran), so
the enhancement is never claimed when it did not happen.

**Config (all optional, all server-side — never a `VITE_` var):**

| Var | Default | Meaning |
|---|---|---|
| `RERANK_ENABLED` | `true` | Turn the rerank stage on/off; off = exact pre-§16 behaviour |
| `RERANK_POOL` | `20` | Candidate rows fetched before reranking and sliced to 8 |
| `RERANK_TIMEOUT_MS` | `20000` | Per-call budget; expiry falls back to cosine |
| `SEARCH_LATENCY_BUDGET_MS` | `0` (none) | Latency ceiling for a whole search; a rerank whose own cap exceeds it is skipped and the in-process cosine order stands (§21 Phase 3) |
| `DEEPSEEK_RERANK_MODEL` | `DEEPSEEK_MODEL` | Optional separate rerank model |

**Timeout tuning (production, 2026-10-11).** The first shipped default was
`8000`, and it was wrong: a live VPS→DeepSeek rerank measured **~9 s**, so every
production call hit the abort and the tool silently reported `ranking: "cosine"`
while the local smoke test (6.7 s) passed. The default is now **20000**, matching
the router's `TIMEOUT_MS` — the router was already tuned to 20 s for the same
upstream path. `RERANK_POOL` stays 20. Re-verified live after the fix:
`search_forest_knowledge "Yang na"` returned `ranking: "reranked"` with "Yang Na"
first (image `tradex367/globie-mcp:20261011-172053`). DeepSeek latency is
variable (12–16 s on success, occasional >20 s hangs) and pool size is not the
driver, so an occasional `ranking: "cosine"` fallback is expected and correct.

**Scope.** Step 1 of the enhancement analysis only. The other options —
query-rewrite/HyDE, grounded spoken-answer synthesis, offline alias/content
enrichment + re-embed, and an LLM-as-judge eval harness — stay **planned, not
built**, in that rough priority order. A **local cross-encoder**
(`BAAI/bge-reranker-v2-m3` via transformers.js) is the no-egress upgrade to the
same seam: it would need no re-embed (unlike swapping the embed model) and no
new key, but it is heavier on the CPU-bound VPS, so DeepSeek ships first behind
the interface this section defines.

---

## 17. Voice → DNP: making "Ask the forest by voice" answer from the DNP reference data

**The problem, stated precisely.** `search_forest_knowledge` already searches the
DNP tables: with no `entity_type`, `catalog_search` runs over one cosine space
holding Globie's catalogue **and** all four DNP datasets (`dnp_species`,
`dnp_plant`, `dnp_fauna`, `dnp_wildlife`). So the DNP data *is* reachable by
voice. It fails at the two ends of the loop instead — the **ear** is English-only
and mangles the Thai names the DNP rows carry, and the **mouth** reads only the
single closest passage and labels its source for just two of the four DNP kinds.
The router, meanwhile, is deliberately *indifferent* to DNP (its prompt forbids
inventing a filter), so nothing lets a listener aim at the DNP on purpose.

Five changes, in the order they were built.

**17.1 Speak the source for all four DNP datasets, not two.** The provenance
sentence was built only for `dnp_species` and `dnp_plant`, so a `dnp_fauna` or
`dnp_wildlife` answer — the "what does Thai law protect" case the tool
advertises — came back sounding like a Globie catalogue entry. One
`sourceSentence(entityType)` now names every kind: Globie's own catalogue, the
DNP biodiversity survey, the DNP national plant checklist, the DNP park fauna
observations, and the DNP national wildlife checklist.

**17.2 Speak a DNP hit even when it is not the closest.** The spoken line read
`top[0]` alone, so a DNP row in the answered set was in the payload and silent
whenever a Globie row ranked first — which the rerank makes the common case. The
spoken line now appends one sentence naming the best DNP hit when the closest
passage is not itself DNP: *"The DNP reference data also has …"*. The keyword
fallback says the same, so both paths stay honest in the same way.

**17.3 Multilingual ears.** `SPEECH_STT_MODEL` defaulted to
`Systran/faster-whisper-base.en`, which cannot output Thai at all — the DNP
tables carry Thai (`thai_name`, `protected_area`, provinces), so a spoken Thai
name was transcribed as an English approximation and the query never contained
it. The default is now the **multilingual** `Systran/faster-whisper-base`: the
same size class as `base.en`, but able to represent the DNP names. It is the
first rung of an accuracy ladder — `faster-whisper-small` and
`faster-whisper-large-v3-turbo` are better on Thai and are a one-line change once
the speech container's RAM is confirmed (the local Docker Desktop VM that sized
the original default is ~958 MiB and OOM-killed `small`).
`infra/speech/Dockerfile` bakes the new model and `docker-push.sh` asserts it.

**17.4 A positive DNP trigger in the router.** With the filter discipline kept
(the router still only sets `entity_type` when the listener names that kind), the
system prompt now states that the DNP reference data is part of the same search
and names the mapping from listener words to datasets: "the plant checklist" →
`dnp_plant`, "the biodiversity survey" → `dnp_species`, "the wildlife /
protected-species checklist" → `dnp_wildlife`, "animals recorded in a park" →
`dnp_fauna`. A generic DNP question sets no filter, so the DNP rows are searched
alongside the catalogue rather than instead of it.

**17.5 An explicit Source control in the voice panel.** The mcp-client's voice
panel gains a **Source** selector — *Any source (Globie + DNP)* plus the four DNP
datasets. When a dataset is chosen, `ask()` fills `entity_type` into the call, but
**only** when the chosen tool's own schema declares that argument, so a source
selection can never break a tool that has no such filter. This is the one lever
the router was told never to invent, held by the listener instead.

**Honesty note.** Every change above only makes the DNP data the database already
returned *audible* and *reachable*; none adds a passage, and the spoken line
still names where each answer came from (§1.1).

## 18. Submission packaging — the public repo is Alexa+ only, API-backed (decided 2026-10-11)

**The problem.** The repo pushed at §31 of PROJECT-MEMORY (`iromath/globie-earth`)
is the *whole product*, not the submission: 531 files ~78 MB, with the mobile app
(`android/`, `src/`, `public/`, `assets/`, `scripts/`) on top of a hybrid root
README whose first 20 lines are stale Google AI Studio boilerplate ("Run and
deploy your AI Studio app"). A judge lands on the AI Studio banner and the
Alexa+ MCP — 47 files under `infra/mcp` — is buried three folders down. The task
is to re-scope the public repo to the Alexa+ track alone, and to make it boot.

**18.1 Shape: A2 — runnable, leaner.** The repo must let a judge `docker compose
up` the MCP and drive it, but it does **not** ship the `studio` / `podcast`
service source. Those two are reached over HTTP like everything else (§4, and
`infra/mcp/src/proxy.ts`), so the `mcp` service points at their live origins and
`generate_soundscape` / `search_podcasts` / `get_trending_podcasts` keep working.
This keeps all 53 tools live while dropping two service trees.

**18.2 Every byte of data comes over an API (user directive, 2026-10-11).** No
local seeding and no committed data. The local Postgres is *not* part of the
judge run. All three MCP origins point at the live stack:

```
MCP_POSTGREST_URL=https://api.globie.earth      # species, guardians, sites, deeds, DNP
MCP_STUDIO_URL=https://studio.globie.earth      # soundscape
MCP_PODCAST_URL=https://podcast.globie.earth    # podcasts
```

The **DNP species data is not a fourth origin** — it is rows inside PostgREST,
world-readable ([`120_dnp.sql`](../infra/schema/120_dnp.sql) narrows the anon
grant to `select`), so `search_forest_knowledge` reads the real 61k survey rows
through `api.globie.earth` exactly as studio/podcast are read.

**18.3 A snapshot in the repo was considered and rejected.** Committing a dump of
`api.dnp_species` (offline, deterministic, no secret) was the recommendation
until the directive in 18.2; the embeddings blob alone would be ~90 MB (61k ×
384d) and the directive settles it in favour of the live API.

**18.4 What ships, what is dropped.**

- **Kept:** `infra/mcp/` (server + `scripts/`), `infra/mcp-client/`,
  `infra/schema/` (**as the API-contract reference only** — the tables, RLS,
  functions and RPCs the live API exposes; not loaded at boot),
  `infra/docker-compose.yml`, `infra/.env.example`, `LICENSE`, rewritten
  `README.md`, `infra/mcp/README.md`, `infra/mcp/PRODUCT-FEEDBACK.md`.
- **Dropped — the mobile app:** `android/` (64), `src/` (126), `public/` (124),
  `assets/` (34), `scripts/` (20), `base/`, `index.html`, `metadata.json`,
  `capacitor.config.json`, root `package.json` / `package-lock.json`,
  `vite.config.ts`, `tsconfig.json`, `privacy-policy.html`.
- **Dropped — other events / services:** `SUBMISSION_PLAN.md` (RevenueCat
  Shipaton 2026), `DEVELOPMENT_PLAN.md`, and the non-MCP service dirs
  `infra/web`, `infra/revenuecat`, `infra/studio`, `infra/podcast`,
  `infra/maintenance`, `infra/db`.
- **`docker-compose.yml` is trimmed** to the `mcp` + `mcp-client` services; the
  `db` / `rest` / `auth` / `speech` / `minio` / `studio` / `podcast` /
  `revenuecat` / `web` blocks are removed with the data layer 18.2 moves to the
  live origins.

**18.5 Trade-offs accepted.** No offline mode — if globie.earth is down the local
demo returns nothing (that is what 18.2 buys). The demo edge token
(`MCP_BEARER_TOKEN` → `MCP_DEMO_DEVICE_ID`, decision D4) ships in the public
`README`/`.env.example`; it is bounded to the single demo device, and the two
mutating tools therefore write only to that device on the live stack.

**18.6 Destination and execution.** Delete `iromath/globie-earth` and recreate it
with the **same name** so the Devpost repo URL stays stable. Then: build the
curated tree → rewrite the root `README.md` to lead with the Alexa+ MCP
(transport, the pinned `2025-11-25`, the 53 tools, `mcp.globie.earth`) and demote
the AI Studio line to a provenance footnote → **show the README draft to the user
before pushing** → commit → `git push -u origin main` → verify public +
secret-clean.

---

## 19. Amazon Bedrock Nova as a chat/vision provider (alongside DeepSeek) — built 2026-10-14

**Why.** The submission-facing `APPLICATION.md` already claims that "Amazon
Bedrock/**Nova** [is] wired behind env config". Until now only Bedrock **Titan
*embeddings*** were wired (`infra/mcp/src/embed.ts`); no **Nova** chat/vision
model was reachable at all. This section makes the Nova half of that claim true
**without removing the DeepSeek path**: Nova becomes a *selectable* provider for
the four surfaces that already call a chat model, chosen per request (router) or
per env selector (the rest).

**The four surfaces** — all were DeepSeek-only, all are now provider-neutral:

| Surface | File | What it asks the model for |
|---|---|---|
| `/route` tool router | [`router.ts`](../../infra/mcp/src/router.ts) | function-calling: which tool, with which arguments |
| `describe_photo` | [`tools/photo.ts`](../../infra/mcp/src/tools/photo.ts) | vision: describe an attached photo |
| listwise rerank (§16) | [`rerank.ts`](../../infra/mcp/src/rerank.ts) | reorder the `catalog_search` pool as `{"order":[…]}` |
| `/contribute` scan | [`contribute.ts`](../../infra/mcp/src/contribute.ts) | vision + JSON: rate a contributed photo safe/on-subject |

**The seam — [`infra/mcp/src/llm.ts`](../../infra/mcp/src/llm.ts) (new).** One
interface — `chat({ provider, model, request, timeoutMs })` — over a neutral
request/response shape (`LlmRequest` / `LlmResult`), dispatching to either an
OpenAI-compatible `/chat/completions` call (DeepSeek) or Bedrock's **Converse
API** (`ConverseCommand`, Nova). It mirrors the provider pattern `embed.ts`
already established, and reuses the *same* lazy `BedrockRuntimeClient` and env
credentials. `deepseek.ts` was slimmed to just `deepseekConfig()`; all
allowlist/vision constants now live in `llm.ts`.

**Decisions taken this session:**

| Decision | Value |
|---|---|
| Provider selection on `/route` | **Per-request model id** — the caller names an id from `ROUTER_MODELS`, each tagged with its provider, so one call routes to DeepSeek and the next to Nova. A name off the list is `400`, never forwarded. |
| Provider selection where the caller names no model | **`VISION_PROVIDER`** (describe_photo + `/contribute`) and **`RERANK_PROVIDER`** (rerank), both defaulting to `deepseek`. Read per request. |
| Nova timeout | **Abort signal passed per send** — `client.send(cmd, { abortSignal })` on Nova, `fetch(…, { signal })` on DeepSeek, from one `AbortController` + `setTimeout`. Budgets unchanged (router `20 000`, vision `30 000`, rerank `RERANK_TIMEOUT_MS`). |
| Default Nova model | **`amazon.nova-pro-v1:0`** (overridable with `NOVA_MODEL`). |
| Credentials | Reused from the Titan provider — `BEDROCK_REGION` / `AWS_REGION` + `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Off AWS (D2) there is no instance role. |
| Failure mode | **Fail closed** — a Nova-targeted call without credentials is a clear `503` naming them (never a boot failure); a `/route` `503` borrows the same wording the DeepSeek path uses. |

**The router allowlist** (`ROUTER_MODELS`, mirrored in the
`infra/mcp-client/index.html` dropdown):

| Model id | Provider | Vision |
|---|---|---|
| `deepseek-flash` | DeepSeek | no (default) |
| `deepseek-v4-flash-vision-exp` | DeepSeek | yes |
| `amazon.nova-lite-v1:0` | Nova | yes |
| `amazon.nova-pro-v1:0` | Nova | yes |

**Config (all optional, all server-side — never a `VITE_` var):**

| Var | Default | Meaning |
|---|---|---|
| `NOVA_MODEL` | `amazon.nova-pro-v1:0` | Bedrock Nova model any Nova-targeted call uses |
| `VISION_PROVIDER` | `deepseek` | `deepseek` \| `nova` for `describe_photo` + `/contribute` |
| `RERANK_PROVIDER` | `deepseek` | `deepseek` \| `nova` for the rerank pass |

**Status.** **Code complete; `npm run build` (`tsc -p tsconfig.json`) green;**
all four call sites dispatch through `chat()`, and `docker-compose.yml` /
`.env.example` / `infra/mcp/README.md` / the client dropdown are wired. Nova now
also accepts a Bedrock **API key** (`AWS_BEARER_TOKEN_BEDROCK`) as an alternative
to the SigV4 key pair — the SDK selects `httpBearerAuth` on its own when it sees
the token, so `novaConfigured()` accepts either form. **Not yet verified live** —
this sits behind the *same* AWS gate as Titan (§9 Phase 4): the new account's
Bedrock data plane is gated (`ValidationException: Operation not allowed`, support
case `179122138300151`).

**Root cause (deep-dive, 2026-10-14).** Not region, not IAM, not model id, not
credentials: a direct `Converse` probe with the repo IAM creds fails
`Operation not allowed` for `amazon.nova-lite-v1:0` *and* `amazon.nova-pro-v1:0`
in `ap-southeast-2`, exactly as it did across every other region / model /
inference-profile tested. Two AWS-side causes match: (a) a brand-new account's
Bedrock is blocked until quota is provisioned or a first charge settles — the
matching AWS re:Post cases (incl. an identical `ap-southeast-2` report) show the
Service Quotas page at **RPM = 0 / TPM = 0** for every Nova model and resolve only
via Support or a processed charge; (b) the account is on the auto-enrolled **Free
plan**, which is *"Limited to select services only"* and *"Not eligible"* for
promotional credits — Bedrock's newer capabilities are **Paid-plan**. Either way
the fix is account-side (upgrade to the Paid plan at AWS Settings → *Upgrade
plan*, or have Support allocate quota), not a repo change. Until then this section
claims **no** live Nova call, and the Nova rows in `PRODUCT-FEEDBACK.md` and any
Nova latency/cost bench are **pending credentials**.

**Resume point (next session):**

1. Once Bedrock is enabled: set `VISION_PROVIDER=nova` / `RERANK_PROVIDER=nova`
   (or name `amazon.nova-pro-v1:0` on `/route`) and run
   [`scripts/verify.mjs`](../../infra/mcp/scripts/verify.mjs) against a built
   server; confirm `/health` reports the provider and a live `describe_photo` /
   reranked `search_forest_knowledge` answers *from Nova*.
2. Log the Nova/Bedrock friction in `PRODUCT-FEEDBACK.md` from that run
   (Converse API setup, docs, latency vs. DeepSeek).
3. Optional: a Nova leg on the bench, mirroring `scripts/bench-embed.mjs`'s
   refuse-to-invent rule (exit non-zero rather than report an invented number).
4. ~~Deploy via `docker-push.sh` once locally verified.~~ **Done (2026-10-14):**
   local `scripts/verify.mjs` green; only `mcp` + `mcp-client` pushed to
   `tradex367/globie-mcp` / `tradex367/globie-mcp-client` at tag `20261014-155700`
   (+ `latest`) — digests `sha256:15d82d70…` / `sha256:0b7098b0…`. Built the two
   images directly rather than via `--only-mcp`, because that flag also rebuilds
   and re-pushes podcast and speech, which are live and must stay untouched. This
   tag carries the credential change above (Nova accepts `AWS_BEARER_TOKEN_BEDROCK`).
   The live flip needs an Easypanel repoint of the `mcp` and `mcp-client` services
   to this tag; podcast/speech and all other services are already live and untouched.
5. On the **live Easypanel `mcp` service**, add `BEDROCK_REGION=ap-southeast-2`
   plus either the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pair or an
   `AWS_BEARER_TOKEN_BEDROCK` API key, then repoint to the image carrying the
   API-key support. `.env` already pins `BEDROCK_REGION=ap-southeast-2`; the live
   panel env is a manual step (no panel token in the repo).

---

## 20. Alexa+ design guide + client lifecycle — deep analysis and compliance gap (analyzed 2026-10-15)

**Sources read (external, read-only):** the two requested pages plus the child
pages they link to, so the analysis is of the whole doc tree, not a hub page.

| Page | What it is |
|---|---|
| [`mcp-addon-design-guide`](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-design-guide.html) | **A contents hub** — its substance is the 11 child pages below |
| [`mcp-toolkit-client-lifecycle`](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html) | The **wire spec**: registration, `initialize`/`tools/call` payloads, session, elicitation |
| Design-guide children | `-guide-overview`, `-conversation-surface`, `-display-modes`, `-layout-and-rendering`, `-visual-foundations`, `-components-and-patterns`, `-tools-schema-data-design`, `-brand-expression`, `-accessibility`, `-test-addon-cx`, `-store-listing`, `-glossary` |
| Prerequisites the lifecycle links | [`mcp-toolkit-quickstart`](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html), [`mcp-toolkit-authentication`](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html) |

**Why this section exists.** §10 is the *hackathon* checklist (what Devpost
asks). This section is the *platform* checklist — what Alexa+ itself requires of
an add-on before it will render it well and pass certification. It does not
change any decision; it records what the code already does and what it does not.

### 20.1 The design guide, digested

**The model.** Alexa+ is the **MCP client**; we are the server. Alexa owns
routing, disambiguation between competing add-ons, the spoken reply, continuity
across interruptions, and rendering of data-only responses natively. We own tool
logic + returned data, our UI payload (if any), brand expression within their
tokens, and the enter/exit-fullscreen controls. Customers reach us by **named
invocation** ("Alexa, open *…*").

**Four principles** (the whole design language in four lines):

1. **End-to-end task completion** — finish the task in-conversation; collapse
   "10 taps / 3 screens" to the 2–3 inputs that truly need the customer.
2. **Simple, glanceable metadata** — one title, one or two supporting fields, one
   clear action. Phone-density reads as noise at Echo-Show distance.
3. **Text for far-field reading** — the **1.6 typography scaling ratio** (exact
   **1.667** for Show 8/15, 1280×800 from a 768×480 base), short declarative copy.
4. **Coherence with Alexa's design language** — adapt tokens/spacing/patterns;
   brand only where it earns it (accents, badges, primary actions).

**Conversation surface.** Turn-based. **We influence what Alexa says through the
data we return — we never script it.** Each response must be self-contained while
assuming Alexa weaves it into a longer, possibly multi-add-on conversation.

**Display modes.**

| Mode | When | Note |
|---|---|---|
| **Inline** (default) | confirmations, summaries, single-decision flows | default for *any* response with a UI payload |
| **Fullscreen** | games, pan/zoom, dense lists/charts, multi-step | *not a separate surface* — same experience, more room; **we** provide the expand control |
| **Hydrated** (default when no UI payload) | data-only | Alexa renders our data through native components |
| **Voice-only** (always-on baseline) | screenless devices | data must be intelligible unshown and **free of formatting artifacts like pipes** |

**Layout & rendering.** Alexa scales our payload to the device itself — no
per-device design. Two viewports: **Block** (wider than tall → horizontal; the
recommended native treatment) and **Card** (taller than wide → vertical; web-first,
adapt to Block). Orientation alone decides. The host delivers a **`hostContext`**
object at render time (`deviceClass`, `maxWidth`, `maxHeight`, `isMobile`,
`platform`, `displayMode`, `safeAreaInsets`, `deviceCapabilities`, `theme`) over
the MCP Apps postMessage bridge; resolve once to one breakpoint on the root
element, re-resolve on `host-context-changed`, and treat **`deviceClass` as
authoritative**. The widget runs in a **sandboxed, possibly opaque-origin iframe**
— no `window.parent`, no `localStorage`/cookies; the bridge is the only channel;
network reach is declared in CSP via `_meta.ui.csp` (`connectDomains` /
`resourceDomains`) and **everything undeclared is blocked**. Ship one
self-contained, gzipped HTML bundle at a **content-hashed `ui://` URI**.

**Visual foundations — the exact tokens.**

| Group | Values |
|---|---|
| Typography | Display1–5 **48/40/32/28/24**, Headline1–2 **20/18**, Body1–3 **16/14/12**, Label1–2 **10/8** |
| Spacing | **2 / 6 / 8 / 12 / 16 / 20 / 24** |
| Shape | **4 / 8 / 12 / 16** + `shapeCircle` 9999 |
| Icon | **16 / 20 / 24** |
| Card color | dark `default-normal #14181E`, `nested-inner #1B2028`; light `default-normal #FFFFFF`, `nested-outer #FAF9FB`, `nested-inner #FFFFFF`; dark primary button `#2D415E`, secondary `#232F40` |

Rule: author at **768×480**, apply **one root scale** (`zoom: 1.667` for Show
8/15) — never per-surface pixel hacks. Must support light **and** dark, and
survive **Color Correction / Color Inversion**.

**Components — four shapes, no inventing.** **List** (vertical, homogeneous;
optional Header + Selection Controls; "See More" overflow), **Carousel**
(horizontal; **3–5 items inline, first within 500 ms**, strongest first),
**Card** (image + optional CTA; card-tap = navigate, CTA-tap = inline action),
**Map** (ranked POIs + our map; compact inline = map left / 3 results right with
numbered badges; expanded fullscreen = 4–6 results; map/media canvases
**counter-scale** or they double-scale). **Closing the loop:** transactional
email within minutes; return **enough structured data** for Alexa to build a
meaningful notification (`{status, property, check_in, confirmation_number}` beats
`{status:"success"}`); keep recall questions answerable by including IDs/dates.

**Brand / accessibility / store listing.** Logo: data-only MCPs are placed by
Alexa; UI MCPs use horizontal (top-left inline, top-center fullscreen). Required
assets: horizontal 80px-height and square 120×120, each light+dark. Accessibility:
input parity (whole task via voice-only *or* touch-only); survive VoiceView,
Magnifier, Color Correction/Inversion; **touch targets ≥48×48**; contrast
**≥4.5:1** (≤17px) / **≥3:1** (bold or ≥18px), visuals ≥4.5:1; ≤3 flashes/sec;
**alt text ≤125 chars**; test on device. Store listing: one category; **name =
invocation name**; tagline 6–8 words as an action; short description = what the
customer would say; **every sample utterance must work spoken**.

**Confirmed against the live docs, 2026-10-15.** The Brand Expression assets are
*not* `addon.json` fields — they are uploaded during onboarding — so they live in
the repo as deliverables: [`public/addon/logo/`](../../public/addon/logo) holds the
four lockups the guide names — horizontal light and dark at 80 px, square light
and dark at 120×120 **with and without background** — each as SVG *and* PNG on a
transparent background. [`scripts/build-brand-logos.py`](../../scripts/build-brand-logos.py)
generates them: it traces the leaf out of the shipped `icon-241x241.png`, so the
logo and the store icon stay the same drawing, and outlines the Inter wordmark, so
the SVG carries no font dependency. Store listing:
[`addon-package/store-listing.md`](../../infra/mcp/addon-package/store-listing.md)
holds the category, the 6–8-word action tagline, the conversational short
description, four sample utterances (one open-ended, two intent-driven, one
follow-up/status) and the full description; whatever maps to a schema field is
mirrored into `addon.json`. Schema limits now pinned: `shortDescription` ≤123,
`fullDescription` ≤4000, `examplePhrases` 3–4 × ≤200, `carouselImages` ≥1 with
`altText` ≤250, icons required at six sizes (`dark` optional but valid at the same
six), and **`bannerImages` optional** at 1200×600 — so our empty array is valid,
not a gap.

### 20.2 The client/app lifecycle, digested

**Registration.** On deploy, Alexa+ registers the add-on, connects, and
enumerates **all** tools and resources. **Any change to tools/resources/config
requires a redeploy (`alexa-ai deploy`)** — Alexa serves cached values otherwise.
This is the single most operationally important sentence on the page.

**The exact wire payloads** (verbatim shape):

```json
// initialize request (Alexa+ → us)
{ "jsonrpc":"2.0","method":"initialize","id":"4e3bdaee-0",
  "params":{ "protocolVersion":"2025-03-26",
    "capabilities":{ "roots":{ "listChanged":true } },
    "clientInfo":{ "name":"Alexa+ MCP Client","version":"1.0.0" } } }
```

```json
// tools/call response (us → Alexa+) — the rich shape
{ "result": {
    "structuredContent": { "success": true, "count": 0, "hotels": [] },
    "content": [ { "type":"text", "text":"{\"success\": true, ...}" } ],
    "_meta": { "ui": { "resourceUri":"ui://hotel-search",
                       "invoking":"Searching hotels...", "invoked":"Found hotels" } } } }
```

So a rich response carries **three** things: `structuredContent` (machine/voice
layer), a `content` text block, and `_meta.ui` naming a **`ui://` resource URI**
plus `invoking`/`invoked` progress strings.

**Session.** Transport is Streamable HTTP. The client reviews conversation
history for previously used tools and builds a focused tool-selection prompt
before each call. Crucially, **the "session" is Alexa's memory of the customer's
prior conversations — not an explicit session identifier with our app.** If the
customer is account-linked, our server may return more personalized results.

**Resources & elicitation.** All files must be referenced by their designated
paths. On an **elicitation** request Alexa first tries to gather context itself,
falling back to the MCP elicitation framework only when the customer
under-specifies. **UI decision rule:** `_meta.ui.resourceUri` present → Alexa
renders *our* visual; absent → **data-only "hydration"**, Alexa renders natively.

**Auth — two tiers, and the hard requirements.** Tier 1 = `client_credentials`
(M2M, `mcp:service` scope, token ≤3600 s, **no** refresh token) for
registration/`tools/list`/health. Tier 2 = `authorization_code` + PKCE (`S256`)
for user-level `mcp:tools`/`mcp:resources`, entered **only when a user-specific
tool is invoked**. The Quickstart's discovery checklist is mandatory: a **401
without `WWW-Authenticate`**, a **PRM document at the RFC 9728 well-known URI**,
auth-server metadata at **`/.well-known/oauth-authorization-server`**, and
**`code_challenge_methods_supported` must include `S256`**. Bearer goes in the
`Authorization` header, never the query string. **Not supported:** DCR, CIMD,
OIDC, step-up auth, `WWW-Authenticate` on 401. **Performance: round-trip
< 500 ms.**

### 20.3 Compliance matrix — `infra/mcp` vs. the Alexa+ platform requirements

Grounded against [`infra/mcp/README.md`](../../infra/mcp/README.md) and
[`infra/mcp/src/server.ts`](../../infra/mcp/src/server.ts). Tool count is **13**
today (the README's figure; §3/§9 predate the last two tools).

**Already compliant:**

| Requirement | Evidence |
|---|---|
| Streamable HTTP (no legacy SSE) | `POST /mcp` (+`GET`/`DELETE`); `StreamableHTTPServerTransport` in [`server.ts`](../../infra/mcp/src/server.ts) |
| 401 **without** `WWW-Authenticate` | [`server.ts:184`](../../infra/mcp/src/server.ts#L184) returns a plain 401 body; no `WWW-Authenticate` anywhere (grep-confirmed) |
| Protocol version pinned | `REQUIRED_PROTOCOL_VERSION = '2025-11-25'` at [`server.ts:56`](../../infra/mcp/src/server.ts#L56) |
| One-intent tools, clear descriptions, mutating hints | 53 tools (17 Globie + 36 Openmind Travel); only `adopt_species` / `generate_soundscape` / `om_save_trip_idea` / `om_save_itinerary` mutating (`readOnlyHint:false`) |
| Voice-only safety (no pipes/JSON to the ear) | every result carries a whitespace-collapsed spoken line tagged `annotations:{audience:["user"]}` |
| "Always return something" | failures degrade to keyword search with `method`/`note` or a clear explanation — never empty |
| Personalization | `get_my_deeds`, `get_eco_balance`, `recommend_species` are identity-scoped |
| Resources + prompts declared | `globie://` templates + `forest-guide` / `adopt-a-tree` prompts |

**Missing — required before Alexa+ certification:**

| # | Gap | Detail |
|---|---|---|
| 1 | **OAuth discovery + both tiers** | No PRM doc (RFC 9728), no `/.well-known/oauth-authorization-server`, no `code_challenge_methods_supported`. Both `client_credentials` (Tier 1) and `authorization_code`+PKCE (Tier 2) are absent. §6/D4 already state the static `MCP_BEARER_TOKEN` "is not MCP OAuth 2.1" — this section pins exactly what "is" means. |
| 2 | **MCP Apps UI layer** | No `structuredContent` and no `_meta.ui.resourceUri` anywhere (grep-confirmed). The server can act as a **data-only / hydration** add-on only; the display modes, `hostContext`, sandbox CSP and content-hashed `ui://` bundles are all unbuilt. **Addressed — §21 Phase 5:** all **15** tools return the three-part rich result (`structuredContent` + `content` + `_meta.ui` with `invoking`/`invoked`) and declare `_meta.ui.resourceUri` at a content-addressed `ui://globie/<archetype>-<sha256-12>`. There are **four** documents, not fifteen — the design guide's own four components (Card, List, Carousel, Map) — each an **archetype shared by every tool whose result has that shape**, served at the required `text/html;profile=mcp-app`, with light/dark tokens, 768×480 base × 1.667 root scale, ≥48×48 targets and an inline↔fullscreen display-mode toggle. Only the card reaches off-origin, so it alone declares a CSP. Verified 2026-10-15 (§21 Phase 5 status). |
| 3 | **No `addon.json` / onboarding package** | No `alexa-ai new mcp` scaffold — no store listing, icons (6 sizes), carousel, privacy/terms URLs, or `integrations[]`. **Addressed — §21 Phase 2:** the manifest, its media and the store-listing copy are in the repo; only the `alexa-ai deploy` remains. |
| 4 | **< 500 ms round-trip risk** | A live VPS→DeepSeek rerank measured **~9 s** (§16; 20 s timeout). Any tool through the router/rerank blows the budget; only the in-process local-embed path is plausibly inside it. **Addressed — §21 Phase 3:** reproduced live on 2026-10-15 at **~21 s per search** (the 20 s rerank cap expiring, then falling back to cosine anyway), and the new `SEARCH_LATENCY_BUDGET_MS` ceiling makes an Alexa-facing deployment skip the rerank outright and answer from the in-process local-embed path instead. |
| 5 | **Version negotiation** | Alexa+'s client sends `2025-03-26`; we pin `2025-11-25` as newest. The SDK negotiates down, so this should work — worth an explicit handshake test against a `2025-03-26` client. **Verified — §21 Phase 4:** the extended `simulate-alexa-plus.mjs` advertises `2025-03-26` and the live server echoes it back (`2025-03-26 → 2025-03-26`), 2026-10-15. |

**Design-guide items** (relevant now that the UI layer in gap 2 is built — the
whole component set, not one card): 768×480 base + 1.667 root scale, ≥48×48 touch
targets, light/dark parity and 4.5:1/3:1 contrast hold in all four archetype
documents; the ≤125-char alt text rule is enforced on the card's lead image
(`ALT_MAX = 125`), and the other three draw no off-origin image. The brand logo
variants and the store-listing copy are built and in the repo (§20.1). **Nothing
on this list is still unbuilt** — what remains is the deploy that puts the new
`/addon/` files behind the web image.

### 20.4 What this changes

Nothing in the submission is blocked by this analysis: §18 ships a self-hosted MCP
server + web client, and a **data-only (hydration) add-on is a first-class,
supported path** — it does not require the MCP Apps UI layer. The two findings
worth acting on are related: **the auth gap (1) is the certification blocker**,
and **the rerank latency (4) is the one place the code already violates a stated
Alexa+ requirement**. Both should be captured in `PRODUCT-FEEDBACK.md` as
AWS/Amazon-platform friction if the OAuth path is pursued after the deadline.

## 21. Step-by-step action plan — closing the §20 gaps

The order is deliberate: each phase unblocks the next, and phases 1–4 are the
whole **data-only submission** (the critical path). Phase 5 is the MCP Apps UI
layer, which §20.4 confirms is **not required** to submit. **Phases 1–4 are done
(see below), and Phase 5 is now built and verified too** — it is optional, but no
longer only a plan.

### Phase 1 — OAuth discovery + both tiers (Gap 1, the certification blocker) — ✅ DONE

The one hard blocker. Everything else is polish.

> **Status: implemented and verified.** New module
> [`infra/mcp/src/oauth.ts`](../../infra/mcp/src/oauth.ts); wired into
> [`resolveCaller()`](../../infra/mcp/src/identity.ts), registered in
> [`server.ts`](../../infra/mcp/src/server.ts) (routes + `/health.oauth`);
> documented in [`infra/mcp/README.md`](../../infra/mcp/README.md) and
> [`infra/.env.example`](../../infra/.env.example); exercised by
> **step 11 / 11b** of [`scripts/verify.mjs`](../../infra/mcp/scripts/verify.mjs)
> (discovery fields + a Tier-1 token completing `initialize` + `tools/list`).
> `npm run typecheck` and `npm run build` pass; the whole verifier is green.

1. **PRM doc** at `GET /.well-known/oauth-protected-resource` (RFC 9728):
   returns the resource id + `authorization_servers`. New file
   [`infra/mcp/src/oauth.ts`](../../infra/mcp/src/oauth.ts).
2. **Auth-server metadata** at `GET /.well-known/oauth-authorization-server`:
   issuer, `authorization_endpoint`, `token_endpoint`, and — the quickstart
   checklist fails without it — **`code_challenge_methods_supported: ["S256"]`**.
3. **`POST /oauth/token`**, both tiers:
   - Tier 1 `client_credentials` → scope `mcp:service`, lifetime ≤3600 s,
     **no refresh token** (registration, `tools/list`, health).
   - Tier 2 `authorization_code` + PKCE (`S256`) → `mcp:tools` / `mcp:resources`
     (user-specific tools).
4. **`GET /oauth/authorize`** — the Tier 2 consent step.
5. **Wire issued tokens into** [`resolveCaller()`](../../infra/mcp/src/identity.ts)
   so a Tier-1 token registers/lists and a Tier-2 token calls identity-scoped
   tools, keeping the `X-Device-Id` / static-bearer paths intact for the web
   client.
6. **Keep** the plain 401 **without** `WWW-Authenticate` at
   [`server.ts:184`](../../infra/mcp/src/server.ts#L184) — already correct; do
   not add the header.

Design notes recorded with the code: tokens are self-contained HMAC-SHA256
signed payloads (no store) so the surface survives container restarts;
authorization codes are short-lived and in-memory (single instance); the
`redirect_uri` is allowlist-checked **before** any redirect so
`/oauth/authorize` cannot be an open redirector; OAuth tokens resolve **before**
the device header and the static bearer, and are never forwarded to PostgREST.
The surface is fully dormant until `MCP_OAUTH_SECRET` is set.

### Phase 2 — `addon.json` + onboarding (Gap 3) — ✅ DONE (scaffolded; deploy pending)

> **Status: the manifest and its media are in the repo and validated.**
> [`infra/mcp/addon-package/addon.json`](../../infra/mcp/addon-package/addon.json)
> follows the `addon.json schema reference` from the QuickStart verbatim.
> The 6 light + 6 dark icon sizes + 2 carousel images (600×900) were generated
> from the existing brand assets into [`public/addon/`](../../public/addon); all
> 14 are live at `https://globie.earth/addon/…` (and the brand logo set at
> `/addon/logo/`), served by web image `20261015-003416`.
> The listing copy is written to the Store Listing guide in
> [`infra/mcp/addon-package/store-listing.md`](../../infra/mcp/addon-package/store-listing.md)
> and mirrored into the manifest. A field-by-field check against the doc's
> **Field Constraints** table passes: `manifestVersion "1.0"`, `name.value`
> 12/30, `shortDescription` 119/123, `fullDescription` 944/4000, 4 phrases each
> ≤200, both compliance URLs HTTPS, all 6 icon sizes (light + dark), both
> carousel `altText` ≤250, `integrations[0].type "MCP"` +
> `endpoints.default.type "HTTPS"` + `uri https://mcp.globie.earth/mcp`
> (`bannerImages` is optional per the schema, so `[]` is valid).
>
> **Two defaults to revisit before submit:** `distributionCountries` is
> `["US"]`, and the only locale is `en-US` (the add-on will still *serve* Thai
> content; this is only the listing locale). **Not yet run** (needs your Alexa
> developer login): `alexa-ai configure` → `alexa-ai deploy` from
> [`infra/mcp`](../../infra/mcp).

1. Run the `alexa-ai` flow (`configure` → `new mcp`) or scaffold `addon.json` by
   hand: `manifestVersion "1.0"`, `storeListing` (name = invocation name, short
   ≤123, 3–4 spoken sample phrases, privacy/terms HTTPS), the **6 icon sizes**
   (72/64/88/126/180/241), ≥1 carousel 600×900, and `integrations[] = { type:
   "MCP", config.endpoints.default.uri }`.
2. `alexa-ai deploy` to register tools/resources. Note: **any** tool/resource
   change afterwards requires a re-deploy (cached otherwise).

### Phase 3 — Latency (Gap 4, the one code-level violation) — ✅ DONE

> **Status: implemented and verified.** New `SEARCH_LATENCY_BUDGET_MS` in
> [`infra/mcp/src/rerank.ts`](../../infra/mcp/src/rerank.ts) (reported by
> `rerankConfig()`, gated in `rerankHits()`): when the ceiling is set and the
> rerank's own cap (`RERANK_TIMEOUT_MS`) exceeds it, the rerank is skipped and
> the in-process cosine order stands, reported honestly as `ranking: "cosine"`.
> Documented in [`infra/.env.example`](../../infra/.env.example) and
> [`infra/mcp/README.md`](../../infra/mcp/README.md). `npm run typecheck` and
> `npm run build` pass; a local probe confirmed the gate (budget 500 + default
> 20 s cap → returns `null` in **0 ms**, no network call; a large budget with a
> 400 ms cap → a real bounded call, aborted at 423 ms).
>
> **Reproduced first (step 1).** A live `search_forest_knowledge` measured
> **~21.6 s** on 2026-10-15 — the 20 s rerank cap expiring and *then* falling
> back to cosine, i.e. the budget was blown with no rerank to show for it.

1. ~~Reproduce the **~9 s** VPS→DeepSeek rerank (§16) against the 500 ms budget.~~
   Done: ~21.6 s per search live on 2026-10-15.
2. ~~For Alexa-facing tools, either route through the **in-process local-embed
   path** or add a fast-path + shorter timeout with graceful keyword fallback
   (the server already degrades rather than erroring, per §20.3).~~ Done: the
   ceiling routes an Alexa-facing search through the in-process local-embed path
   (the rerank is skipped), keeping the existing cosine/keyword degradation.

### Phase 4 — Version negotiation (Gap 5, verify — likely already fine) — ✅ DONE

> **Status: verified against the live server.** `scripts/simulate-alexa-plus.mjs`
> now rewrites the initialize request's `protocolVersion` in flight (the SDK's
> `Client.connect()` hardcodes `LATEST_PROTOCOL_VERSION`, so the one field is
> patched to `MCP_PROTOCOL`, default `2025-03-26`) and asserts the version the
> server negotiated. Live run, 2026-10-15: `advertised 2025-03-26 → negotiated
> 2025-03-26`, exit 0; `MCP_PROTOCOL=2025-11-25` likewise echoes back; the
> `--negative` run still refuses a wrong token.

1. ~~Extend [`scripts/simulate-alexa-plus.mjs`](../../infra/mcp/scripts/simulate-alexa-plus.mjs)
   to advertise `protocolVersion: "2025-03-26"` and confirm the SDK negotiates
   down from our pinned `2025-11-25` at
   [`server.ts:57`](../../infra/mcp/src/server.ts#L57).~~ Done: see above.

### Phase 5 — MCP Apps UI layer (Gap 2) — ✅ DONE

> **Status: built and verified, 2026-10-15.** Optional for the data-only
> submission (§20.4), so this adds a widget *alongside* the JSON result rather
> than replacing it — a host without SEP-1865 still reads the same text block.

What shipped is four documents plus the code that serves them — not one widget
per tool:

1. [`infra/mcp/ui/`](../../infra/mcp/ui) — the MCP Apps themselves, hand-authored
   as self-contained HTML5 documents (no Vite/`ext-apps` in this package, so no
   build step was added). The design guide names exactly four components — Card,
   List, Carousel, Map — and every tool's result fits one of them, so each
   document is an **archetype shared by every tool whose result has that shape**:
   `card.html` (7 tools: species, photo, recipe, eco balance, adoption, both
   soundscape calls), `list.html` (4: the two searches, recommendations, deeds),
   `carousel.html` (3: the podcast tools), `map.html` (1: sanctuary conditions).
   Which tool a mounted copy is showing is read at runtime from the host's own
   `hostContext.toolInfo.tool.name`, so one set of bytes serves all of its tools.
   Each has the 768×480 base with one root `zoom` (`--ui-scale`, `1.667` when the
   host reports ≥1024 px), light/dark token blocks, ≥48×48 touch targets,
   `textContent`-only rendering, the SEP-1865 `postMessage` handshake
   (`ui/initialize` → `ui/notifications/initialized`),
   `ui/notifications/size-changed` on resize, and an inline↔fullscreen toggle via
   `ui/request-display-mode`.
2. [`infra/mcp/src/ui/apps.ts`](../../infra/mcp/src/ui/apps.ts) — reads each file
   at module load, hashes it (sha256 → 12 hex) into a content-addressed URI
   (`ui://globie/card-<digest>`, `-list-`, `-carousel-`, `-map-`), and registers
   all four as resources whose MIME **is** `text/html;profile=mcp-app`, with
   `_meta.ui.prefersBorder` on both the list entry and the read content item. It
   also owns `TOOL_ARCHETYPE` — the tool → archetype map that `uiUriForTool()`
   reads, typed against a `ToolName` union so a mapping typo cannot compile. CSP:
   only the card reaches off-origin (Wikimedia thumbnails and the object-storage
   copy), so it alone declares `resourceDomains`; the other three fetch nothing,
   so the host's restrictive default already fits.
3. The **15 tool definitions** across [`src/tools/`](../../infra/mcp/src/tools) —
   each declares `_meta.ui.resourceUri` via `uiUriForTool(…)` and returns the rich
   result. [`src/tools/result.ts`](../../infra/mcp/src/tools/result.ts) grew an
   optional `UiHint` third argument to `jsonResult` that adds `structuredContent`
   and `_meta.ui` (with `invoking`/`invoked`) — the exact §20.2 wire shape.
4. [`src/server.ts`](../../infra/mcp/src/server.ts) — `registerUiResources(server)`
   is called in `buildServer()` beside the other resource registrations.
5. [`Dockerfile`](../../infra/mcp/Dockerfile) — `COPY ui ./ui` in the runtime
   stage, because `src/ui/apps.ts` resolves `../../ui/…` from `dist/ui/`. Without
   it the container would fail the bundle read at boot.

**Accessibility pass, 2026-10-15.** Contrast and light/dark parity were checked
across the widgets' token pairs, and the guide's ≤125-char alt text rule is
enforced on the card's lead image (`ALT_MAX = 125`). The carousel hides its
decorative covers from the accessibility tree while leaving each slide's own text
as the label; the map's locator plate carries an `.sr-only` "Sanctuary
coordinates" label and hides only the decorative AQI dot.

`scripts/verify.mjs` gained section **13. MCP Apps UI (SEP-1865)** (the add-on
asset check renumbered to 14): it asserts all four `ui://` archetypes are
advertised and served as `text/html;profile=mcp-app`, that **all 15 Globie tools**
declare a `_meta.ui.resourceUri` pointing at a URI that was actually listed (a
dangling one is a broken App, not a fallback), that a full read of the card is a
valid HTML5 page repeating its `_meta.ui`, and that a call carries
`structuredContent` plus the matching `_meta.ui.resourceUri`. **Local run,
2026-10-15: all 14 sections pass, exit 0** (`POSTGREST_URL=http://localhost:3001
EMBEDDING_PROVIDER=none PORT=8099`), and a raw JSON-RPC probe confirms the wire
result is exactly `{ _meta, content, structuredContent }`.

**Two deploy rules, restated** (both §20.2, and they trigger on different
changes): editing a widget changes its content hash, hence its `ui://` URI, hence
a tool's declared resource — that needs an **`alexa-ai deploy`**. Adding a file
under `public/addon/` (the six dark icons, the new logo set) needs the **web image
rebuilt** instead, because that is what serves `/addon/`.

**Critical path:** Phase 1 → 2 → 3 → 4 — all four now done, plus optional Phase 5.
Phases 1 and 3 were the ones that needed real code; 2 was scaffolding, 4 was a
handshake test, and 5 is the UI layer.