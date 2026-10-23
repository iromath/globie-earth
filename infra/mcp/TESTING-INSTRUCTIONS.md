# Testing the Globie Earth Alexa Skill

This is the hands-on test sheet for the **Globie Earth** Alexa custom skill: what to say, which
intent should fire, what the skill should answer, and which of those paths have actually been
observed. It is written so a reviewer can run the voice path in about ten minutes, and so a
reader without console access can still verify the same claims from the outside.

Everything here is derived from three files, not from memory:

| Claim type | Source of record |
|---|---|
| Which utterance is registered | [`interactionModel.json`](https://github.com/iromath/globie-earth/blob/main/infra/mcp/skill-package/interactionModel.json) |
| What the skill does when it fires | [`src/alexa.ts`](https://github.com/iromath/globie-earth/blob/main/infra/mcp/src/alexa.ts) |
| Which turns were actually observed | [`EVIDENCE-INDEX.md`](EVIDENCE-INDEX.md) and the PNGs in [`captures/`](captures/) |

---

## 1. The skill at a glance

| Property | Value |
|---|---|
| Invocation name | `globie earth` |
| Skill id | `amzn1.ask.skill.1477cb4f-7432-4548-829e-ae0b1804dc26` |
| Stage / locale | Development, `en_US` |
| Endpoint | `https://mcp.globie.earth/alexa` (HTTPS, trusted certificate) |
| Hosting | Our own Fastify service. **No Lambda.** Signature verification is on. |
| Interfaces | `AUDIO_PLAYER` |
| Intents | 36 — 10 built-in, 26 custom |
| Custom slot types | 2 — `GameChoice` (`one`/`two`/`three`), `PodcastTheme` (10 themes) |
| Tools reachable by voice | 55, through the `AskGlobieIntent` router |
| Account linking | Not required for any test below |
| Payment | None. `allowsPurchases: false`. Adoption records a deed and takes no payment. |

What the skill is *not*: it does not control the TV directly. It queues a typed command and the
Vega TV app long-polls for it. Every TV turn therefore needs the TV app running and paired.

---

## 2. Access — two routes

### 2.1 Voice route (needs the Alexa developer account that owns the skill)

A skill in **Development** stage is only invocable from the account that owns it. Use either:

- an Echo device signed into that account, or
- the developer-console simulator:
  `https://developer.amazon.com/alexa/console/ask/test/amzn1.ask.skill.1477cb4f-7432-4548-829e-ae0b1804dc26/development/en_US/`

No credentials, API keys, account linking or purchase are needed. If you do not have that
account, use §2.2 — it tests the same deployment without asking you to trust a transcript.

### 2.2 Non-voice route (anyone, ~2 minutes)

These three checks run from a terminal and need no Amazon account:

```bash
# 1. The service behind the skill is up, and reports what is really configured.
curl -s https://mcp.globie.earth/health
```

Expect `"ok": true`, `"protocolVersion": "2025-11-25"`, `"embedding.provider": "local"`,
`"router.model": "deepseek-flash"`, `"speech.ttsProvider": "polly"`, and
`"alexa.skillId": "amzn1.ask.skill.1477cb4f-7432-4548-829e-ae0b1804dc26"`.
`"oauth.configured": false` is expected — OAuth is implemented but dormant on this deployment.

```bash
# 2. The /alexa door is shut to anyone who is not Amazon. This should be a 401.
curl -s -X POST https://mcp.globie.earth/alexa \
  -H 'Content-Type: application/json' \
  -d '{"version":"1.0","request":{"type":"LaunchRequest"}}'
```

Expected body: `{"error":"Alexa request verification failed: the request carried no Signature /
SignatureCertChainUrl header"}`. A 200 here would be a security defect — it would make the
endpoint an open relay onto a billed model key.

```bash
# 3. The skill definition is public, so the intent list can be read rather than taken on faith.
curl -s https://raw.githubusercontent.com/iromath/globie-earth/main/infra/mcp/skill-package/skill.json
```

Both `skill.json` and `interactionModel.json` live in the public repo under
`infra/mcp/skill-package/`.

The TV half of the story cannot be tested remotely; it needs a Vega device or the Vega virtual
device. The recorded frames in [`captures/`](captures/) are the evidence for it, and
[`EVIDENCE-INDEX.md`](EVIDENCE-INDEX.md) maps each frame to an md5 hash so a screen claim can be
checked rather than believed.

---

## 3. Five rules that decide whether a turn reaches this skill

These are not style advice. Each one was measured, and each one produces a wrong result if ignored.

1. **Open the skill first, or use `ask`.** From a closed session, a bare phrase belongs to the
   device, to Amazon, or to another skill: `pair my tv` reaches Amazon's Bluetooth pairing
   ("Sorry, I can't connect or control Bluetooth"), `play guess who` reaches a third-party trivia
   skill, and a bare nonsense phrase lands in Amazon shopping. The only reliable cold entries are
   `Alexa, open Globie Earth` and `Alexa, ask Globie Earth to …`.

2. **Once the session is open, drop the invocation for open questions.** Say
   `tell me about trees that fix paddy soil`, not `ask Globie Earth to tell me about …`. The
   invocation-prefixed `AMAZON.SearchQuery` form was measured falling to `AMAZON.FallbackIntent`
   on the same build that answered the bare form correctly minutes earlier.

3. **Never say `ask Globie Earth about …`.** A bare "about" lead-in scores below
   `AMAZON.FallbackIntent`; that sample was removed from the model on 2026-10-23. Use a carrier
   with a content word: `tell me about …`, `find …`, `show me …`, `how to …`.

4. **The pairing dialog owns the next turn.** While `PairTvIntent` is waiting for the six digits,
   `open quests` is consumed as the `code` slot. Say `stop`, then ask again.

5. **The advertised way out is `goodbye`.** `exit` and `quit` are consumed by Amazon before the
   model runs, so no spoken goodbye is produced. `goodbye`, `that's all`, `i'm done`, `stop` and
   `cancel` all close the session properly. The session stays open for everything else — a miss,
   a finished game or a finished TV move does **not** release the microphone.

---

## 4. How to read a turn in the console

The transcript bubble alone cannot tell you whose answer you are looking at — Amazon's own
answers look identical in style. Read the JSON panes instead:

- **Skill I/O → JSON Input** — `request.intent.name` is the intent that actually fired.
- **Skill I/O → JSON Output** — `shouldEndSession` and any `directives` (`AudioPlayer.Play`,
  `AudioPlayer.Stop`) are what the skill returned.

Two console quirks, both console-side and neither a product defect:

- The device template **`Hub Landscape Medium` renders as "not available or currently not
  supported"**. Pick `TV Landscape Extra Large` for a TV-shaped viewport; the choice is not
  persisted, so re-select it after every reload.
- The transcript survives a model rebuild; **reload the page** before a new test series so you
  start from a genuinely closed session.

Typing into the simulator: `click` the box → type → press **Enter**. Setting the field without
submitting leaves the previous utterance in place.

---

## 5. Test cards

Status legend: **verified** = observed in the recorded run on 2026-10-23; **declared** = specified
in the manifest or handler but not part of that recorded run; **known gap** = documented
limitation, do not score it as a pass.

### 5.1 Session

| Say | Intent that should fire | Expected | Status |
|---|---|---|---|
| `open globie earth` | `LaunchRequest` | Launch speech, `shouldEndSession: false` | verified |
| `help` | `AMAZON.HelpIntent` | "You can say things like, tell me about trees that fix paddy soil, what the site is like right now, search the TV for forest podcasts, or play a thirty minute guided meditation…" | verified |
| `flurbo zanzibar quux` (in-session) | `AMAZON.FallbackIntent` | "I did not catch a question in that. Try saying, tell me about trees that fix paddy soil…" | verified |
| `goodbye` | `AMAZON.StopIntent` / `ExitGlobieIntent` | "Goodbye from the Globie Earth forest." Session closes. | verified |

### 5.2 Forest and site

| Say | Intent | Expected | Status |
|---|---|---|---|
| `what is the site like right now` | `AskGlobieIntent` | Live conditions — temperature, humidity, European AQI, CO₂ — labelled as modelled Open-Meteo data, not a sensor reading | verified |
| `tell me about trees that fix paddy soil` | `AskGlobieIntent` | Eight passages from the forest catalogue, closest match named | verified |
| `tell me about the father tree` | `AskGlobieIntent` | The Father Tree passage | verified |
| `what species should I adopt next` | `AskGlobieIntent` | Recommendations matched to what this identity has already adopted; empty on a first run | declared |

### 5.3 Thai cookbook

| Say | Intent | Expected | Status |
|---|---|---|---|
| `how to make green curry` | `AskGlobieIntent` | Eight recipes, closest = Green Curry Paste | verified |
| `give me the recipe for green curry with chicken` | `AskGlobieIntent` | Full ingredients and numbered method, serves 2–3, ~35 min | verified |
| `how do I cook it` (as a follow-up) | `AskGlobieIntent` | "it" resolves to the previous dish; full method read back | verified |

### 5.4 Ledger — deeds and eco-tokens

| Say | Intent | Expected | Status |
|---|---|---|---|
| `what is my eco-token balance` | `AskGlobieIntent` | On a first run: "You have no eco-tokens on this device yet…". A zero balance is the correct answer, not a failure. | verified |
| `show me my living deeds` | `AskGlobieIntent` | Deeds newest first, with growth stage. Empty on a first run. | declared |
| `I want to adopt a Yang Na tree` | `AskGlobieIntent` → `adopt_species` | Confirmation first: "I can record an adoption of … and issue its Living Deed. That records the adoption in Globie Earth and does not take payment. Shall I go ahead?" Then `yes`. | declared |
| `yes` (after the prompt) | `AMAZON.YesIntent` | Deed issued, eco-tokens credited; re-asking the balance should now be non-zero | declared |

Adoption is gated behind a spoken `yes` on purpose: the skill takes no money, so the confirmation
is the only thing between a stray sentence and a new deed.

### 5.5 Audio

| Say | Intent | Expected | Status |
|---|---|---|---|
| `play a thirty minute guided meditation` | `PlayMeditationIntent` (`duration=30`) | `AudioPlayer.Play` — `thirty-focus.mp3` | verified |
| `play a podcast` | `PlayPodcastIntent` (no theme) | `AudioPlayer.Play` with a real episode | verified |
| `next episode` | `NextEpisodeIntent` | "Here is the next episode." + `AudioPlayer.Play` | verified |
| `play a mindfulness podcast` | `PlayPodcastIntent` (`theme=mindfulness`) | Sometimes answers "I could not find a playable mindfulness podcast just now." See §6.4. | intermittent |
| `stop` (audio playing) | `AMAZON.PauseIntent` | Playback stops; no speech required | verified |
| `resume` | `AMAZON.ResumeIntent` | Resumes the last stream | declared |

> Meditation must be invoked with `ask Globie Earth to …` or inside an open session. A cold bare
> `play a thirty minute guided meditation` is claimed by a third-party meditation skill.

### 5.6 Web-search preference

| Say | Intent | Expected | Status |
|---|---|---|---|
| `stop` (while audio plays) | `AMAZON.PauseIntent` | Stops playback — and **not** the preference change | verified |
| `turn off web search` (audio idle) | `DisableWebOfferIntent` | Confirms it will answer from the site's own records only | verified |
| `turn web search offers back on` | `EnableWebOfferIntent` | Flag cleared, confirmation spoken | verified |

> `stop offering web search` while audio is playing is swallowed as `AMAZON.PauseIntent` before
> the skill's NLU runs. Say `stop` first, then `turn off web search`.

### 5.7 Soundscape — generate, wait, play, publish

Renders are asynchronous. This is the only flow where "wait a moment" is literal.

| Say | Intent | Expected | Status |
|---|---|---|---|
| `make a soundscape for the Yang Na tree` | `AskGlobieIntent` → `generate_soundscape` | "I can make that soundscape for you. Shall I go ahead?" | declared |
| `yes` | `AMAZON.YesIntent` | Render is queued; the turn ends with a confirmation | declared |
| `play my soundscape` (immediately) | `PlaySoundscapeIntent` | "Your soundscape is still being rendered. Give it a moment, then ask me to play it again." | declared |
| `play my soundscape` (after it finishes) | `PlaySoundscapeIntent` | `AudioPlayer.Play` of the newest finished track | declared |
| `pause` / `resume` / `stop` | built-ins | Transport control over that stream | declared |
| `publish my soundscape` | `PublishSoundscapeIntent` | Confirmation, then published to the public library | declared |

Use `make …` rather than `generate …`: `make {query}` is a registered carrier, `generate` is not.

### 5.8 TV pairing

Precondition: the Globie Earth TV app is running and showing a six-digit code.

| Say | Intent | Expected | Status |
|---|---|---|---|
| `ask Globie Earth to pair my tv` | `PairTvIntent`, `Dialog.ElicitSlot` | "What are the six digits shown on the TV? Say them one at a time." | verified |
| `one two three four five six` | slot `code = 123456` | Invalid code → "That code is not valid. Check the six digits on the TV, then say them again." A valid live code → "Paired. You can now say: go home, or play guess who." | verified |
| `open quests` while the dialog is open | — | Consumed by the dialog. Say `stop`, then retry. | verified behaviour |

### 5.9 TV navigation

Precondition: paired. Each row changes a screen; the recorded frame hash is the proof, because
`/health.tvCommands` counters are advisory and cannot show a screen change.

| Say | Queued command | Expected screen | Status |
|---|---|---|---|
| `open quests` | `openScreen: quests` | QUESTS — "Pick a mission. Every answer grows the field guide." | verified |
| `open globie learn` | `openScreen: learn` | LEARN — "16,383 RESULTS", species grid | verified |
| `open daily focus` | `openScreen: focus` | FOCUS MODE — 4-7-8-4 breathing | verified |
| `go back` | `back` | One screen back | verified |
| `go to the welcome screen` | `home` | Welcome / boot frame | verified |
| `search the TV for forest podcasts` | `search` | `RESULTS FOR "FOREST PODCASTS"`, five shows | verified |
| `open the forest for the future podcast on the TV` | `openFeed` | PLAYER — "Forest For The Future", 0:00 / 51:41 | verified |
| `pause the TV` | `player.pause` | Command delivered. On the virtual device the frame does not change because nothing is audible. | verified (delivery) |
| `resume the TV` | `player.resume` | "NO SOUND ON THIS TV" overlay on the virtual device — which proves the resume reached the player | verified (delivery) |
| `open settings` / `open wardrobe` | — | **Known gap:** absorbed by `OpenLearnIntent`, opens LEARN | known gap |
| `open the forest hour podcast on the TV` | — | **Known gap:** advertised by the intent's own recovery prompt, but no such feed exists. Use `forest for the future`. | known gap |

Every TV turn keeps the session open, so the next bare sentence (`go home`, `play guess who`,
`open quests`) still reaches this skill without repeating the invocation.

### 5.10 Guess Who

Precondition: a Guess Who deck is open on the TV. Voice can open the game, answer, score and quit,
but **cannot** open the deck tile itself — the relay's command set has no raw key or focus event,
so the deck is started by touch or by the remote.

| Say | Intent | Expected | Status |
|---|---|---|---|
| `play guess who` (in-session) | `StartGameIntent` | "Opening Guess Who on the TV…" | verified |
| `start the game` | `StartGameIntent` | Question 1 of 5 read aloud, `shouldEndSession: false` | verified |
| `one` / `two` / `three` | `AnswerIntent` (`choice`) | Verdict spoken, TV advances to the next round | verified |
| `next question` | `NextQuestionIntent` | Question skipped, TV advances | verified |
| `what's the score` | `ScoreIntent` | Spoken score, which must match the score drawn on the TV | verified |
| `quit the game` | `QuitGameIntent` | "Ending the game." TV returns to QUESTS; the session stays open | verified |

The scored run on `globie-mcp:20261023-1611` finished **5 / 5, +40 Eco Tokens**, with the spoken
option labels matching the drawn labels on every round. A single earlier probe answered `two` and
read a score of 0; that is also exactly what a wrong answer produces, and it is not evidence of a
scoring defect.

---

## 6. Known limitations — read before judging

Each item is real, reproduced, and stated with the workaround.

1. **The skill is in Development, not in the Skills Store.** Voice testing needs the owning
   developer account. Everything else in this sheet works from outside (§2.2).
2. **The session lock is the feature and the trap.** Cold phrases go to Amazon or another skill.
   Open the skill first, or say `ask Globie Earth to …`.
3. **`exit` and `quit` are swallowed by the platform** even when followed by the skill name: the
   skill records a `SessionEndedRequest` with no intent and no spoken goodbye. Use `goodbye`.
4. **`play a mindfulness podcast` is intermittent.** The theme is valid, so this is a relevance
   miss in the podcast index, not a routing miss. The deterministic audio test is `play a podcast`.
5. **`open settings` and `open wardrobe` never reach those screens.** The utterance is absorbed by
   `OpenLearnIntent`. This is a documented reach gap in the command set, not a crash.
6. **`OpenPlayerIntent` advertises a show that does not exist** ("forest hour"). Use
   `forest for the future`.
7. **The TV must be re-paired after every deploy.** `vega run-app` drops the pairing. If every TV
   command answers "pair my TV", re-pair before suspecting the relay.
8. **The virtual device has no audio sink.** `pause` appears to do nothing and `resume` raises the
   "NO SOUND ON THIS TV" overlay. Both commands were delivered; audibility belongs to a real TV
   with a paired Echo.
9. **Amazon Nova and Bedrock embeddings return 502 on this account** (model access not granted).
   The serving router is `deepseek-flash`; embeddings run locally with `multilingual-e5-small`.
   `/health` says so rather than hiding it.
10. **`/oauth/authorize` and `/oauth/token` return 503.** OAuth 2.1 is implemented and dormant
    with no client configured. Treat it as a capability, not a live endpoint.
11. **The console's `Hub Landscape Medium` device template does not render.** Console-side only;
    choose `TV Landscape Extra Large`, and re-select it after each reload.

---

## 7. What a pass looks like

Minimum ten-minute pass, in this order:

- [ ] `/health` returns `ok: true` and names Polly, the local embedder, `deepseek-flash`, and
      this skill id.
- [ ] An unsigned `POST /alexa` returns 401 with the verification message.
- [ ] `open globie earth` speaks the launch text and keeps the session open.
- [ ] `tell me about trees that fix paddy soil` answers with real catalogue passages.
- [ ] `what is the site like right now` answers with live conditions and labels them modelled.
- [ ] `how to make green curry` returns recipes; the follow-up `how do I cook it` resolves.
- [ ] `play a thirty minute guided meditation` produces `AudioPlayer.Play`.
- [ ] `help`, then a nonsense query, then `goodbye` — help and fallback speak the site's own
      examples, and goodbye closes the session.
- [ ] If a TV is available: pair it, then `open quests`, `open globie learn`,
      `search the TV for forest podcasts`, `go back`, `go to the welcome screen`.
- [ ] If a Guess Who deck is open: `start the game` → answer three rounds → `what's the score`
      → `quit the game`, with spoken and drawn scores agreeing.

Every non-voice step above was re-run on 2026-10-23 before this file was written.

---

## 8. If something fails

| Symptom | Most likely cause | Do this |
|---|---|---|
| "Hmm, I don't know that." / an Amazon-style answer | The session was cold, so Amazon answered, not the skill | Reload, `open globie earth`, ask again in-session |
| "Sorry, I can't connect or control Bluetooth" | Cold `pair my tv` claimed by Amazon's Bluetooth domain | `ask Globie Earth to pair my tv` |
| A third-party trivia skill answers | Cold `play guess who` | Open the skill first, then `play guess who` |
| "I did not catch a question in that." for a valid phrase | Utterance used an unregistered carrier (`about …`, `generate …`) | Re-say with `tell me about …`, `make …`, `find …` |
| `open quests` after a pair attempt does nothing | Pairing dialog owns the turn | `stop`, then `open quests` |
| TV commands all answer "pair my TV" | Pairing dropped by a deploy | Re-pair from the code on screen |
| No speech at all, JSON panes blank | Console/simulator glitch, not the skill | Reload the Test page; if it persists, check `/health` |
| Slow first answer | The router is reaching a model, then the site's data services | Allow a few seconds; subsequent turns are faster |

---

## 9. Where the evidence lives

| What | Where |
|---|---|
| Skill definition | [`skill-package/`](skill-package/) — `skill.json`, `interactionModel.json` |
| Handler | [`src/alexa.ts`](src/alexa.ts) |
| TV app | [iromath/globie-vega](https://github.com/iromath/globie-vega) |
| Per-turn screenshots, frame hashes, `/health` snapshot | Attached to the Devpost submission as evidence, not committed here: `p4-*` non-TV smoke set, `p5-*` voice→TV navigation, `p6-*` and `vt-*` Guess Who |

`/health.tvCommands` reports `{codes, pairings, queued, waiting, handoffs}`. `queued` never
decrements and `waiting` only counts live long-polls, so **no navigation claim in this sheet rests
on those counters** — each one is a screenshot hash diff against a resting frame.
