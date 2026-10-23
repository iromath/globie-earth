# Globie Earth MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
Globie Earth's reforestation backend — its living catalogue of native species,
sites and guardian lore, its adoption records and its site conditions — as
tools an Alexa+ (or any other MCP) host can call.

This service is the **Alexa+ track submission**. It is self-hosted on the same
Easypanel stack as `studio` and `podcast` (reached at `https://mcp.globie.earth`)
and is deliberately host-agnostic: the only coupling to the rest of the stack is
four origins (`POSTGREST_URL`, `STUDIO_URL`, `PODCAST_URL`, `OPENMIND_API_URL`)
and two request headers. One tool and one route also reach the English Wikipedia
Action API, which is keyless and outside the stack entirely.

- **Transport:** MCP Streamable HTTP at `POST /mcp` (also `GET` for the optional
  server-to-client stream and `DELETE` to end a session).
- **Protocol version:** `2025-11-25`, pinned. The server refuses to boot if the
  SDK's newest supported version ever moves past it, so this line cannot quietly
  become false.
- **Responses:** `enableJsonResponse`, so a POST is answered with a plain JSON
  body rather than an SSE stream. The spec allows either; JSON survives the
  reverse proxy in front of the container with no buffering surprises.

## Tools

**55 tools in two groups.** The first group — 19 Globie Earth tools — exposes the
reforestation backend. Three of them change state (`adopt_species`,
`generate_soundscape` and `publish_soundscape`); the rest are read-only. The
second group — 36 **Openmind Travel** tools (prefixed `om_`) — wraps the
Openmind.Travel REST catalogue (tours, destinations, flights, guides, community,
trip planning and impact). All `om_` tools are read-only except
`om_save_trip_idea` and `om_save_itinerary`.

| Tool | What it does | Backend |
| --- | --- | --- |
| `search_forest_knowledge` | Search across species, sites and guardian lore, together with Globie Earth's four forest datasets (biodiversity survey, plant checklist, park fauna observations, wildlife checklist). Semantic when a provider is configured, keyword otherwise. | Self-hosted multilingual-e5-small by default (Amazon Titan V1 optional) → `catalog_search` RPC; keyword fallback reads the catalogue and `dnp_*` tables |
| `search_local_culture` | Searches Globie Earth's Local Culture collection — its own Thai cookbook, "Cookbook Version Kai & Shea" — by dish, ingredient, region or category. Semantic when a provider is configured, keyword otherwise. | Same `catalog_search` RPC, restricted to `entity_type = 'recipe'`; keyword fallback reads `cookbook_recipes` |
| `get_recipe` | One full recipe: English/romanised/Thai names, region, category, servings, total time, ingredients, numbered method with per-step times, and tips. Resolves by id, slug or dish name. | `cookbook_recipes` read (RLS-scoped, world-readable) |
| `recommend_species` | Recommends species from the caller's own past adoptions. | `recommend_species` RPC |
| `get_sanctuary_conditions` | Ambient CO₂, European AQI, humidity and air temperature at the site. | Open-Meteo (keyless, modelled fields) |
| `describe_photo` | Describes an attached photo — a plant, landscape, object, room or document. | DeepSeek `deepseek-v4-flash-vision-exp` or Amazon Bedrock Nova, chosen by `VISION_PROVIDER` (not the catalogue) |
| `describe_species` | The English Wikipedia lead section for one species, by scientific or common name, plus the lead image when it is provably freely licensed. | Wikipedia Action API (keyless, CC BY-SA 4.0) |
| `adopt_species` | Records an adoption (mutating). Idempotent when a store transaction id is supplied. | `create_adoption` + `award_eco_tokens` RPCs |
| `get_my_deeds` | The Living Deeds issued for this caller's adoptions, newest first. | `living_deeds` read (RLS-scoped) |
| `get_eco_balance` | This caller's eco-token balance. | `eco_token_balance` read (RLS-scoped) |
| `generate_soundscape` | Queues a generated piece of music for the site (mutating). | Studio proxy `POST /v1/studio/tracks` |
| `get_soundscape` | Checks a queued soundscape by its track id, and returns the audio URL once the render is ready. | Studio proxy `GET /v1/studio/tracks/:id` |
| `publish_soundscape` | Publishes one of the caller's finished soundscapes to the public sound library (mutating). | Studio proxy via `setTrackVisibility`; `studioLibrary` read |
| `search_web` | Live web search for anything the site's own records do not hold, returning pages with their own URLs and naming the open web as the source. | Tavily (external, not Globie data) |
| `search_podcasts` | Searches the podcast library for shows about the living world. | Podcast proxy `GET /v1/podcast/search` |
| `get_trending_podcasts` | Lists shows trending in the podcast library, optionally by category. | Podcast proxy `GET /v1/podcast/trending` |
| `get_podcasts_by_theme` | Lists the listening themes, or the shows matching one theme. | Podcast proxy `GET /v1/podcast/themes`, `GET /v1/podcast/bytheme` |
| `get_podcast_episodes` | Lists a show's episodes (newest first), each with its direct audio file URL, per-episode cover art, publish date and duration. | Podcast proxy `GET /v1/podcast/feeds/:id/episodes` |
| `get_podcast_stream_url` | Mints a signed, 2-hour proxy-stream URL for one episode's audio, for publishers that block direct hotlinking. | Podcast proxy `GET /v1/podcast/audio` |

`adopt_species` changes real state, so it is annotated mutating
(`readOnlyHint: false`). When the host passes the store's `reference`, a retry
resolves to the original deed and reports `replayed: true` instead of issuing a
second one. The tool records the adoption; it does not itself take payment.

On the Alexa Skill path `adopt_species` is held for a spoken yes before it runs.
The question names the species and the count, and says plainly that the call
records the adoption and takes no payment; only a "yes" re-routes it with
`confirmed: true`. Without that gate a stray "adopt a tree" could mint a Living
Deed on the strength of a prompt alone, since the Skill has no purchase to
verify against. `generate_soundscape` and `publish_soundscape` are gated the
same way.

`describe_photo` is the one tool that reads an image rather than the site's
own data: it hands the attached photo to the vision model and returns the model's
description, so a photo of *anything* — a tree or not — has a tool to match. Its
payload names the model and says the description is the model's reading of the
image, not a catalogue fact, so a host never presents it as Globie Earth data. It
takes the photo either as a `data:` URL (what the browser host sends, downscaled)
or as an `http(s)` URL, which the server **fetches and inlines itself** — see
*Images* under the tool router for why that step exists and what guards it.

`describe_species` is the one tool that reads text from outside the stack: it
fetches the English Wikipedia lead section for a species by name and returns it
verbatim. That text is **external reference under CC BY-SA 4.0**, not Globie
data, so the payload carries the article URL and a `source` line, and the tool's
spoken form names Wikipedia and says the text may be incomplete or unverified. It
also carries the article's **lead image**, but only when that image is *provably*
freely licensed: the payload then includes the image's own licence, its licence
deed and the Wikimedia file page it must be credited to, and it is `null` when no
free image exists. The tool reports that metadata and Wikimedia's thumbnail URL
without downloading anything — a spoken turn has no use for the bytes — while
`GET /wiki` below passes `hostImage: true` and copies the thumbnail into object
storage, so the app's species page serves it from our own origin. A name that
matches nothing returns a clear "no article" explanation rather than an empty
record.

The Local Culture tools, `search_local_culture` and `get_recipe`, read the
project's **own** cookbook, "Cookbook Version Kai & Shea" (Openmind Projects),
curated by hand into `scripts/data/cookbook-recipes.json` and imported by
`npm run import:cookbook` into `api.cookbook_recipes`
(`infra/schema/254_cookbook.sql`). The recipes are embedded into the **same**
flat `api.embeddings` space as the forest data, so `search_local_culture` is
`catalog_search` narrowed to `entity_type = 'recipe'` rather than a second search
engine. `search_forest_knowledge` is the forest tool, so it filters recipes out
of its results — the flat space can place a dish near a forest question, but a
cooking question belongs on this tool. `get_recipe` then returns the whole dish,
which a search passage does not carry. The content is Globie's own, so a host
never passes it off as a scraped recipe site.

`generate_soundscape` is mutating too, and it spends the stack's shared daily
render quota, which the studio proxy enforces. Rendering is asynchronous — the
tool returns a track id and a status of `queued`, never a finished recording, so
it must never be reported as produced. `get_soundscape` is its read-only
companion: it polls that track id and, once the render is `ready`, returns the
`audioUrl` a player can fetch. It spends no quota and changes nothing, so it is
safe to call repeatedly while a render runs. The studio and podcast proxies hold
the Gemini and Podcast Index credentials; this server holds neither.

`get_podcasts_by_theme` reads the shelf's curated listening themes — the same
list the app's Listen chips draw from, served by the proxy on
`/v1/podcast/themes`. A theme is a full-text topic, not a mirror category: the
mirror's category chips ("Society & Culture" and the like) name nothing a
listener would ask for, so each theme resolves as a search over the same local
index browse and search use, one `AND` per word of the label. Called with no
theme it returns the list; called with one it returns the shows matching it.
Every theme in the list is measured against the mirror before it ships, so each
one returns shows today — `Forest` alone answers 202 of them, each carrying
cover art, an episode count and a description.

### Openmind Travel tools (`om_*`)

The 36 `om_`-prefixed tools wrap the **Openmind.Travel** REST catalogue
(`https://bokunapi.9o9.io`, overridable via `OPENMIND_API_URL`). They are
discovered by Alexa+ the same way the Globie tools are — through `tools/list` —
and return the same `jsonResult(value, spoken)` shape (a JSON block for the
screen plus a `audience: ["user"]` spoken line). All hit the public REST API
directly; no caller identity or auth is needed for reads.

| Group | Tools | What they do |
| --- | --- | --- |
| **Tours** | `om_search_tours`, `om_get_tour_facets`, `om_get_tour`, `om_list_volunteer_projects`, `om_get_partner`, `om_search_suggestions` | Search tours & activities (Viator, Bókun, GetYourGuide), get tour details and facets, list volunteer projects, partner info, and search suggestions. |
| **Destinations** | `om_search_destinations`, `om_list_categories`, `om_list_countries`, `om_get_popular_destinations`, `om_autocomplete_airport` | Search destinations, browse categories/countries, popular destinations, and autocomplete airport codes. |
| **Guides** | `om_list_country_guides`, `om_get_country_guide`, `om_list_airline_guides`, `om_get_airline_guide`, `om_search_youtube_videos` | Country and airline travel guides, plus YouTube travel video search. |
| **Flights** | `om_search_flights`, `om_get_flight_calendar`, `om_search_transport` | Flight search (two-step: initiate → consume SSE stream of results), monthly price calendar, and ground/sea transport links. |
| **Community** | `om_get_globie_pet`, `om_list_community_posts`, `om_search_community_posts`, `om_get_community_post` | The Globie community feed and pet projection. User-generated content is labelled as such in the tool description. |
| **Trips** | `om_plan_trip`, `om_list_trip_ideas`, `om_get_trip_idea`, `om_save_trip_idea`, `om_get_itinerary`, `om_save_itinerary` | AI trip planning, trip-idea browsing, and itinerary save/load (`om_save_*` are the only mutating `om_` tools). |
| **Impact** | `om_get_impact_overview`, `om_list_impact_causes`, `om_get_impact_cause`, `om_get_impact_travel_options`, `om_list_impact_treasures`, `om_get_impact_treasure`, `om_get_impact_stories` | OpenmindProjects impact data: fundraising progress, SDG causes, impact treasures, stories, and travel options that fund projects. |

The impact data (causes, treasures, stories) is served from static data baked
into the server (`src/openmind/impactData.ts`); `om_get_impact_travel_options`
is the one impact tool that hits the live tours/projects API.

Two of the destination-browsing endpoints are empty upstream, and the tools
report that rather than hiding it. `om_search_destinations` and
`om_list_categories` both answer an empty list, because the catalogue behind them
(`GET /api/destinations/search` and `GET /api/categories` on `bokunapi.9o9.io`)
returns `200 []` for every input — verified 2026-10-16 against queries as varied
as `Bangkok`, `Japan` and `a`. Their siblings on the same host answer normally
(`/api/countries`, `/api/popular-destinations` and `/api/autocomplete/cities` all
return rows), so this is the upstream catalogue's own gap and not a mapping error
here. The two tools say "No destinations found." and "No categories available."
in the spoken line; nothing is substituted from another endpoint to paper over
it.

The browser MCP client (`infra/mcp-client/`) renders all 55 tools from
`tools/list` with no hard-coded list. Three trip-planning tools
(`om_plan_trip`, `om_save_trip_idea`, `om_save_itinerary`) take `array` or
`object` arguments; the client's form builder accepts those as JSON literals
(e.g. `["Bangkok", "Chiang Mai"]`) and parses them before the call goes out.

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
| `globie://dnp/{id}` | One surveyed species record from the biodiversity survey, by numeric id. |
| `globie://dnp-plant/{id}` | One species from the national plant checklist, by numeric id. |
| `globie://dnp-fauna/{id}` | One fauna record from the national-park fauna observations, by numeric id. |
| `globie://dnp-wildlife/{id}` | One species from the national wildlife checklist, by numeric id. |

The three catalogue templates are world-readable; `globie://me/deeds` is
device-scoped by row-level security, exactly like the tool it mirrors.

The four `globie://dnp-*` templates read the same forest datasets as
`search_forest_knowledge` — Globie Earth's own reference data. They
are addressed by numeric id only and are registered with `{ list: undefined }`,
so they are **not** enumerated by `resources/list` (the datasets run to tens of
thousands of rows, and the SDK skips any template without a `list` callback).
They still appear in `resources/templates/list` and still resolve on
`resources/read`; discover them by id through `search_forest_knowledge`.

## Prompts

| Prompt | What it is |
| --- | --- |
| `forest-guide` | The persona and tool-selection guidance for a voice companion to the site. |
| `adopt-a-tree` | The guided adoption flow: choose, confirm, then read back the Living Deed. |

`get_sanctuary_conditions` returns Open-Meteo **modelled** fields for the
site's coordinates, not readings from a sensor on site. The tool
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

Two providers stand behind the router, and the caller picks one by naming a model
id, never a key or an endpoint. DeepSeek is an OpenAI-compatible
chat-completions endpoint with function calling, configured by
`DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` / `DEEPSEEK_API_KEY`. **Amazon Bedrock
Nova** is served through the Bedrock **Converse API** and reuses the Bedrock
credentials (`BEDROCK_REGION` / `AWS_*`) the embedding provider already reads.
Both are read per request, so an env change needs no restart; a provider whose
credentials are missing is a clear `503` rather than a boot failure. The route is
gated by the same identity as `/mcp`, because an open `/route` would be a relay
that spends this server's key for anyone who finds it.

**Models.** A caller may name one of four — the provider-tagged allowlist
`ROUTER_MODELS` in `src/llm.ts`:

| Model id | Provider | Vision | Notes |
| --- | --- | --- | --- |
| `deepseek-flash` | DeepSeek | no | The default, and what `DEEPSEEK_MODEL` falls back to. |
| `deepseek-v4-flash-vision-exp` | DeepSeek | **yes** | Reads a photo alongside the utterance. |
| `amazon.nova-lite-v1:0` | Nova | **yes** | Cheaper Bedrock vision; needs the Bedrock credentials. |
| `amazon.nova-pro-v1:0` | Nova | **yes** | The default Nova model (`NOVA_MODEL`); needs the Bedrock credentials. |

A name off that list is refused (`400`) rather than forwarded, so the allowlist
cannot be walked past to bill some other model to this server's key. Omitting
`model` behaves exactly as it did before the vision model existed.

**Images.** With the vision model, an optional `image` turns the user message into
multimodal content. It must be a `data:image/…;base64,…` URL or an `http(s)` URL,
capped at 4,000,000 characters; the client downscales a photo to a 1024-px edge as
JPEG first, so it stays well under the cap and under the request body limit. An
image sent with a text-only model is refused (`400`) rather than silently ignored
— the text model would otherwise drop the photo without a word.

An `http(s)` URL is **fetched by this server and inlined as a data URL** before
the call is issued, because the OpenAI-compatible endpoint is handed the URL and
expected to download it itself and does not — it answers
`400 … Failed to download image from …`. The fetch is guarded: the image argument
is already narrowed to a `data:image/…;base64,…` or `http(s)` URL at each call
site (`isImageInput`), and the fetch itself shares the call's abort signal so it
cannot outlive the timeout, refuses anything whose content type is not `image/*`,
and enforces a byte ceiling that matches the character cap above. A URL that
404s, serves `text/html` or is too large comes back as a plain explanation rather
than a model error. Nova needs no such step: the Converse API takes image
*bytes*, so `src/llm.ts` already fetched there.

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

## Alexa Skill — `POST /alexa`

A **Skill** is a different Amazon product from the Alexa+ add-on this server was
built for, and a different submission pipeline. An add-on hands our tools to
Alexa+'s own planner and needs no interaction model at all; a Skill is the older
product, where the developer declares the intents and Alexa sends back a matched
one. The Skills console is live for this account even while the Alexa+ add-on
console still reads "Coming Soon", so this route is the bridge that lets the same
tools answer on either.

It is deliberately the thinnest adapter that could work — it adds no tool, no
model and no data of its own:

| The route… | …is the existing code |
| --- | --- |
| builds the MCP surface | `buildServer(caller)` (`src/mcp-server.ts`), in-process over `InMemoryTransport` — no HTTP hop, and no second implementation of the tools |
| picks a tool | `routeToTool(...)` (`src/router.ts`), the same router `POST /route` uses: same allowlist, same provider billing, same refusals |
| runs it | `client.callTool(...)` on that in-process surface |
| speaks the answer | `src/alexa.ts`, which drops markdown, links and data URLs and cuts at a sentence boundary, because tool payloads are written for a screen |

```
POST /alexa           no X-Device-Id — this is Amazon's envelope, not ours
{
  "version": "1.0",
  "session": { "application": { "applicationId": "amzn1.ask.skill.…" },
               "user": { "userId": "amzn1.ask.account.…", "accessToken": "…" } },
  "request": { "type": "IntentRequest",
               "timestamp": "2026-10-16T00:00:00Z",
               "intent": { "name": "AskGlobieIntent",
                           "slots": { "query": { "value": "trees that fix paddy soil" } } } }
}
→ { "version": "1.0",
    "response": { "outputSpeech": { "type": "PlainText", "text": "…" },
                  "reprompt": { "outputSpeech": { "type": "PlainText", "text": "…" } },
                  "shouldEndSession": false } }
```

**One catch-all intent among 25 custom ones.** `AskGlobieIntent` carries a
single `AMAZON.SearchQuery` slot named `query`, and every sample that reaches
the router funnels into it — `tell me more about {query}`, `what do you know
about {query}`, `find {query}`, `to find {query}` … — so Alexa's job is to hand
over the words and the router's job is to decide what they mean. The samples are
*carrier phrases*, not a list of supported questions: they cover the three the
help prompt advertises (`about`, `what`, `to find`), and any phrasing that opens
with one of them reaches the same router a typed question would. A bare
`about {query}` sample was removed on 2026-10-23 — it carried too little lexical
signal and fell to `AMAZON.FallbackIntent`. The other 24 custom intents cover
audio playback, soundscape publishing, the TV relay and Guess Who, and answer
their backends directly rather than through the router.

**The spend gate.** `generate_soundscape`, `publish_soundscape` and
`adopt_species` are listed in `CONFIRMATION_REQUIRED`. A call to one of them
without `confirmed: true` is not run: the adapter speaks a question that names
what it is about to do and returns `awaitingGoAhead`. The sentence is kept on the
session, and a bare "yes" (`AMAZON.YesIntent`) re-routes that same sentence with
`confirmed: true`. A "no" drops it. This matters most for adoption, where the
Skill has no purchase to check against — the spoken yes is the only thing between
a stray phrase and a new Living Deed.

**What a Skill cannot do, and what this does about it.** `AMAZON.FallbackIntent`
is delivered with **no utterance at all**: when the model fails to match, there
is nothing left to route. There is no honest way to answer, so the Skill asks the
listener to rephrase. That is why the interaction model carries explicit carrier
phrases rather than relying on a bare catch-all — a Skill whose only sample was
`{query}` would have nothing to match on, and worse, an `AMAZON.SearchQuery` slot
is only legal *with* a carrier phrase in the same sample. `AMAZON.StopIntent`,
`AMAZON.CancelIntent` and `AMAZON.HelpIntent` are answered from fixed copy.

**Identity.** An ASK request carries no `X-Device-Id`, so the caller is resolved
in two steps (`callerFor` in `src/alexa.ts`): an account-linking `accessToken`
when the listener has linked one — the same OAuth 2.1 token `src/oauth.ts` issues,
accepted by `resolveCaller` unchanged — and otherwise a device id derived
deterministically from Amazon's `userId` (`sha256('globie-alexa:' + userId)`,
shaped like a v5 UUID). Deriving rather than generating one matters: the
device-scoped RPCs mean a random id per request would leave a listener unable to
hear their own deeds read back, and nowhere for an adoption to land. Derived, the
same listener keeps the same site across sessions.

**Signatures.** `/alexa` proves Amazon sent the request before it spends
anything: the `SignatureCertChainUrl` and `Signature` headers, the chain's issuer
name and validity window, an RSA-SHA256 check over the *raw* body bytes, a
150-second clock window and the `applicationId`. See `src/alexa-verify.ts`. The
raw bytes are why `src/server.ts` replaces Fastify's JSON parser with the same
parser plus one addition — it keeps the buffer on the request as `rawBody` —
because re-serialising the parsed object would change key order and whitespace,
which is exactly what the signature covers.

Verification is **on** unless `ALEXA_VERIFY_SIGNATURE=false`, which is for local
development only: with it off, anyone who can reach the port can spend this
server's model key through `/alexa`, and every unverified request is logged as a
warning. `ALEXA_SKILL_ID` names the skill whose `applicationId` is accepted;
while it is unset the id check cannot run, which `GET /health` reports.

### Try it without Amazon

```bash
npm run simulate:skill                                      # local server
ALEXA_URL=https://mcp.globie.earth/alexa node scripts/simulate-alexa-skill.mjs
```

The script posts real ASK envelopes and prints the spoken reply, so the whole
voice path — envelope, router, tool, speech — can be checked before anything is
registered. It is two-mode, because `/alexa` is: against a server with
verification on it asserts the unsigned request is refused with `401`, which is
the proof the door is shut and the only check possible from outside Amazon; with
`ALEXA_VERIFY_SIGNATURE=false` it walks `LaunchRequest`, the catch-all intent with
a real query, `HelpIntent`, `FallbackIntent` and `StopIntent`, asserting each
returns speech. Run against production while the deployed image predates this
route, it reports the `404`.

### Registering it

Two files, both under `skill-package/`, both pasted into the developer console:

| File | Where it goes |
| --- | --- |
| `interactionModel.json` | the console's interaction-model **JSON editor** (or `ask deploy`) |
| `skill.json` | the skill **manifest**, whose `apis.custom.endpoint.uri` is `https://mcp.globie.earth/alexa` |

The endpoint must be HTTPS with a trusted certificate — it is, it is the same
host as `/mcp`. Nothing about the Alexa+ add-on path changes: the two live side
by side on one server and one tool surface.

The full voice reference — every intent and sample utterance, a spoken command
for each tool, the TV relay and the 15-step smoke-test set — is in
[`Dev-Docs/ALEXA-VOICE-COMMANDS.md`](../../Dev-Docs/ALEXA-VOICE-COMMANDS.md).

## Wikipedia lookup — `GET /wiki`

The same Wikipedia lead `describe_species` answers with, as a plain HTTP read,
so the app's own species page can show it without speaking MCP. It is text the
app only ever *adds* to a record, so a species with no article — or a moment when
Wikipedia is unreachable — simply leaves the section out.

```
GET /wiki?name=Dipterocarpus%20alatus   X-Device-Id (or demo bearer) required — the same identity /mcp takes
→ { "title": "Dipterocarpus alatus", "extract": "…",
    "url": "https://en.wikipedia.org/wiki/Dipterocarpus_alatus",
    "license": "Wikipedia · CC BY-SA 4.0",
    "image": { "url": "…", "license": "CC BY-SA 4.0", "licenseUrl": "…",
               "credit": "…", "descriptionUrl": "…" } }   // null when the article has no free image
→ 404 when Wikipedia has no article for that name
```

Attribution is not optional: a caller that renders the text must name Wikipedia
and link to `url`, because the text is CC BY-SA 4.0. An `image` is returned only
when its licence is *provably* free, and it arrives with everything the credit
requires — its own licence, the licence deed, the rights holder and the Wikimedia
file page — so a caller that shows the picture can show the credit that goes with
it. This route is the one caller that asks for the bytes: it passes
`hostImage: true`, and `src/wiki.ts` copies Wikimedia's thumbnail into object
storage rather than hot-linking their CDN. That copy is best-effort, exactly like
every other optional dependency here — an unconfigured `MINIO_*`, a failed upload
or an image above 6 MB leaves `url` pointing at Wikimedia's own thumbnail instead
of dropping the picture, and `image` is `null` only when the article has no free
lead image. The text always stands alone. Implemented once in `src/wiki.ts`, and
shared by this route, the `describe_species` tool (which reports the same
metadata without downloading), and the `wikipedia` field on the species-bearing
resources.

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
{ "text": "Kae Na fixes paddy soil." }                 // voice is optional
→ audio/mpeg  (Kokoro, af_heart)
```

`/voice/speak` takes an optional `voice` naming one of the ids `GET /health`
lists under `speech.voices` — Kokoro's voice set, or Polly's neural English set —
so the client can pick whose voice reads a reply; any other name is refused
rather than relayed. Naming none speaks the configured default (`SPEECH_TTS_VOICE`
for Kokoro, `POLLY_VOICE_ID` for Polly).

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
the forest data carries — which fits alongside Kokoro (~480 MiB resident
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
  "speciesId": 12,                // the dataset row id
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
route is unconfigured — the credentials of the `VISION_PROVIDER` in use
(`DEEPSEEK_API_KEY` for DeepSeek, the Bedrock `AWS_*` for Nova) for the scan, or
the `MINIO_*` set for storage.

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

## Authentication (three paths, two of them ours)

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

**This static token is a shared demo secret standing in for a device identity**,
not MCP OAuth 2.1 — treat it like any other secret: server-side only, never a
`VITE_` variable.

### MCP OAuth 2.1 (the production path, now built)

Beside the demo secret, the server now implements the OAuth 2.1 surface Alexa+
reads before it will register an add-on (`src/oauth.ts`, MCP plan §21 Phase 1).
It is dormant until `MCP_OAUTH_SECRET` is set; `/health` reports it under
`oauth`.

- **Discovery** — `GET /.well-known/oauth-protected-resource` (RFC 9728, plus a
  `/mcp`-suffixed alias) and `GET /.well-known/oauth-authorization-server`. The
  latter advertises `code_challenge_methods_supported: ["S256"]`, without which
  the client refuses the flow.
- **Tier 1 — `client_credentials`** (`scope=mcp:service`), for machine callers
  that register the add-on, enumerate tools/resources and poll `/health`.
  Tokens live at most 3600 s and carry **no refresh token**.
- **Tier 2 — `authorization_code` + PKCE `S256`** (`mcp:tools` / `mcp:resources`),
  entered only when a user-specific tool is first invoked. `/oauth/authorize`
  validates `redirect_uri` against an exact allowlist **before** redirecting, so
  it cannot be an open redirector. This build has no user directory, so it mints
  a code bound to `MCP_OAUTH_USER_DEVICE_ID` and redirects — the honest limit of
  this implementation, stated rather than dressed up.
- **Tokens** are self-contained HMAC-SHA256-signed payloads, verified with no
  store, so the surface survives a restart. `/mcp` accepts them the same way it
  accepts the static bearer (`src/identity.ts`); the token's scoped device id
  becomes the caller. Access tokens are never forwarded to PostgREST.

Not supported (and none claimed): DCR, CIMD, OIDC, step-up auth, and a
`WWW-Authenticate` header on the `/mcp` 401 — that reply is intentionally a
plain body. The endpoints are exact; a wrong client secret is a `401
invalid_client`, a reused code is a `400 invalid_grant`, and a failed PKCE
check is a `400 invalid_grant`.

## Configuration

These are the names the process reads. In `infra/.env` the four origins carry the `MCP_` prefix — `MCP_POSTGREST_URL`, `MCP_STUDIO_URL`, `MCP_PODCAST_URL`, `MCP_SPEECH_URL` — which `infra/docker-compose.yml` maps onto the container-level names below; every other variable keeps the same name in both places. See `infra/.env.example` for the full commentary.

| Variable | Required | Meaning |
| --- | --- | --- |
| `POSTGREST_URL` | **yes** | API origin, e.g. `https://api.globie.earth`. The container refuses to start without it. Locally, compose defaults it to `http://rest:3000`. |
| `STUDIO_URL` | no | Origin of the studio proxy, for the soundscape tools. Unset only disables those tools, which then explain themselves. Locally, compose defaults it to `http://studio:8080`. |
| `PODCAST_URL` | no | Origin of the podcast proxy, for the five podcast tools. Unset only disables those tools, which then explain themselves. Locally, compose defaults it to `http://podcast:8080`. |
| `OPENMIND_API_URL` | no | Origin of the Openmind.Travel REST catalogue, for the 36 `om_*` travel tools. Defaults to `https://bokunapi.9o9.io`. Unset leaves the tools working at the default. |
| `PORT` | no | Listen port. Defaults to `8080`, which is what the image exposes. |
| `MCP_BEARER_TOKEN` | no | The demo static bearer. Unset disables the demo path. |
| `MCP_DEMO_DEVICE_ID` | no | The uuid the demo token resolves to. Must exist in `api.devices`. |
| `MCP_OAUTH_SECRET` | no | HMAC key for the OAuth 2.1 surface (`src/oauth.ts`). Unset leaves it dormant (`/health` shows `oauth.configured:false`). Generate with `openssl rand -hex 32`. |
| `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET` | no | The single registered OAuth client. Needed for Tier 1 `client_credentials` and checked (id only) at `/oauth/authorize`. |
| `MCP_OAUTH_REDIRECT_URIS` | no | Comma-separated exact redirect-URI allowlist for the Tier 2 flow. Empty refuses every authorize (no open redirect). |
| `MCP_OAUTH_USER_DEVICE_ID` | no | The uuid a Tier 2 user token is bound to. Falls back to `MCP_DEMO_DEVICE_ID`. |
| `MCP_PUBLIC_URL` | no | Public origin used as the OAuth issuer and in the discovery docs. Unset derives it per request from `Host`. |
| `MCP_CORS_ORIGINS` | no | Comma-separated literal origin list for browser clients. Non-browser MCP hosts send no `Origin` and are unaffected. |
| `EMBEDDING_PROVIDER` | no | `local` (default), `bedrock` or `none`. `none` is a valid configuration, not a broken one — see below. |
| `EMBEDDING_CACHE_DIR` | no | Where the local model's weights are cached. Defaults to `.cache`; the image sets it to `/app/.cache`. |
| `BEDROCK_REGION` / `AWS_REGION` | no | Region for Bedrock. Either works. Read by `EMBEDDING_PROVIDER=bedrock` and by any Nova-targeted model call. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | Credentials for a service running off AWS. An instance role is the production path on AWS. Needed by Titan embeddings and by any Nova-targeted call. |
| `AWS_BEARER_TOKEN_BEDROCK` | no | Alternative to the key pair above: a Bedrock API key (the Bedrock console's *API keys* page). When set, the SDK signs with `httpBearerAuth` instead of SigV4. Set this **or** the pair above, not both. |
| `DEEPSEEK_BASE_URL` | no | OpenAI-compatible base for the tool router (`POST /route`). Defaults to `https://api.deepseek.com/v1`. |
| `DEEPSEEK_MODEL` | no | Default router model. Defaults to `deepseek-flash`; a caller may override it with an id from the router's allowlist (see *Tool router*). |
| `DEEPSEEK_API_KEY` | no | Key for the tool router. Unset leaves `/route` a clear `503`; the MCP tools are unaffected. |
| `NOVA_MODEL` | no | Bedrock Nova model id used by any Nova-targeted call. Defaults to `amazon.nova-pro-v1:0`. Reuses the Bedrock credentials above. |
| `VISION_PROVIDER` | no | `deepseek` (default) or `nova`. Selects the provider for the two vision surfaces (`describe_photo`, `/contribute`). Read per request. |
| `RERANK_ENABLED` | no | `true` (default) or `false`. Turns the `search_forest_knowledge` rerank stage on/off (MCP plan §16). |
| `RERANK_PROVIDER` | no | `deepseek` (default) or `nova`. Selects the provider for the rerank pass. Read per request. |
| `RERANK_POOL` | no | Candidate rows fetched before reranking, then sliced to 8. Defaults to `20`. |
| `RERANK_TIMEOUT_MS` | no | Per-call budget for the rerank model. Defaults to `20000` (matches the router's upstream timeout; a live VPS→DeepSeek call measured ~9s); expiry falls back to the cosine order. |
| `SEARCH_LATENCY_BUDGET_MS` | no | Latency ceiling for a whole search, in ms. When set and the rerank's own cap (`RERANK_TIMEOUT_MS`) exceeds it, the rerank is skipped outright and the in-process cosine order is returned, reporting `ranking: "cosine"` — the Alexa-facing path, whose round-trip must stay under 500 ms (MCP plan §20.3 gap 4 / §21 Phase 3). `0` or unset = no ceiling (the web client's case; a live call measured ~21 s end-to-end on 2026-10-15 when the ceiling was absent). |
| `DEEPSEEK_RERANK_MODEL` | no | Model for the rerank pass when `RERANK_PROVIDER=deepseek`. Defaults to `DEEPSEEK_MODEL`; needs no key of its own. |
| `MINIO_ENDPOINT` | no | S3-compatible origin for the media bucket, e.g. `http://minio:9000` locally. Unset disables `/contribute`, which then answers a clear `503`. |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | no | Bucket credentials. **Server-side only** — never a `VITE_` variable, never sent to a browser. Unset disables `/contribute` (`503`). |
| `MINIO_BUCKET` | no | The bucket photos are written to. Created with a public read policy on first upload. Defaults to the app's media bucket (`globie-media`). |
| `MINIO_REGION` | no | S3 region string. Defaults to `us-east-1`; MinIO accepts it and ignores it. |
| `MINIO_PUBLIC_URL` | no | The URL prefix a browser can actually read, when it differs from `MINIO_ENDPOINT` (e.g. an internal hostname vs. a public relay). Defaults to `${MINIO_ENDPOINT}/${MINIO_BUCKET}`. |
| `SPEECH_URL` | no | Origin of the speech service (Speaches: STT + TTS) for `/voice/*`. Unset leaves those routes a clear `503`; the MCP tools are unaffected. |
| `SPEECH_STT_MODEL` | no | Speech-to-text model id. Defaults to the multilingual `Systran/faster-whisper-base`. |
| `SPEECH_TTS_MODEL` | no | Text-to-speech model id. Defaults to `speaches-ai/Kokoro-82M-v1.0-ONNX`. |
| `SPEECH_TTS_VOICE` | no | The Kokoro voice `/voice/speak` speaks with by default. The client may pick any id `/health` advertises under `speech.voices` instead. Defaults to `af_heart`. |
| `ALEXA_SKILL_ID` | no | The skill id (`amzn1.ask.skill.…`) whose `applicationId` `/alexa` accepts. Unset skips that check only; `GET /health` reports it under `alexa.skillId`. |
| `ALEXA_VERIFY_SIGNATURE` | no | `true` (default) verifies Amazon's request signature on `/alexa`. Set `false` for local development only — it leaves `/alexa` an open path to this server's model key. |

The two media/speech feature groups fail closed and in isolation: an unset
`MINIO_*` group disables only `/contribute`, and an unset `SPEECH_URL` disables
only `/voice/*`. Neither affects the MCP tools, and neither crashes the
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

[RUNTIME-EVIDENCE.md](./RUNTIME-EVIDENCE.md) is a verbatim transcript of one such
run — the SDK client above plus the browser host — captured as the repo-side
proof the plan's §20 risk table asks for ("MCP named in README but never called"
is an explicit disqualifier).

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
