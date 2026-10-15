# Devpost submission — Globie Earth MCP server

The submission copy for the **Build, Ship, Shape: Amazon Developer Hackathon**
(Devpost: `amazonappdev2026`). Everything below is written to be pasted into the
Devpost form, with the parts only the submitter can fill (URLs, video, GitHub
username) marked `<<TBD: …>>`.

- **Primary track:** Alexa+ (self-hosted MCP server, spec `2025-11-25`, Streamable HTTP).
- **Mini challenges:** AWS Builder (Bedrock), Open Source.
- **Artifact:** `infra/mcp/` is the submission; `infra/mcp-client/` is the host that
  shows it running; `infra/mcp/PRODUCT-FEEDBACK.md` is the required product feedback.
- **Deadline:** Oct 23, 2026, 7:00 pm UTC (= Oct 24, 02:00 Asia/Bangkok).

Two house rules govern the tone of this copy, and they are deliberate: **the
forest is never paywalled**, and **if we cannot prove something happened, the app
does not claim it did**. Where a number is unmeasured, this document says so.

---

## 1. Name and elevator pitch

**Project name:** Globie Earth — a reforestation sanctuary you can talk to

**Elevator pitch (one line):**

> A self-hosted MCP server that turns Globie Earth's living forest — native
> species, guardian lore, Living Deeds and the sanctuary's own weather — into
> tools an Alexa+ (or any MCP) host can call, so you can adopt a tree and hear
> how it is doing, by voice.

---

## 2. The text description (Devpost story fields)

### Inspiration

Reforestation apps usually stop at a progress bar. Globie Earth is built around a
different idea: a living sanctuary with a native-species catalogue, guardian lore,
sites along a trail, and a "Living Deed" issued for every tree a person adopts.
The forest is a world you return to, not a counter you top up.

When Amazon adopted **MCP** as the way services plug into **Alexa+**, that world
became something you could *talk to*. The inspiration was simple: the same
reforestation backend that powers the Globie Earth app should answer a voice
request — "how is the sanctuary doing?", "adopt an oak for me", "what should I
plant given what I have already adopted?" — without a bespoke voice integration.
MCP is the integration.

### What it does

The server exposes Globie Earth's reforestation backend plus the Openmind.Travel
catalogue as **53 tools (17 Globie + 36 Openmind Travel), 7 resource templates
and 2 prompts** over MCP Streamable HTTP:

- **Discover** — `search_forest_knowledge` (semantic search across species, sites
  and guardian lore, plus four Thai Department of National Parks reference
  datasets: the biodiversity survey, the national plant checklist, the
  park-fauna observations and the national wildlife checklist),
  `recommend_species` (recommends from your own past
  adoptions), `get_sanctuary_conditions` (ambient CO₂, European AQI, humidity
  and air temperature at the sanctuary), `describe_photo` (hands an attached
  photo to a vision model and returns its reading — a plant, landscape, object,
  room or document), and `describe_species` (the English
  Wikipedia lead section for a species, by scientific or common name).
- **Local Culture** — `search_local_culture` (semantic search across the
  sanctuary's own Thai cookbook, *Cookbook Version Kai & Shea* — its dishes,
  their ingredients, regions and categories) and `get_recipe` (the whole dish:
  its ingredients, the numbered method with the book's own per-step times, and
  its tips).
- **Act** — `adopt_species` records an adoption and issues a Living Deed. It is
  idempotent when the store's transaction id is supplied, so a retry resolves to
  the original deed rather than a second tree.
- **Return** — `get_my_deeds` and `get_eco_balance` read back what a caller has
  done, scoped to that caller and no one else.
- **Branch out** — `generate_soundscape` queues a generated piece of music for the
  sanctuary and `get_soundscape` reports a track's status; `search_podcasts`,
  `get_trending_podcasts` and `get_podcasts_by_theme` search a library of shows
  about the living world.
- **Travel** — 36 `om_*` tools wrap the **Openmind.Travel** REST catalogue
  (`bokunapi.9o9.io`): search tours & activities (Viator, Bókun, GetYourGuide),
  browse destinations/countries/categories, search flights (with a monthly price
  calendar), read country and airline guides, get YouTube travel videos, browse
  the Globie community feed, plan trips with AI, save itineraries, and read
  OpenmindProjects impact data (fundraising progress, SDG causes, impact
  treasures and stories).

Read-only tools are annotated read-only; the two that change state
(`adopt_species`, `generate_soundscape`) are annotated mutating. The same data is
also addressable through seven `globie://` resource templates — three for the
catalogue, the device-scoped `me/deeds`, and four for the DNP reference datasets
— for hosts that prefer to read rather than call, and two prompts
(`forest-guide`, `adopt-a-tree`) give a voice companion its persona and its
adoption flow. Alongside the MCP surface, the same
server also exposes eight side routes the app itself uses — a natural-language
router (`/route`), a Wikipedia lookup (`/wiki`), voice transcribe/speak
(`/voice/*`), photo contribution (`/contribute`) and the reviewer queue
(`/moderate/*`).

Under the hood it stays honest about its sources: the sanctuary's conditions come
from **Open-Meteo** and are labelled *modelled* fields, not readings from a sensor
on site; a queued soundscape is reported as **`queued`**, never as a finished
recording; and `describe_species` returns Wikipedia's lead verbatim, under
**CC BY-SA 4.0** and with its source link, never presented as Globie data.

### How we built it

- **MCP server** in TypeScript on the official **`@modelcontextprotocol/sdk`**
  (v1.32.0), served over Streamable HTTP (`POST /mcp`, plus `GET` for the optional
  server-to-client stream and `DELETE` to end a session) behind **Fastify**.
  Responses use `enableJsonResponse`, so a POST is answered as plain JSON and
  survives the reverse proxy with no SSE-buffering surprises.
- **Protocol version pinned to `2025-11-25`.** The server compares its
  `REQUIRED_PROTOCOL_VERSION` against the SDK's `LATEST_PROTOCOL_VERSION` and
  refuses to boot if they diverge — so the pin cannot quietly become a lie.
- **Embeddings are self-hosted by default.** `search_forest_knowledge` embeds the
  query with `intfloat/multilingual-e5-small` (384 dims) through transformers.js/ONNX
  running in-process on CPU — multilingual (Thai + English), no AWS account, no
  credentials, no per-call cost. Amazon Bedrock's **Titan Text Embeddings V1**
  (1536 dims) is wired in behind `EMBEDDING_PROVIDER=bedrock` and stays selectable,
  but the schema was migrated to `vector(384)` for the local model
  (`infra/schema/180_embeddings_local.sql`), so Titan now needs the column back at
  `vector(1536)` plus a re-embed.
- **PostgREST, not a database connection.** The server talks HTTP to PostgREST and
  forwards the caller's own `X-Device-Id` / `Authorization` headers. The app's RPCs
  derive their identity from `X-Device-Id` and row-level security pins every
  device-scoped row to it, so the tools are correct by construction: this server
  **cannot** get authorization wrong, because it never authorizes anything itself.
- **Self-hosted identity.** A `X-Device-Id` uuid (also the RevenueCat `appUserID`)
  is the primary credential; a **GoTrue** JWT is the optional account credential,
  forwarded untouched. For a raw MCP client that cannot mint a JWT just to try the
  server, the demo also accepts a **static bearer** exchanged at the MCP edge for a
  device identity — stated plainly as **not OAuth 2.1**.
- **Two neighbour proxies hold the third-party secrets.** `generate_soundscape`
  calls the `studio` proxy (Suno) and the podcast tools call the `podcast` proxy
  (Podcast Index). The MCP server holds neither key. This is the same reason keys
  stay off the client: a shipped bundle would publish them.
- **The host.** `infra/mcp-client/` is a real MCP client — the official SDK's
  `Client` + `StreamableHTTPClientTransport` running **in a browser** (the SDK
  imports no `node:` built-ins, so it needs no polyfills). It performs the
  `initialize` handshake, then builds its entire UI from the JSON Schemas the
  server returns — add a tool to the server and it appears. It is shipped as its
  own nginx container on the same stack.
- **Everything runs as containers** on the project's own **Easypanel** stack
  (`mcp.globie.earth`), behind Cloudflare, alongside `studio` and `podcast`.

### Challenges we ran into

- **Pinning a protocol version that is newer than most examples.** `2025-11-25`
  is ahead of the defaults in a lot of SDK samples and blog posts, so "it worked
  in the tutorial" was not evidence. We made the pin a boot-time assertion and
  verify every change with the **official SDK client**, not curl.
- **Resource URIs are parsed before your handler runs.** The SDK calls
  `new URL(uri)` on `resources/read` *before* dispatch, so a bare `species/1`
  throws `-32603 Invalid URL` before any of our code sees it — and the error points
  at the transport, not the URI. Fixed by making every URI absolute
  (`globie://species/{id}`); a real time sink to localise.
- **CORS vs. a hijacked reply.** Our `/mcp` route hands the response to the MCP
  transport with `reply.hijack()`, which writes to the raw Node response — so the
  CORS headers Fastify's plugin had set were dropped on the *real* POST while the
  OPTIONS preflight still passed. From the browser it looked exactly like a dead
  server. Fixed by re-applying the CORS headers to `reply.raw` before hijacking.
- **Bedrock off AWS has no instance role.** We self-host (decision D2), so the
  short-lived-credential path we would actually run in production is unavailable;
  credentials come from container env. Recorded as a real gap, not papered over.
- **A brand-new AWS account cannot call Bedrock at all.** The data plane returns
  `ValidationException: Operation not allowed` while new-account verification is
  pending (support case `179122138300151`), so Titan is not demoable on the day.
  That is what made the **self-hosted** model the default: the demo does not depend
  on the gate clearing.
- **Not claiming more than we can prove.** The sanctuary's CO₂/AQI come from a
  model, not a sensor; a soundscape is queued, not produced. We made the payload,
  the tool description and the server's `instructions` all say so, because the
  honest version is the product.

### Accomplishments that we're proud of

- A **real MCP host**, not a README claim: the browser client completes the
  handshake, lists the surface, and calls tools at runtime — with an exportable
  transcript as evidence.
- **Correct-by-construction authorization**: routing through PostgREST + RLS means
  the tools cannot leak another device's deeds, because identity is the caller's
  own header.
- **A protocol pin that cannot silently drift**, and a verifier (`scripts/verify.mjs`)
  that speaks the real protocol through the official SDK.
- **An honest demo**: modelled fields labelled modelled, queued audio labelled
  queued, and unmeasured latency/cost left explicitly unmeasured.

### What we learned

- MCP's value is not the transport — it is that **the host builds its own UI from
  your schemas**. Once the surface is declared, a new host (Alexa+) gets it for
  free. That is a very different integration economics from a bespoke voice skill.
- **Identity is the hard part of an agent backend**, not tool-calling. Reusing the
  app's existing RLS model did more for correctness than any tool-level guard.
- Embedding **width is a schema contract**, not a model setting: V1 vs V2 is a
  migration decision, not a config flag.
- The friction log is worth writing down as it happens — it is both the required
  product feedback and, in our case, a candidate open-source contribution.

### What's next

- **Keep the catalogue in step with the model.** The embeddings are backfilled with
  `scripts/backfill-embeddings.mjs` using the *same* provider the queries use, so
  `search_forest_knowledge` returns results instead of honestly explaining that the
  index is empty — and any provider change requires a migration plus a full re-embed.
- **Adopt the MCP OAuth 2.1 flow** in place of the static demo bearer, with GoTrue
  behind a shim (it is a fine JWT issuer, but not an MCP-shaped auth server out of
  the box).
- **Move the deployment onto AWS** (App Runner/ECS) so Bedrock is reached with an
  instance role rather than long-lived env credentials.
- **Curate the podcast shelves.** `podcast.globie.earth` now serves a live index
  (`/health` reports 336,765 feeds) and all four data routes answer `200`, but the
  curated `featured` shelf is still empty, so the soundscapes tab shows search and
  browsing rather than an editor's shortlist.

---

## 3. Primary track: Alexa+ — compliance answer

The Alexa+ track asks for a **self-hosted MCP server, spec `2025-11-25` or later,
Streamable HTTP**, whose required technology is **actually called in code** (not
mentioned in a README), shown **working in a demo**.

| Requirement | How this submission meets it |
| --- | --- |
| Self-hosted MCP server | `infra/mcp/`, self-hosted on our own stack at `https://mcp.globie.earth` |
| Spec **≥ 2025-11-25** | Pinned to `2025-11-25`; boot fails if the SDK's latest ever moves past it |
| **Streamable HTTP** | `POST /mcp` (+ `GET` / `DELETE`), `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` |
| Technology imported **and called at runtime** | `import { McpServer, StreamableHTTPServerTransport }` in `src/server.ts`; the browser host calls it live. The Transcript tab exports the session as runtime evidence. |
| Public HTTPS endpoint | `https://mcp.globie.earth` (TLS at the edge; Easypanel/Cloudflare) |
| Simulated experience allowed | `infra/mcp-client/` is that simulated host: a real MCP client in the browser |
| Product feedback | `infra/mcp/PRODUCT-FEEDBACK.md` — one entry per tool/API/SDK |

**Note on auth, stated honestly.** The demo accepts a static bearer exchanged at
the MCP edge for a device identity. That is **not** MCP OAuth 2.1, and neither
the README nor this copy claims it is. The production path is Amazon's own
Alexa+ MCP account linking — the **OAuth 2.1 Authorization Code Grant with PKCE
S256** (the implicit grant is not supported) — which is not built here. The
Alexa+ track explicitly sanctions a **simulated experience in a web app**, which
is the path this submission demonstrates — the browser client is the host.

---

## 4. Mini challenge: AWS Builder — compliance answer

> **STATUS: ON HOLD (decided 2026-10-10).** Mini challenges are not being pursued
> for submission #1. The AWS Builder entry is parked — the default embeddings path
> is self-hosted, Bedrock is never exercised, so the bench/credits work is
> deferred. Kept below as reference only.

The AWS Builder mini challenge asks for **AWS services used in the project with
documented integrations**.

| AWS service | Where it is used | Documentation |
| --- | --- | --- |
| **Self-hosted embeddings** — `intfloat/multilingual-e5-small` (384 dims) via `@huggingface/transformers`/ONNX | `search_forest_knowledge` embeds the query in-process on CPU — the default path, no account or cost | `infra/mcp/src/embed.ts`; `infra/schema/180_embeddings_local.sql`; `infra/mcp/README.md` §Embeddings |
| **Amazon Bedrock** — Titan Text Embeddings **V1** (`amazon.titan-embed-text-v1`, 1536 dims), optional | `EMBEDDING_PROVIDER=bedrock` embeds the query through `@aws-sdk/client-bedrock-runtime` | `infra/mcp/src/embed.ts`; `infra/mcp/README.md` §Embeddings; `infra/mcp/PRODUCT-FEEDBACK.md` |
| **Measurement harness** | `scripts/bench-embed.mjs` imports the same `embedWithUsage()` the server calls and reports p50/p95 latency (+ Bedrock-billed input tokens priced at the published $0.10 / 1M when the provider reports them) | `infra/mcp/PRODUCT-FEEDBACK.md` |

`EMBEDDING_PROVIDER=none` is a supported configuration: semantic search explains
itself and every other tool keeps working. The **self-hosted** path is measured
(min 9 / p50 9 / p95 12 ms on CPU); **Titan's latency and cost rows are pending a
live bench run** and are left unmeasured on purpose — the harness refuses to
invent numbers.

---

## 5. Mini challenge: Open Source — decision **A (locked)**

> **STATUS: ON HOLD (decided 2026-10-10).** Not pursued for submission #1. Note
> that Option A costs no extra work — the public repo + visible LICENSE it needs is
> already mandatory for the standard Devpost fields — so it can be re-enabled later
> without a new artifact.

The Open Source mini challenge needs a **new open-source project (with a license)**
or a **contribution (branch / fork / PR) to a public repository during the window**,
plus: **contribution URL, repo URL, GitHub username**, and a short description of
what you did, how it works, and why it matters. PRs do not need to be merged.

**Decision (D5): Option A — the submission repo *is* the open-source project.**

Why A, and not a separate contribution:

- The standard Devpost fields already require a **public repo with a visible
  open-source license**, so this artifact has to exist anyway. Option A makes the
  submission repo double as the Open Source entry — no second artifact, no
  dependency on an outside maintainer.
- The MCP server **did not exist before the window**, so publishing it under a
  license is genuinely a *new* open-source project — exactly the first shape the
  challenge accepts ("a new licensed repo").
- The **friction-log bonus (up to 10%) is earned by `PRODUCT-FEEDBACK.md`**
  regardless of which option we pick, so Option A loses none of it.

**Option A — the MCP server repo *is* the open-source project.**
- Repo URL: `https://github.com/iromath/globie-earth`
- License: **MIT** — `LICENSE` at the repo root (Copyright (c) 2026 OpenmindProjects),
  shown in the repo About section
- GitHub username: `iromath`
- Description: Globie Earth's reforestation backend, exposed as a self-hosted
  Model Context Protocol server (spec `2025-11-25`, Streamable HTTP) — 53 tools
  (17 forest/cookbook/podcast + 36 Openmind.Travel), 7 resource templates, 2 prompts, a
  real browser MCP client, self-hosted multilingual embeddings, and a
  PostgREST+RLS identity model that makes the tools correct by construction.

**Option B — kept only as an optional stretch, not the submission.** Two
candidates from the friction log are real and were verified in the shipped
`@modelcontextprotocol/sdk` v1.32.0:
1. **Document the absolute-URI requirement** in `registerResource` / improve the
   `-32603 Invalid URL` error — `resources/read` calls `new URL(request.params.uri)`
   *before* dispatch, so a bare `species/1` fails before any handler runs, and the
   message points at the transport rather than the URI.
2. **Document the `resources/list` naming semantics** for templated vs. static
   resources, which currently coexist under two undocumented rules.

If we open it, it must go to the SDK repo's long-lived **`v1.x`** branch — `main`
is now v2 (`@modelcontextprotocol/server` / `/client`, spec `2026-07-28`), while
this project builds against the v1 monolith. Upstream is **currently limiting PRs
to 1 per new contributor** while v2 settles and steering feedback to issues, so a
PR is possible but not guaranteed to land. The submission does not depend on it:
if it lands we also fill the `contribution URL`; if not, Option A stands alone.

---

## 6. Product feedback (required)

The full log lives in [`infra/mcp/PRODUCT-FEEDBACK.md`](../../infra/mcp/PRODUCT-FEEDBACK.md):
one entry per SDK/API, each written from something that actually happened, with
feature requests and a consolidated friction log.

| Component | Verdict |
| --- | --- |
| MCP TypeScript SDK (`@modelcontextprotocol/sdk` v1.32.0) | Build again — the protocol work is done for you |
| Self-hosted embeddings (multilingual-e5-small via transformers.js) | Build again — it removed the account gate and the per-call cost in one move |
| Amazon Bedrock (Titan V1) | Build again — with a caveat about the IAM role off AWS and the new-account data-plane gate |
| PostgREST | Build again — the identity model came for free |
| GoTrue | Yes as a JWT issuer; **not** a drop-in MCP OAuth server |
| Fastify | Build again — boring, which is the point |
| Open-Meteo | Build again — keyless; non-commercial caveat recorded |
| Podcast Index | Build again — 10 req/min free tier shapes the design |
| Suno | Build again — the async queue is the right shape |
| OpenStreetMap-free services | **Not used by this artifact** — recorded as "nothing to review here" rather than manufacturing an opinion |

**Friction log** (8 upstream requests, from the build): the SDK's absolute-URI
`resources/read` failure; the SDK's mixed `resources/list` naming rules; Bedrock's
indistinguishable "model not enabled" error; Bedrock's missing off-AWS guidance;
Podcast Index's free-tier rate limit not being surfaced as a rate-limit; the
Wikipedia Action API returning a missing article as a page object carrying
`missing`; the same API omitting the licence and credit URL from its `extracts`
response; and the Alexa+ `< 500 ms` round-trip budget being incompatible with a
remote rerank, with no platform guidance naming the tradeoff. All eight are
enumerated in [`infra/mcp/PRODUCT-FEEDBACK.md`](../../infra/mcp/PRODUCT-FEEDBACK.md)
under **Friction log**.

---

## 7. Built with (tags)

TypeScript · Node.js · Model Context Protocol (MCP) · `@modelcontextprotocol/sdk`
· Amazon Bedrock · Titan Text Embeddings · AWS SDK for JavaScript · Fastify ·
PostgREST · PostgreSQL · pgvector · GoTrue · Docker · Docker Compose · nginx ·
Vite · Open-Meteo · Podcast Index · Suno · Cloudflare · Easypanel.

---

## 8. What to submit — checklist and status

Standard Devpost fields:

- [ ] **Text description** — §2 above (Inspiration → What's next).
- [x] **Public GitHub repo** with **all source, assets and run instructions**, and
      an **open-source license visible at the top / About section** —
      `https://github.com/iromath/globie-earth` (public, **MIT** `LICENSE` at the
      root). See the push note under "Not yet done" below.
- [ ] **Alexa+ code-call requirement** — satisfied: the SDK is imported and called
      at runtime (`infra/mcp/src/server.ts`), and the browser host calls the server
      live.
- [ ] **Demo video < 3 minutes**, public on YouTube/Vimeo, English, showing the MCP
      server in action (the browser client handshake + live tool calls) — shot list
      in §9.
      `<<TBD: video URL>>`
- [ ] **Product feedback** — `infra/mcp/PRODUCT-FEEDBACK.md` (§6 above).
- [ ] **Track:** Alexa+ · **Mini challenges:** AWS Builder, Open Source.
- [ ] **Repo visibility:** **public**, with an `LICENSE` at the root and shown in
      the About section — required by **D5 = Option A** (a private repo cannot be
      the open-source entry).
- [ ] **Collaborators:** add the six Amazon users + `testing@devpost.com`
      **at submission time** (invites expire) — a courtesy on a public repo.
- [ ] **Open Source mini challenge fields** (§5): **D5 = Option A** — repo URL,
      license, GitHub username, description. (Contribution URL is filled only if
      the optional `v1.x` SDK PR lands.)

Not yet done / do not claim:

- [ ] **AWS credits form** — requestable via the hackathon form (needed if the
      Bedrock bench is to run live).
- [ ] **Bedrock bench live run (optional)** — fills the Titan latency/cost rows;
      still unmeasured. The default embedding path is self-hosted and already
      measured, so this only covers the optional `EMBEDDING_PROVIDER=bedrock` story.
- [x] **`podcast.globie.earth` routing** — **done.** The podcast service serves a
      live index again: `/health` reports `feeds: 336765`, and `/categories`,
      `/search`, `/featured` and `/trending` all answer `200` with real data.
- [ ] **Firebase admin key rotation** in Google Cloud — a standing user-side item
      from Phase 0.
- [ ] **Reconcile and push the working tree to the public repo.** As of 2026-10-15
      the published repo (`origin/main`, `iromath/globie-earth`) and this local
      `main` have **diverged** — local is `ahead 2, behind 5` with no shared
      ancestor, and the tree carries a large set of uncommitted changes. Before
      submitting, the published repo must be made to reflect the final code and the
      `LICENSE`, so the "public repo" row above is true of what a judge actually
      clones.

---

## 9. Demo video plan (< 3 minutes)

**Status: ⬜ not recorded.** This is the mandatory runtime proof. The plan's §14
definition of done is: *an MCP client connects to the deployed server over
Streamable HTTP, lists the tools, and calls `search_forest_knowledge`,
`recommend_species`, `adopt_species` and `get_sanctuary_conditions` against real
Globie data — captured in a < 3-minute English video.*

The footage is the **browser MCP client** (`infra/mcp-client/`) doing the real
work, not slides. Every control named below is a real element of that page: the
labels and ids are taken from `infra/mcp-client/index.html` and
`infra/mcp-client/src/main.ts`, not invented.

Decided 2026-10-15: **one narrator, English, no music bed**, captions carry the
narration verbatim. The point of the video is that the required technology is
*called at runtime* — the handshake, `tools/list` and every `tools/call` are live
against `https://mcp.globie.earth/mcp`, and the **Transcript** tab is exported at
the end as the receipt.

### 9.1 Before you hit record

| # | Do this | Why |
|---|---|---|
| 1 | Deploy with **live embeddings backfilled** and confirm `search_forest_knowledge` returns rows, not the "index is empty" explanation | The search beat is the tech-implementation proof; an empty index turns it into an apology |
| 2 | Set `MCP_BEARER_TOKEN` / `MCP_DEMO_DEVICE_ID` on the server | The client's **Demo bearer token (optional)** field only works when the server has one configured |
| 3 | Open the client in a **clean, logged-out profile** at **1920×1080, 100% zoom** | No bookmarks bar or account avatar in frame; text stays legible after compression |
| 4 | Use a **throwaway device id** (a fresh uuid), not a real account's | The adoption beat writes a row; a demo device keeps it off real deeds |
| 5 | Set UI language to **English**, hide the OS taskbar / notification area | The video must be in English, and a stray notification would bleed into the audio |
| 6 | Run the whole thing **once end to end, then refresh** to a clean page | Confirms endpoint, token and models are live, and resets the **Transcript** tab so the recorded session is the one on screen |
| 7 | Free ~500 MB of disk; record **1080p30** | Three minutes of 1080p30 is ~150–250 MB |

### 9.2 Shot list

| Time | Beat | Exact actions | Caption / narration |
|---|---|---|---|
| 0:00–0:12 | Cold open | The client page, masthead in view: eyebrow **“Alexa+ track · runtime hook”**, title **“Globie Earth MCP client”** | `This page is an MCP host. It talks to the Globie Earth server over Streamable HTTP — the same code path an Alexa+ host uses.` |
| 0:12–0:30 | Connect | **1 · Connect**: the **MCP endpoint** field shows `https://mcp.globie.earth/mcp`; type the demo **Device id (X-Device-Id)**, paste the **Demo bearer token**, click **Connect**; the status line confirms a session | `We connect with the official MCP SDK — no bespoke glue.` |
| 0:30–0:52 | Handshake | **2 · Handshake** appears; read the **handshake-facts** rows — **Server**, **Protocol** (`2025-11-25`), **Session**, **Capabilities**; expand **Server instructions** | `One initialize call. The server reports protocol 2025-11-25 and the capabilities it supports.` |
| 0:52–1:12 | The surface | **4 · The surface the server advertises** → **Tools** tab: scroll the 53 tools (17 Globie + 36 Openmind Travel) and their annotations; switch to **Resources** (7 templates) and **Prompts** (2) | `Every tool form here is built from the JSON Schema the server returns. Nothing about this surface is hard-coded in the client.` |
| 1:12–1:38 | Live call — search | Back to **Tools** → **search_forest_knowledge**: enter a real query, call it, show the ranked results | `A live call — this is the real index on the server, not a canned response.` |
| 1:38–2:00 | Live call — conditions + recommend | Call **get_sanctuary_conditions** (point out the **modelled** fields); then **recommend_species** for the demo device | `The conditions are modelled fields, labelled modelled. The recommendation is scoped to this device alone.` |
| 2:00–2:20 | Live call — adopt (mutating) | Call **adopt_species** in its form; the mutating annotation and confirmation are on screen; show the returned **Living Deed** | `Adoption is annotated mutating and writes a Living Deed. Retried with the same transaction id it resolves to the same deed — not a second tree.` |
| 2:20–2:45 | Evidence | **Transcript** tab: the operation log shows `initialize`, `tools/list` and the `tools/call` entries; click **Download JSON** | `Every call this session made, exported as JSON — runtime evidence, not a claim.` |
| 2:45–2:58 | Close | End card | `Globie Earth — a reforestation sanctuary you can talk to. MCP server, spec 2025-11-25, Streamable HTTP.` |

Runs ~2:58. If the cut overruns 3:00, **drop the `recommend_species` half of the
1:38 beat first** — the search call, the conditions call and the adoption must
survive, and the Transcript export must stay last.

The **3 · Ask the forest by voice** panel is deliberately not in this cut: the
required proof is the protocol surface, and a second interaction model would cost
time. If a voice beat is added later, its honesty line — **“This is not an Alexa
wake word.”** — is worth one shot, because it is the same rule the rest of this
copy follows.

### 9.3 Narration script

One narrator, English. **157 words ≈ 65 s** of speech; the rest of the ~3:00 is the
calls playing out on screen. Captions carry these lines verbatim. Budget at
**2.4 words/second**.

| # | Time | Narration | Words |
|---|---|---|---|
| 1 | 0:00–0:12 | "This page is an MCP host. It talks to the Globie Earth server over Streamable HTTP — the same code path an Alexa+ host uses." | 24 |
| 2 | 0:12–0:30 | "We connect with the official MCP SDK — no bespoke glue." | 10 |
| 3 | 0:30–0:52 | "One initialize call. The server reports protocol 2025-11-25 and the capabilities it supports." | 15 |
| 4 | 0:52–1:12 | "Every tool form here is built from the JSON Schema the server returns. Nothing about this surface is hard-coded in the client." | 22 |
| 5 | 1:12–1:38 | "A live call — this is the real index on the server, not a canned response." | 16 |
| 6 | 1:38–2:00 | "The conditions are modelled fields, labelled modelled. The recommendation is scoped to this device alone." | 15 |
| 7 | 2:00–2:20 | "Adoption is annotated mutating and writes a Living Deed. Retried with the same transaction id it resolves to the same deed — not a second tree." | 24 |
| 8 | 2:20–2:45 | "Every call this session made, exported as JSON — runtime evidence, not a claim." | 14 |
| 9 | 2:45–2:58 | "Globie Earth — a reforestation sanctuary you can talk to. MCP server, spec 2025-11-25, Streamable HTTP." | 17 |
| | | **Total** | **157** |

### 9.4 Hard rules

- **The technology must be seen working.** The handshake, `tools/list` and every
  `tools/call` are live against `mcp.globie.earth`. A slideshow of screenshots
  does not satisfy "used in code, shown working".
- **English, no copyrighted music.** One narrator and room tone only; captions
  verbatim.
- **No third-party marks** beyond the integration credits already in frame (none
  are needed here). No stock footage, no music bed.
- **Captions must match the screen.** Do not caption a tool the client is not
  actually calling — the same rule the rest of this copy follows.
- **Under 3:00.** Judges are not required to watch past three minutes.

### 9.5 Upload

- **Public on YouTube or Vimeo** (unlisted is fine, **private is not**). Confirm
  by opening the link in a logged-out private window.
- Paste the URL into the demo-video bullet in §8 and the table in §10.
- Rules recap: public link, English, ≤ 3 minutes, shows the required technology
  working.

---

## 10. Placeholders to fill before submitting

| Field | Value / what to put there |
| --- | --- |
| Repo URL | ✅ `https://github.com/iromath/globie-earth` — the submission repo, public, **MIT** `LICENSE` at the root (see the push note in §8) |
| `<<TBD: demo video URL>>` | The **only genuinely open field** — the < 3-minute English video (shot list **§9**) showing the handshake + live tool calls |
| GitHub username | ✅ `iromath` — used in the Open Source mini-challenge fields |
| `<<TBD: contribution URL>>` | Optional stretch only — the `v1.x` SDK PR URL, if it lands. **Not required** for D5 (Option A). |
| License | ✅ **MIT** — `LICENSE` at the repo root (Copyright (c) 2026 OpenmindProjects) |
| D5 decision | ✅ **Option A** — the submission repo *is* the open-source project (see §5) |

_Last updated: 2026-10-15. Filled the now-known submission fields (repo
`https://github.com/iromath/globie-earth`, GitHub user `iromath`, MIT `LICENSE`),
reconciled the §6 friction-log count with `PRODUCT-FEEDBACK.md` (8 upstream
requests), and added the §9 demo-video plan (pre-flight, shot list, narration,
hard rules, upload). The demo-video URL is now the only genuinely open field. The
default embedding path is self-hosted and measured; Titan's latency/cost figures
stay deliberately absent until the optional Bedrock bench runs — this document
does not invent them._

---

## 11. Submission sequencing — Alexa+ is submission #1 (decided 2026-10-10)

This document covers **submission #1 (the Alexa+ track)** only. Per the 2026-10-10 decision,
**Alexa+ ships first**; a **separate Fire TV project** is built and submitted afterwards as
**submission #2**. The two must be *"unique and substantially different"* (rules §4), so
nothing here — repo, code, video or feedback — is reused as the Fire TV artifact. See
[`../PROJECT-MEMORY.md`](../PROJECT-MEMORY.md) §26 and [`AMAZON-MCP-PLAN.md`](AMAZON-MCP-PLAN.md) §15.
