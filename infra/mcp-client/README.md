# Globie Earth — MCP client

A real **Model Context Protocol** client for the Globie Earth MCP server, and the
runtime hook the **Alexa+ track** asks for.

This page *is* an MCP host. It opens a Streamable HTTP session against the server
with the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk),
runs the `initialize` handshake, then lists and calls whatever the server
advertises. The tool forms are built from the JSON Schema each tool returns, so
nothing about the surface is hard-coded here — add a tool to the server and it
appears.

That distinction matters for judging: the MCP server is not named in a README and
left un-called. This is a client running the same code path a host runs.

## Run it

```bash
cd infra/mcp-client
npm install
npm run dev          # http://localhost:5173
```

Then, in the page:

1. **MCP endpoint** — prefilled to `http://localhost:8092/mcp` on a local host,
   or `https://mcp.globie.earth/mcp` anywhere else. Type over it to point
   somewhere else.
2. **Device id** (`X-Device-Id`) — a uuid, generated once and kept in
   `localStorage`. It is the RevenueCat `appUserID`; the server's row-level
   security uses it to scope your deeds and eco balance, so the same id sees the
   same history on every visit.
3. **Demo bearer token** — optional. Only needed when the server has
   `MCP_BEARER_TOKEN` set.

Click **Connect**. The **Handshake** panel then shows the server name, protocol
version, session id and capabilities that `initialize` actually returned.

## Point it at a local server

```bash
cd infra/mcp
npm install
npm run build
POSTGREST_URL=http://localhost:3001 EMBEDDING_PROVIDER=none PORT=8092 npm start
```

`EMBEDDING_PROVIDER=none` is a valid configuration, not a broken one: every tool
works, and `search_forest_knowledge` explains that semantic search is switched
off instead of returning an empty result.

## CORS — the one thing that will trip you up

The browser sends an `Origin` header, so the server must allow this page's origin
via `MCP_CORS_ORIGINS`. Locally that is the default:

```
MCP_CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

Deploying this client anywhere else means adding its origin to that list — a
literal match, not a wildcard. Non-browser MCP hosts send no `Origin` and are
unaffected.

If the connect fails with *"Could not reach the endpoint"*, the page says so
plainly; check that the server is up and that its `MCP_CORS_ORIGINS` includes
`window.location.origin`. (A CORS failure looks identical to a dead server from
`fetch`, which is why the message names both.)

## Verify the build

```bash
npm run typecheck    # tsc --noEmit
npm run build        # tsc + vite build → dist/
npm run preview      # serve dist/ on http://localhost:4173
```

The production build bundles the MCP SDK into the browser bundle — the SDK's
Streamable HTTP transport and `Client` import no `node:` built-ins, so a real MCP
client runs in a browser with no polyfills.

## The router model, the photo and the voice

The **Voice** panel adds controls to the ask row:

- **Router model** — which model `POST /route` uses: `deepseek-flash` (text) or
  `deepseek-v4-flash-vision-exp` (reads a photo). The ids mirror `ROUTER_MODELS`
  in `infra/mcp/src/router.ts`; the server refuses any other name.
- **Photo** *(optional)* — attach an image for the vision model. The page
  downscales it to a 1024-px edge and sends it as a JPEG data URL with your next
  question, and only to the vision model. With a text-only model selected, the
  server refuses the photo rather than ignoring it.
- **TTS voice** — which voice the server's own mouth reads replies with. The
  options are the ids the server advertises under `speech.voices` in `/health`
  (its configured voice first), and the server refuses any other id, so the list
  cannot drift from the server. It applies only to the server's mouth: while
  replies fall back to the browser's speech synthesis the control is disabled and
  reads "Browser voice". Leaving the configured default selected is the same as
  before this control existed.
- **Play reply / Stop reading** — the two controls over the AI's spoken voice.
  **Play reply** repeats the last reply aloud (disabled until there is one), and
  **Stop reading** silences a reply the moment it starts, so neither the server's
  voice nor the browser's has to be waited out or talked over.

The page never holds a model key. It sends a model *name* to the server, which
owns the credential, and the answer says which model answered (`via …`).

## The soundscape player

A generated soundscape is queued, not finished: `generate_soundscape` renders
asynchronously and answers with a track id and a status of `queued`. So when a
tool result carries a soundscape, the page reveals the **Your soundscape** panel
and — without a second tap — polls the read-only `get_soundscape` tool for that
track until the render turns `ready` (quickly at first, then backing off, and
giving up after a bounded number of checks). The moment it is ready, the panel
hands over the browser's own audio player — a real playbar with play, seek and
volume — pointed at the studio origin, and says to press play.

The audio is fetched from the studio origin, not from this page or the MCP
server, so the page derives that origin from the endpoint it connected to the
same way it derives the API base (`mcp.*` → `studio.*`, localhost → the local
studio port). While the render is still running the panel says so and keeps
checking; if it fails, the panel shows the studio's reason.

## Evidence, not vibes

The **Transcript** tab is an operation log of the session — method, direction and
what came back — and it exports as JSON. Copy or download it to show that the
tools were really called at runtime. It is a client-side log, not a packet
capture, and it is labelled as such.

## Tool forms

Each tool's form is built from the JSON Schema the server returns in
`tools/list`, so nothing about the surface is hard-coded. Field types map to
controls like this:

| Schema type | Control |
| --- | --- |
| `string` | text input |
| `integer` / `number` | number input |
| `boolean` | checkbox |
| `enum` | dropdown |
| `array` / `object` | text input (enter JSON) |
| `string` naming a photo | file picker (or paste a URL) |

`array` and `object` fields (used by the Openmind.Travel trip-planning tools
`om_plan_trip`, `om_save_trip_idea` and `om_save_itinerary`) accept a JSON
literal — e.g. `["Bangkok", "Chiang Mai"]` for an array, or
`{"destination": "Bangkok"}` for an object. The value is parsed before the call
goes out; a malformed literal is dropped rather than sent as a string.

A photo field is a `string` whose argument is named `image` or whose description
mentions a `data:image/…` URL — today that is `describe_photo`. Nobody can type a
base64 data URL by hand, so the field shows a file picker instead: the chosen
photo is downscaled to a 1024-px edge as JPEG in the browser and the resulting
data URL is what the tool receives. A text box stays beside it for a photo that
already has a public http(s) URL. As with every other field, this is read from
the schema rather than from a list of tool names.

## What this is not

- The demo bearer token is exchanged at the MCP edge for a device identity. It is
  **not MCP OAuth 2.1**, and the page does not claim it is.
- The microphone button uses the **Web Speech API**, not an Alexa wake word. It
  is a convenience for the demo; the MCP surface is the point.
- Voice answers are read aloud by the browser's speech synthesis. Where the
  browser has no support, the page says so rather than failing silently.

## Files

| Path | What it is |
| --- | --- |
| `src/mcp.ts` | The MCP client wrapper — connect, list tools/resources/prompts, call/read/render, and the transcript. |
| `src/main.ts` | DOM wiring: handshake panel, tool forms from JSON Schema, per-tab rendering. |
| `src/voice.ts` | Web Speech API in/out, with graceful fallback when unsupported. |
| `src/style.css` | The dark-forest styling. |
| `index.html` | The four panels: Connect, Handshake, Voice, Surface. |
| `Dockerfile` | The nginx static-build image: a Node build stage runs `npm run build`, then nginx serves `dist/`. |
| `nginx.conf` | Cache policy — hashed assets immutable, `index.html` revalidated, SPA fallback. |
