# Product feedback — Globie Earth MCP server

The Amazon Developer Hackathon asks for feedback on *every* tool, API and SDK the
submission uses: what worked, what needed work, onboarding friction, and whether
we would build with it again. This is that log.

It is a build log, not marketing. Every entry below was written from something
that actually happened while building this server; where a number is not yet
measured, it says so instead of guessing one.

The artifact reviewed here is the MCP server in this directory — the Alexa+
track submission. It reaches three origins (`POSTGREST_URL`, `STUDIO_URL`,
`PODCAST_URL`) and holds no third-party credentials of its own: the `studio` and
`podcast` proxies own the Suno and Podcast Index keys. A fourth external call —
Wikipedia's MediaWiki Action API, for `describe_species` and the `wikipedia`
field on the species resources — is keyless, like Open-Meteo, and needs no
credential either.

## At a glance

| Component | What we used it for | Build with it again? |
| --- | --- | --- |
| MCP TypeScript SDK | The whole server surface: Streamable HTTP, tools, resources, prompts | **Yes** — the protocol work is done for you |
| Amazon Bedrock (Titan V1) | `search_forest_knowledge` query embeddings, now the optional path | **Yes, if the account can call it** — blocked by new-account verification here (see below) |
| Self-hosted embeddings (`multilingual-e5-small` via transformers.js) | `search_forest_knowledge` query embeddings — the default | **Yes** — no account, no cost, ~10 ms/query on CPU |
| PostgREST | Reading/writing Globie data through the app's own RPCs | **Yes** — identity model came for free |
| GoTrue | The optional account JWT, forwarded untouched | **Yes, but it is not MCP-shaped as an OAuth server** |
| Fastify | HTTP host in front of the MCP transport | **Yes** — boring, which is the point |
| Open-Meteo | `get_sanctuary_conditions` (modelled, keyless) | **Yes** — with the non-commercial caveat in mind |
| Wikipedia (Action API) | `describe_species` + the `wikipedia` species field (keyless lead-section text) | **Yes** — attribution is the only obligation |
| Podcast Index | `search_podcasts` / `get_trending_podcasts` (via proxy) | **Yes** — 10 req/min on the free tier shapes the design |
| Suno | `generate_soundscape` (via proxy) | **Yes** — async queue is the right shape for it |

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` v1.32.0)

**Used for:** the entire server — `McpServer`, `StreamableHTTPServerTransport`,
`registerTool` / `registerResource` / `registerPrompt` — and, in
`scripts/verify.mjs`, the official `Client` as the end-to-end proof.

**What worked.** Registration is declarative and the schemas are plain zod, so a
tool's input validation and its advertised JSON Schema cannot drift apart. The
client and server in the same package made the verifier trivial to write: it
speaks the real protocol, not a curl imitation. Pinning the protocol version was
easy to make permanent — the server compares `REQUIRED_PROTOCOL_VERSION`
against the SDK's `LATEST_PROTOCOL_VERSION` and refuses to boot if they diverge,
so the pin cannot quietly become a lie.

**What needed work (friction we hit).**

- **Resource URIs are parsed before our handler runs.** The SDK's
  `ReadResourceRequestSchema` handler calls `new URL(request.params.uri)` *before*
  dispatch, so a bare `species/1` throws `MCP error -32603: Invalid URL` before any
  of our code sees it. The fix was to make every resource URI absolute
  (`globie://species/{id}`). Correct once known, but the failure mode points at
  the transport, not at the URI, which cost time to localise.
- **`resources/list` returns template *instances*, not the templates.** For a
  templated resource the server expands the live catalogue and lists one entry per
  row (name = the row's name, e.g. "Kae Na"), while a statically registered
  resource lists under its registration name (e.g. `me/deeds`). That is a
  reasonable design, but the two naming rules coexist in one list and the docs
  do not spell out the difference — our verifier initially asserted the wrong
  thing.

**Feature requests.** (1) Surface the "uri must be absolute" rule in the
`registerResource` docs, or offer a helper that builds scheme-qualified URIs. (2)
Document the `resources/list` naming semantics for templated vs. static
resources. (3) A first-class way to declare a required protocol version rather
than comparing constants by hand.

**Build again?** Yes. Every friction point above was a one-time, localisable
cost; the protocol correctness we got back is worth more than the time it took.

## Amazon Bedrock — Titan Text Embeddings V1

**Used for:** embedding the query in `search_forest_knowledge`
(`amazon.titan-embed-text-v1`, 1536 dimensions) through
`@aws-sdk/client-bedrock-runtime`. As of the switch recorded below it is the
*optional* provider — the default is now a self-hosted model, and
`EMBEDDING_PROVIDER=bedrock` selects Titan.

**Why V1 and not V2.** V1 is 1536 wide, which is exactly the `vector(1536)`
column and the `catalog_search` RPC parameter. V2 is 512/1024 wide, so choosing
it would force a schema migration *and* a full re-embed of `api.embeddings`. For
a hackathon critical path, keeping the swap free of a re-embed won.

**What worked.** The request/response contract is small and stable —
`inputText` in, `embedding` and `inputTextTokenCount` out — so the call is a few
lines and the billed token count comes back on the response itself, which is
what the bench uses for cost rather than estimating from characters.

**What needed work (friction we hit).**

- **The dimension is a schema contract, not just a model setting.** V1 and V2 are
  not interchangeable: the vector width is baked into the column type and the
  RPC signature, so a "just swap the model id" change would silently compare
  vectors against a column that no longer matches. The model choice and the DB
  schema have to move together.
- **Off AWS you cannot assume an IAM role.** The server runs on our own stack
  (`mcp.globie.earth`), so Bedrock is reached with credentials supplied through
  container env. The instance-role / short-lived-credential path — the one we
  would actually run in production — is not available to us here. This is a real
  operational gap, recorded rather than papered over.
- **Model access is a per-region, per-account switch.** A call fails until the
  model is enabled in the chosen region; the error is not self-explanatory, so
  the code's message points at "check that the model is enabled in
  `BEDROCK_REGION`" explicitly.
- **A brand-new account cannot call the model at all.** Ours was still under AWS
  new-account verification, so every `InvokeModel` answered
  `ValidationException: Operation not allowed` — before the IAM or region-access
  questions above could even be tested. There is no client-side workaround; the
  block clears when AWS finishes verification (support case 179122138300151).
  Rather than ship a tool whose only embedding path was gated, the default moved
  to a **self-hosted multilingual-e5-small** model (transformers.js/ONNX, 384
  dims, no account, no cost) and Titan became the optional provider. That is the
  one thing the "Why V1 and not V2" reasoning above had been trying to avoid: it
  forced both a re-embed and a schema change after all — the model choice and the
  DB schema moved together, exactly as the first bullet warned.

**Latency and cost — status: the local default is measured; Titan is pending.**
The harness (`scripts/bench-embed.mjs`) measures whichever provider is
configured. Against the **self-hosted** model, on this CPU-only Docker VM, it
reported **min 9 / p50 9 / p95 12 / max 12 ms** per query (3 measured calls,
warm-up excluded) with no tokens billed — so the default path has real figures.
The Titan path itself stays pending the live run below: the harness imports the
same `embedWithUsage()` the server calls, so it pays the real request, validation
and token read, reports min / p50 / p95 / max / mean latency and the
Bedrock-reported input token count, then prices them at the published **$0.10 per
1M input tokens**. What it does **not** do is invent numbers when there is no
Bedrock access — so those rows carry no figures yet.

Re-run it to fill the Titan table in once there is Bedrock access — the default
local model's numbers are already in the paragraph above:

```bash
cd infra/mcp && npm run build
EMBEDDING_PROVIDER=bedrock node scripts/bench-embed.mjs 50
```

Recorded for Titan as soon as it runs: p50/p95 latency, mean input tokens per
query, and $/query. (Until then, treat any latency or cost claim about the Titan
path as unmeasured.)

**Feature requests.** (1) State the embedding width next to each Titan model in
the docs, since the width is what usually decides the choice. (2) A clearer
error when a model is not enabled in a region, distinguishing it from an auth
failure. (3) Guidance for the "not on AWS, no instance role" case, since
long-lived env credentials are the fallback most people will reach for.

**Build again?** Yes. The contract is small, the token count is reported rather
than estimated, and V1's width kept the schema untouched. The only real cost was
the credentials story off AWS.

## PostgREST

**Used for:** every read and write against Globie data — RPCs (`catalog_search`,
`create_adoption`, `recommend_species`, …) and RLS-scoped table reads — over
HTTP, as `POSTGREST_URL`.

**What worked.** Talking HTTP to PostgREST instead of opening our own Postgres
connection preserved the existing identity model for free: the RPCs derive the
caller from `X-Device-Id` and the row-level-security policies pin every
device-scoped row to it, so forwarding the caller's own headers is what makes the
tools correct-by-construction. A direct connection as the migration role would
have bypassed RLS and forced every tool to re-scope by device itself. Errors come
back as structured JSON (`code` / `message` / `hint`), which the client surfaces
verbatim rather than reinterpreting.

**What needed work.** Nothing structural in the integration. The care needed was
conceptual, not API: once you route through PostgREST you must not add any
implicit "as the app" shortcut, because that is exactly the RLS bypass the design
avoids.

**Build again?** Yes. It is the difference between "our tools re-implement
authorization" and "our tools cannot get authorization wrong".

## GoTrue

**Used for:** the optional account credential — a GoTrue-issued JWT in
`Authorization: Bearer`, forwarded to PostgREST untouched.

**What worked.** Because the token is forwarded, not interpreted, the account
policies (`070_accounts.sql`) apply without this server knowing anything about
them. A device-only caller simply omits it.

**What needed work.** GoTrue is a fine identity provider but **it is not an MCP
OAuth 2.1 authorization server** out of the box. A raw MCP client will not mint a
GoTrue JWT just to try the server, so the demo accepts a static bearer token that
is exchanged at the MCP edge for a device identity — and the README says plainly
that this is **not** OAuth. The honest conclusion: adopting the MCP OAuth flow is
future work, and GoTrue is a candidate but would need a shim.

**Build again?** Yes as a JWT issuer; no as a drop-in MCP auth server.

## Fastify

**Used for:** the HTTP host wrapping `StreamableHTTPServerTransport`, with CORS
for browser clients and a `/health` endpoint.

**What worked.** Predictable and boring in the right way. The transport plugs into
the route handler without ceremony, and `enableJsonResponse` lets a POST be
answered with plain JSON so there are no SSE-buffering surprises behind the
reverse proxy.

**What needed work.** Nothing worth a feature request. The only rule we had to
keep in mind is that a non-browser MCP host sends no `Origin`, so the CORS
allow-list must not accidentally gate traffic that never had an `Origin` to
begin with.

**Build again?** Yes.

## Open-Meteo

**Used for:** `get_sanctuary_conditions` — ambient CO₂ and European AQI (air
quality endpoint) plus humidity and air temperature at 2 m (forecast endpoint).
Keyless, server-side, no CORS.

**What worked.** Genuinely keyless: no signup, no key, and the two endpoints
answer independently, so a failing forecast still leaves the air-quality figures
reported. The house rule shaped the design and the API supported it: these are
**modelled** fields for the sanctuary's coordinates, not a sensor in the wetland,
and the payload, the tool description and the server's `instructions` all say so.

**What needed work.** The CO₂ field is a coarse global model and can be null, so
the code treats "no value here" as null rather than a made-up zero. That is the
API being honest, but a caller has to be written to handle it.

**Caveat to carry forward.** The free tier is **non-commercial**; a paid key is
needed before the Forest Keeper Pass is sold commercially. Not a blocker for the
demo, recorded so it is not forgotten.

**Build again?** Yes.

## Wikipedia (MediaWiki Action API)

**Used for:** `describe_species`, the `wikipedia` field on the species-bearing
resources (`species`, the DNP survey and the three DNP reference tables), and the
plain `GET /wiki` route the app's own species page reads. One keyless server-side
lookup of the English lead section, by scientific or common name (`src/wiki.ts`).
No key, no account, no CORS — the same shape as Open-Meteo above.

**What worked.** The Action API is keyless and stable, and `prop=extracts` with
`exintro=1&explaintext=1` returns exactly what the surface needs: the plain-text
lead, no wiki markup, no infobox, no lead image. That last point matters here —
the app's photograph model is strict about provenance
(`photoUrl`/`photoCredit`/`photoLicense`/`photoRef`, SPECIES-ENCYCLOPEDIA-PLAN
§8), and pulling Wikipedia's lead image would collide with it, so the tool is
deliberately text-only. Because the fetch happens server-side, the browser never
touches Wikipedia directly and the app needs no second CORS story.

**What needed work (friction we hit).**

- **A missing article is still a "page".** The query returns a `pages` object
  whose single entry carries `missing` rather than an empty result, so "no
  article" and "article found" share one shape and differ by one key. The code
  checks `missing` explicitly; a caller that only checks for a non-empty `pages`
  would render a missing article as if it existed.
- **Redirects are opt-in.** Common names redirect (a vernacular name to the
  scientific article) and only `redirects=1` follows them; without it a plain
  lookup silently misses. Requested by default here.
- **Attribution is a licence obligation, not a payload field.** The text is
  CC BY-SA 4.0 and the API returns no credit string, so "Wikipedia · CC BY-SA
  4.0" plus the canonical `fullurl` is composed in code and carried on every
  response — the tool's spoken line and the app's section both name Wikipedia
  and say the text may be incomplete or unverified.
- **The lead is not necessarily this taxon's profile.** `exintro` returns the
  article's lead, which for a common name may be a genus- or family-level
  article rather than the exact species, so the text is presented as *external
  reference* the species page only ever adds, never as Globie data.

**Feature requests.** (1) Mark a missing page unambiguously — or answer with no
`pages` at all — so "absent" cannot be read as "present". (2) Return the licence
and canonical credit URL as first-class fields on an `extracts` response, since
full attribution is otherwise the caller's to reconstruct.

**Build again?** Yes. Keyless, fast, and the plain-text lead is the right unit of
text for both a voice answer and a detail-page section.

## Podcast Index

**Used for:** `search_podcasts` and `get_trending_podcasts`, called through the
`podcast` proxy (`PODCAST_URL`), which holds the key and secret.

**What worked.** A clean REST surface for real podcast search, and the proxy
split is the right shape: the key never leaves the server side.

**What needed work.** The free tier is **10 requests/minute**, which is enough
for a demo but is a design constraint, not a detail — caching belongs in front of
it. When the keys are absent the proxy returns 503, and the MCP tool surfaces an
honest explaining error rather than an empty feed, which is the behaviour we
want. One deployment gap remains on our side: the public hostname
`podcast.globie.earth` is **not in the Easypanel panel's Domains** for the `podcast`
service. The zone carries a wildcard `*.globie.earth`, so the hostname still
resolves — but to the Easypanel **edge**, which answers an HTML 404, so the live
tool reaches the origin and reports the 404 truthfully instead of listing shows.
The tell is the body: an HTML 404 is the edge, a JSON 404 is the service itself
(`studio` is fine — its `/` 404s as JSON because a Fastify app has no root route,
while `/v1/studio/health` answers 200). Fix is infra (add the domain, then re-probe
the service's own health route), not an MCP code issue.

**Build again?** Yes.

## Suno

**Used for:** `generate_soundscape`, called through the `studio` proxy
(`STUDIO_URL`), which holds the key.

**What worked.** Rendering is asynchronous, and the API (via the proxy) models
that honestly: the tool returns a track id and a status of **`queued`**, never a
finished recording. The house rule — "a queued soundscape must never be described
as produced" — is satisfied by the contract itself, not by remembering to lie
less.

**What needed work.** Because generation spends a shared daily render quota
enforced by the proxy, the tool has to be annotated mutating, and a 429 has to be
surfaced as a real, explainable failure. Async means the MCP call cannot hand back
audio in one turn; the Alexa+ host has to poll or narrate the wait. That is a
product-shape consequence worth calling out, not a defect.

**Build again?** Yes — the async queue is the correct shape for generative audio.

## OpenStreetMap-free services

**Status: not used by this artifact.** The plan's feedback checklist lists
OpenStreetMap-free services, but this server never calls one — the sanctuary
coordinate is a constant (`SANCTUARY_COORDINATE` in `src/conditions.ts`), not a
geocode lookup. Rather than manufacture an opinion about an API we did not build
against, this is recorded as "nothing to review here". If the wider app uses OSM
for map tiles, that is a different surface and would need its own log.

## Friction log (requests we would file upstream)

1. **MCP SDK — `resources/read` fails with `-32603 Invalid URL` for a
   non-absolute URI, and the message does not mention that the URI must be
   absolute.** Cost: time spent looking at the transport before the URI.
2. **MCP SDK — `resources/list` mixes templated instances and static resources
   under two different naming rules without documenting the difference.**
3. **Bedrock — "model not enabled in this region" is not distinguishable from an
   auth error in the message we receive.** Both surface as a failed call.
4. **Bedrock — no guidance for the off-AWS / no-instance-role case**, where
   long-lived env credentials are the only option and short-lived credentials are
   not available.
5. **Podcast Index — the 10 req/min free tier is not surfaced in the error path
   as a rate-limit condition**, so a burst looks like an outage unless you already
   know the limit.
6. **Wikipedia (Action API) — a missing article is returned as a page object
   carrying `missing`**, so "found" and "not found" share one shape and differ by
   one key.
7. **Wikipedia (Action API) — the licence and canonical credit URL are not part
   of the `extracts` response**, so the caller must reconstruct the CC BY-SA
   attribution itself.

---

_Last updated: 2026-10-09. The default embedding path is now self-hosted and
measured; the Titan latency/cost rows remain pending a live Bedrock run
(`EMBEDDING_PROVIDER=bedrock node scripts/bench-embed.mjs`). The Wikipedia
(Action API) entry and its two friction-log items were added with the
`describe_species` tool and the `GET /wiki` route. Everything else is written
from the build._
