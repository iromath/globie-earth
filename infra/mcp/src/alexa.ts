// The Alexa Skill front door: an ASK webhook beside /mcp.
//
// Why this exists next to an Alexa+ add-on rather than instead of one. The
// add-on hands our tools to Alexa+'s own planner and needs no interaction model
// at all; a Skill is the older product, where the developer declares the intents
// and Alexa only ever sends back a matched intent. The two are different
// submission pipelines (Skill certification vs the Alexa+ add-on review), and
// this file is the bridge that lets the same 54 tools answer on either one.
//
// The bridge is deliberately thin. Everything the add-on path already does -
// which tools exist, which model routes an utterance, what a tool returns - is
// reused verbatim:
//
//   buildServer(caller)  the same MCP surface, in-process, no HTTP hop
//   routeToTool(...)     the same router that /route uses, same allowlist,
//                        same billing, same refusals
//
// So a Skill utterance is routed by exactly the code that routes a browser
// utterance, and the two cannot disagree about what the server can do.
//
// Identity. An ASK request carries no X-Device-Id, so the caller is resolved in
// two steps: an account-linking access token when the listener has linked one
// (the OAuth 2.1 token oauth.ts issues, accepted by resolveCaller unchanged),
// and otherwise a device id derived deterministically from Amazon's userId.
// Deriving one matters: the RPCs are device-scoped, so without a stable id a
// listener could not hear their own deeds read back, and adoptions would have
// nowhere to land. It is derived, never random, so the same listener keeps the
// same site across sessions.
//
// One honest limitation, stated here because it shapes the interaction model
// beside this file: AMAZON.FallbackIntent is delivered with no utterance at
// all. When the interaction model fails to match, there is no text to route, so
// the Skill asks the listener to rephrase instead of guessing. That is why the
// model carries explicit carrier phrases rather than relying on a bare catch-all.
//
// The same gap had a second edge. A tool that spends the shared render quota
// tells the router to ask before calling it (tools/studio.ts), so the reply to
// "generate a dawn chorus" is a question - and a bare "yes" is another utterance
// with no words to route. The model therefore carries AMAZON.YesIntent and
// AMAZON.NoIntent, and the sentence being confirmed is handed to the next turn
// in Alexa's own session attributes (PENDING_ATTRIBUTE), because this webhook
// holds no session of its own to keep it in. The yes is answered by routing that
// sentence a second time with `confirmed` set (router.ts), which is what the
// router needs to stop asking; nothing about the tool call itself is bypassed.
// That instruction lives in a prompt, though, and the model does not always keep
// to it, so the ask is also enforced in code here (CONFIRMATION_REQUIRED): an
// unconfirmed call to a spend-gated tool is answered with the question whatever
// the model decided.
//
// The same attributes carry a second kind of pending question. After one of the
// site's own searches (SITE_SEARCH_TOOLS) the reply offers to look on the open
// web as well, because the site's records are only what the site holds - and a
// "yes" must not route the sentence a second time, because that would only pick
// the tool that just answered. So the offer keeps its words under its own key
// (PENDING_WEB_ATTRIBUTE) and the yes-path calls search_web with them directly,
// skipping the router. A listener who would rather not be asked says so once
// (DisableWebOfferIntent) and the offer is dropped for the rest of the session,
// which is the only memory this webhook has (WEB_OFFER_ATTRIBUTE).
//
// Nothing here is reachable without a verified Amazon signature: see
// alexa-verify.ts for what is checked and why.

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { alexaCertExpiryGraceDays, alexaSkillId, alexaVerificationEnabled, verifyAlexaRequest } from './alexa-verify.js';
import type { Caller } from './identity.js';
import { resolveCaller } from './identity.js';
import { buildServer } from './mcp-server.js';
import { absoluteUrl, callProxy } from './proxy.js';
import { routeToTool } from './router.js';

/**
 * Alexa speaks plain text up to 8000 characters and abandons a response after
 * about four minutes; a spoken answer stays far shorter than either.
 *
 * The figure is set by the cookbook: "how do I cook it" is answered by the
 * steps themselves, and the book's longest dish (Hat-Yai Fried Chicken, seven
 * steps) runs to roughly 1,700 characters with its per-step times. Clipping at
 * the old 700 left a listener partway through step three of seven, which read
 * as a dropped connection rather than an answer. Everything else this adapter
 * speaks is a sentence or two, so the higher ceiling costs nothing elsewhere.
 */
const SPEECH_LIMIT = 1800;

/**
 * How long the tools may take before this adapter has to answer regardless.
 *
 * Alexa abandons a request after roughly eight seconds, and it does so whether
 * or not the webhook is still working - which is why a slow tool surfaces as
 * "The requested skill did not provide a valid response" rather than as a
 * timeout, while the server still logs a 200 seconds later. The router's own
 * model call takes a few of those seconds, so the tools get the rest.
 *
 * search_forest_knowledge's optional rerank is a ~20 s remote call that can
 * never fit, and it fell back to the cosine order every time anyway; given this
 * ceiling it is skipped outright (rerank.ts) and the search answers from the
 * local-embed path in about a second. Left unset in the browser host, which has
 * no such deadline and still reranks.
 */
const TOOL_LATENCY_BUDGET_MS = 3000;

const LAUNCH_SPEECH =
  'Globie Earth is a regenerative agroforestry site in Isan, Thailand. Ask me about its trees ' +
  'and animals, what the site is like right now, the cookbook, or planning a trip. ' +
  'You can also ask me to generate sound, calming forest music that helps you relax, or ' +
  'that guides meditation, mindfulness, or a podcast. What would you like to know?';

const HELP_SPEECH =
  'You can say things like, ask Globie Earth about trees that fix paddy soil, ask ' +
  'Globie Earth what the site is like, or ask Globie Earth to find tours in ' +
  'Bangkok. What would you like to know?';

const FALLBACK_SPEECH =
  'I did not catch a question in that. Try saying, ask Globie Earth about trees that ' +
  'fix paddy soil, or, ask Globie Earth what the site is like.';

const GOODBYE_SPEECH = 'Goodbye from the Globie Earth forest.';

const REPROMPT_SPEECH = 'What else would you like to know?';

const NO_MATCH_SPEECH =
  'I could not find a tool for that. Try asking about the forest’s species, the ' +
  'site’s conditions, the cookbook, or travel planning.';

/**
 * One filled slot, as the interaction model's entity resolution left it.
 *
 * `value` is what the caller *said*; the value the slot type actually matched
 * is only inside `resolutions` - spoken "wellness" arrives as
 * `value: "wellness"` with `name: "wellbeing"` in the resolution - so both are
 * carried and the resolved one is what a lookup should use.
 */
interface AlexaSlot {
  value?: string;
  resolutions?: {
    resolutionsPerAuthority?: Array<{
      status?: { code?: string };
      values?: Array<{ value?: { name?: string } }>;
    }>;
  };
}

/** The slice of the ASK envelope this adapter reads. */
interface AlexaEnvelope {
  version?: string;
  session?: {
    application?: { applicationId?: string };
    user?: { userId?: string; accessToken?: string };
    /**
     * Whatever the previous reply put in its own `sessionAttributes`, echoed
     * back while the session stays open (`shouldEndSession: false`). This is the
     * only state that survives between two utterances - see PENDING_ATTRIBUTE.
     */
    attributes?: Record<string, unknown>;
  };
  context?: {
    System?: { user?: { userId?: string; accessToken?: string } };
    /**
     * What the device's player is doing, present while a stream is under way.
     *
     * `token` is the one this skill put in the Play directive, so it is how an
     * incoming intent names the stream it is about - there is no session to ask
     * (see playNextEpisode). The Alexa+ host sends it with every request that
     * arrives while audio is playing.
     */
    AudioPlayer?: { token?: string; offsetInMilliseconds?: number; playerActivity?: string };
  };
  request?: {
    type?: string;
    requestId?: string;
    timestamp?: string;
    intent?: { name?: string; slots?: Record<string, AlexaSlot | undefined> };
    /**
     * Present on the AudioPlayer events, and the only thing that names which
     * stream the event is about: the token we put in the Play directive comes
     * back here untouched. See nextMeditationStep.
     */
    token?: string;
  };
}

interface AlexaPerson {
  userId?: string;
  accessToken?: string;
}

interface AlexaSpeech {
  version: '1.0';
  /**
   * State handed to the next turn of the same session.
   *
   * Alexa echoes this back as `session.attributes` for as long as the session
   * stays open, which is the only memory this webhook has: it is rebuilt from
   * nothing on every utterance. What the service does with a reply that omits
   * this key is the trap - it keeps the previous set rather than clearing it
   * (observed against the simulator), so a turn that sets nothing has to send
   * an empty object to abandon what the last one was waiting for. spoken()
   * therefore always sends the key.
   */
  sessionAttributes?: Record<string, unknown>;
  response: {
    outputSpeech: { type: 'PlainText'; text: string };
    reprompt?: { outputSpeech: { type: 'PlainText'; text: string } };
    shouldEndSession: boolean;
  };
}

/**
 * Where a reply that asks for a go-ahead leaves the sentence it is asking about.
 *
 * The listener answers that question with a bare "yes", which carries no words
 * of its own - so the only way to act on it is to have kept the original
 * sentence somewhere. Alexa's own session attributes are that somewhere; there
 * is no server-side session to put it in (see answer()).
 */
const PENDING_ATTRIBUTE = 'globiePending';

/**
 * Where a web-search offer leaves the words to search for.
 *
 * A go-ahead question normally re-routes the original sentence
 * (PENDING_ATTRIBUTE), but the offer made after an empty site search is
 * different: the tool that came back empty must not be picked again. The query
 * is kept here instead, and the yes-path calls search_web with it directly
 * (confirmReply) - so the two pending states are kept apart on purpose.
 */
const PENDING_WEB_ATTRIBUTE = 'globiePendingWeb';

/**
 * Where a listener's "do not offer me the open web" answer is kept.
 *
 * Scoped to the session on purpose. This webhook is rebuilt from nothing on
 * every utterance, so the attribute is the only place a preference can live
 * without a database round trip; the offer is a convenience, and one that comes
 * back at the start of the next conversation is a fair trade for not writing a
 * per-listener row on the strength of one annoyed sentence. Set by
 * DisableWebOfferIntent, dropped by EnableWebOfferIntent, and read before the
 * offer is appended to a site search's answer.
 */
const WEB_OFFER_ATTRIBUTE = 'globieWebOfferOff';

/**
 * What the last turn that ran a tool was about, so a follow-up can lean on it.
 *
 * "How do I cook it" names no dish: the word "it" points back at whatever the
 * previous turn answered, and nothing else in this webhook can see that far
 * back - as with the pending sentence, the session attributes are the only
 * memory this channel has. The subject kept here (a dish, a species, a place)
 * is handed to the router on the next turn so it can read the pronoun back to
 * its subject instead of answering that the sentence names nothing.
 */
const LAST_SUBJECT_ATTRIBUTE = 'globieLastSubject';

/** A spoken answer, and keeps the session open for a follow-up. */
function spoken(text: string, sessionAttributes: Record<string, unknown> = {}): AlexaSpeech {
  return {
    version: '1.0',
    // Always sent, even when empty: a reply that omits the key leaves the
    // previous turn's attributes in place, so setting nothing has to say so
    // explicitly to drop a sentence that is no longer waiting on an answer.
    sessionAttributes,
    response: {
      outputSpeech: { type: 'PlainText', text },
      reprompt: { outputSpeech: { type: 'PlainText', text: REPROMPT_SPEECH } },
      shouldEndSession: false,
    },
  };
}

/** The end of the conversation. */
function ending(text: string): AlexaSpeech {
  return { version: '1.0', response: { outputSpeech: { type: 'PlainText', text }, shouldEndSession: true } };
}

/**
 * A response that drives the device's own player rather than the skill's voice.
 *
 * Kept apart from AlexaSpeech because the two are assembled differently, but
 * they are not exclusive: the interface reference says a reply to a
 * LaunchRequest or IntentRequest "can include both AudioPlayer directives and
 * standard response properties, such as outputSpeech, card, and reprompt" -
 * Alexa speaks the line and then starts the stream. The narrow rule is only
 * that a reply to an AudioPlayer *event* (PlaybackStarted and friends) may
 * carry a directive and no standard properties, which is why those events are
 * answered with an empty response below. So announcing() may speak and play at
 * once; playing() speaks nothing because it has nothing to add.
 */
interface AlexaDirective {
  version: '1.0';
  response: {
    outputSpeech?: { type: 'PlainText'; text: string };
    directives?: Array<Record<string, unknown>>;
    shouldEndSession?: boolean;
  };
}

/**
 * Starts a stream from the beginning, replacing whatever is already playing.
 *
 * `token` is opaque to Alexa and echoed back on every playback event, so the
 * track id is what lets a later event name this exact stream.
 */
function playing(url: string, token: string): AlexaDirective {
  return {
    version: '1.0',
    response: {
      directives: [
        {
          type: 'AudioPlayer.Play',
          playBehavior: 'REPLACE_ALL',
          audioItem: { stream: { token, url, offsetInMilliseconds: 0 } },
        },
      ],
      // Required for audio: leaving this false would send the stream to the
      // device only to pause it immediately and listen (the audio-player guide).
      shouldEndSession: true,
    },
  };
}

/**
 * Says one line, then plays - for the times the listener should hear what is
 * about to start ("here is a grounding meditation").
 *
 * The streaming device cannot be asked anything once the stream owns the
 * session, so the sentence has to ride along with the Play directive; that
 * combination is explicitly allowed in a reply to an IntentRequest.
 */
function announcing(text: string, url: string, token: string): AlexaDirective {
  return {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      directives: [
        {
          type: 'AudioPlayer.Play',
          playBehavior: 'REPLACE_ALL',
          audioItem: { stream: { token, url, offsetInMilliseconds: 0 } },
        },
      ],
      shouldEndSession: true,
    },
  };
}

/**
 * Queues one more track behind the one now playing.
 *
 * This is the only way a skill may append to a playlist: the interface
 * reference requires ENQUEUE to name the stream it is following, and forbids
 * expectedPreviousToken on REPLACE_ALL. Sent in reply to PlaybackNearlyFinished
 * (see nextMeditationStep), it is what lets a multi-line session run past the
 * first file without a session to keep state in.
 */
function playingNext(url: string, token: string, previousToken: string): AlexaDirective {
  return {
    version: '1.0',
    response: {
      directives: [
        {
          type: 'AudioPlayer.Play',
          playBehavior: 'ENQUEUE',
          audioItem: {
            stream: { token, url, expectedPreviousToken: previousToken, offsetInMilliseconds: 0 },
          },
        },
      ],
    },
  };
}

/**
 * Silences the player.
 *
 * There is no Pause directive. "Alexa, pause" - and "Alexa, stop" while audio is
 * playing, which Alexa delivers as a PauseIntent rather than a StopIntent - is
 * answered with Stop and a closed session; "resume" then restarts the stream.
 */
function stopping(): AlexaDirective {
  return {
    version: '1.0',
    response: { directives: [{ type: 'AudioPlayer.Stop' }], shouldEndSession: true },
  };
}

/** What GET /v1/studio/library answers with (infra/studio/src/server.ts). */
interface StudioLibrary {
  tracks?: Array<{
    id: string;
    status: 'queued' | 'generating' | 'ready' | 'failed';
    title: string;
    /** Relative to the studio origin, and only set once the render is ready. */
    audioUrl: string | null;
  }>;
}

/** The slice of GET /v1/studio/public this adapter plays from. */
interface StudioPublic {
  tracks?: Array<{
    id: string;
    title: string;
    /** Relative to the studio origin. */
    audioUrl: string | null;
  }>;
}

/** The slice of GET /v1/podcast/search this adapter plays from. */
interface PodcastFeeds {
  feeds?: Array<{
    id: number;
    title: string;
    /** The publisher's own audio file - what a podcast app streams. */
    newestEnclosureUrl: string | null;
  }>;
}

/** The slice of GET /v1/podcast/feeds/:id/episodes this adapter plays from. */
interface PodcastEpisodes {
  episodes?: Array<{
    id: number;
    title: string;
    /** The publisher's direct audio file - what a podcast app streams. */
    enclosureUrl: string;
    durationSec: number | null;
  }>;
}

/**
 * Where the guided-meditation voice lines are served from.
 *
 * They are static files on Globie Earth's own origin (`globie.earth/voice/…`),
 * not behind either proxy, so neither absoluteUrl nor publicUrl - both keyed by
 * a ProxyService - can build their URLs. The site origin is the only thing
 * needed, and it defaults to the apex the app itself is served from, so an
 * override is only for a stack that hosts them elsewhere.
 */
const VOICE_BASE_URL =
  process.env.VOICE_BASE_URL?.trim().replace(/\/+$/, '') || 'https://globie.earth';

/**
 * One guided meditation, in playing order.
 *
 * Each voice line is a few seconds long, so a session is the whole list played
 * back to back rather than any one file (the files themselves carry a step
 * number in their name). Only lines verified to answer `audio/mpeg` belong
 * here: the site serves its single-page app for any path it does not have, so a
 * missing line answers 200 with an HTML body and would stall the player silently.
 */
const MEDITATION_TRACKS = [
  'mother--meditation_ground_1',
  'mother--meditation_ground_2',
  'mother--meditation_ground_3',
  'mother--meditation_ground_4',
];

/**
 * The long-form guided meditations, keyed by the minutes a listener asks for.
 *
 * The shipped short lessons (MEDITATION_TRACKS) are four lines played back to
 * back; a 10, 15 or 30 minute session is instead one media file. That is not
 * an optimisation but the only honest way to hold the pacing: a long session is
 * a chain of twenty-odd voice lines separated by tens of seconds of held
 * silence, and Alexa's player has no gap control and may drop a long ENQUEUE
 * chain mid-session. Baking the voice and the silences into a single file -
 * rendered from the same MEDITATION_* script the app plays - makes the session
 * arrive as one stream. `name` is the file the Globie Earth site serves at
 * /voice/guides/<name>.mp3; the token keeps the session's identity for a
 * PlaybackStarted/Finished event.
 */
const GUIDES: Record<number, { name: string; minutes: number }> = {
  10: { name: 'ten', minutes: 10 },
  15: { name: 'fifteen', minutes: 15 },
  30: { name: 'thirty', minutes: 30 },
};

/**
 * The music beds a guided meditation can be mixed with, drawn at random.
 *
 * The device plays one stream at a time, so a bed cannot be layered under the
 * voice at playback time - it is mixed into the guide file offline and arrives
 * as part of the same stream. Each bed therefore has its own render of every
 * guide (served at /voice/guides/<guide>-<id>.mp3); `id` is the file suffix and
 * `label` is the title the listener is told, so the session's music is named
 * rather than anonymous. The five are the site's own published catalogue.
 */
const MEDITATION_BEDS = [
  { id: 'awakening', label: 'Awakening Keep Calm' },
  { id: 'deep-focus', label: 'Deep focus' },
  { id: 'jazz', label: 'Jazz Piano Meditation Focus' },
  { id: 'birds', label: 'Birds and nature sound non-stop' },
  { id: 'focus', label: 'focus' },
];

/** The short grounding lesson as a single mixed file, named like the guides. */
const SHORT_GUIDE = 'short';

/**
 * One bed for this session.
 *
 * Drawn per request rather than fixed per guide, so asking for the same ten
 * minutes twice does not play the same music twice.
 */
function randomBed(): (typeof MEDITATION_BEDS)[number] {
  return MEDITATION_BEDS[Math.floor(Math.random() * MEDITATION_BEDS.length)] ?? MEDITATION_BEDS[0];
}

/**
 * The duration a PlayMeditationIntent asked for, or null for the default lesson.
 *
 * The slot is AMAZON.NUMBER, which resolves a spoken number ("ten") to its
 * digits, so anything but 10, 15 or 30 - including the many utterances that
 * carry no number at all - falls through to the short grounding lesson rather
 * than guessing at a session length.
 */
function guideMinutesFrom(request: AlexaEnvelope['request']): number | null {
  const value = request?.intent?.slots?.duration?.value?.trim();
  if (!value) return null;
  const minutes = Number(value);
  return GUIDES[minutes] ? minutes : null;
}

/**
 * The line after the one that just finished, or null when the session is over.
 *
 * A token of `meditation:<n>` says the n-th line is playing (1-based), so the
 * position lives in the token itself - the token is echoed back on every
 * playback event, which saves keeping a queue anywhere. This answers
 * PlaybackNearlyFinished only; any other progression event gets an empty reply.
 * A `guide:<name>` token is a whole session in one file, so it has no next
 * line and this returns null by the same path as the last lesson line.
 */
function nextMeditationStep(token: string | undefined): AlexaDirective | null {
  const played = /^meditation:(\d+)$/.exec(token ?? '');
  if (!played) return null;
  const index = Number(played[1]);
  const next = MEDITATION_TRACKS[index];
  if (!next) return null;
  return playingNext(
    `${VOICE_BASE_URL}/voice/${next}.mp3`,
    `meditation:${index + 1}`,
    token as string,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The envelope, or null when the body is not one. */
function parseEnvelope(body: unknown): AlexaEnvelope | null {
  if (!isRecord(body) || !isRecord(body.request)) return null;
  return body as AlexaEnvelope;
}

/**
 * A stable device id for one Amazon user.
 *
 * Shaped like the v5 UUID the schema expects, but built from a SHA-256 of the
 * Amazon userId rather than a namespace - this is a local identifier, not an
 * interoperable one, and all that matters is that it is the same every time for
 * the same listener and different for everyone else.
 */
function deviceIdFor(userId: string): string {
  const bytes = createHash('sha256').update(`globie-alexa:${userId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Who this utterance acts as, or null when the envelope names nobody. */
function callerFor(envelope: AlexaEnvelope): Caller | null {
  const person: AlexaPerson = envelope.context?.System?.user ?? envelope.session?.user ?? {};
  const accessToken = person.accessToken?.trim();
  if (accessToken) {
    const linked = resolveCaller({ authorization: `Bearer ${accessToken}` });
    if (linked) return { ...linked, latencyBudgetMs: TOOL_LATENCY_BUDGET_MS };
  }
  const userId = person.userId?.trim();
  return userId
    ? { deviceId: deviceIdFor(userId), latencyBudgetMs: TOOL_LATENCY_BUDGET_MS }
    : null;
}

/**
 * Turns a tool result into something worth hearing.
 *
 * Tool payloads are written for a screen: markdown, cover-art and audio URLs,
 * base64 data URLs. None of that should be read aloud, so links and data URLs
 * are dropped, emphasis characters become spaces, and the result is cut at a
 * sentence boundary rather than mid-word.
 */
function toSpeech(text: string): string {
  const cleaned = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/data:[^\s"')]+/gi, ' ')
    .replace(/https?:\/\/[^\s"')]+/gi, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= SPEECH_LIMIT) return cleaned;

  const clipped = cleaned.slice(0, SPEECH_LIMIT);
  const stop = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('? '),
    clipped.lastIndexOf('! '),
  );
  if (stop > 200) return clipped.slice(0, stop + 1);
  const lastSpace = clipped.lastIndexOf(' ');
  return lastSpace > 0 ? `${clipped.slice(0, lastSpace)}...` : clipped;
}

/** The text a block carries, or null when it is not a text block. */
function blockText(block: unknown): string | null {
  if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return null;
  return block.text;
}

/** Whether a block is tagged as written for the listener rather than the model. */
function forTheEar(block: unknown): boolean {
  if (!isRecord(block) || !isRecord(block.annotations)) return false;
  const audience = block.annotations.audience;
  return Array.isArray(audience) && audience.includes('user');
}

/**
 * The readable part of a tool result - text blocks only; images and UI cards
 * are not spoken.
 *
 * A tool answers with the JSON its screen renders *and*, where its author wrote
 * one, a plain-language line tagged `audience: ["user"]` (tools/result.ts).
 * That tag is the tool pointing at the block meant for an ear, so it wins; the
 * JSON stands only for the tools that carry no such line. Joining every block
 * instead read the serialised payload out loud - braces, quotes and all - and
 * `toSpeech` then clipped it before the sentence written for the mouth could
 * arrive.
 */
function speakableResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const blocks = Array.isArray(record.content) ? record.content : [];
  const texts = blocks.filter((block) => blockText(block) !== null);
  const chosen = texts.filter(forTheEar);
  const spoken = chosen.length > 0 ? chosen : texts;
  const speech = toSpeech(spoken.map((block) => blockText(block) ?? '').join(' '));
  if (record.isError === true) {
    return speech ? `That did not work. ${speech}` : 'That did not work.';
  }
  return speech;
}

/** What to say when the router itself refused, rather than a tool failing. */
function refusalSpeech(status: number, error: string): string {
  if (status === 503) return 'The site’s question router is not configured right now, so I cannot answer that.';
  if (status === 502) return 'The site’s question router could not be reached just now. Please try again.';
  return `I could not answer that. ${error}`;
}

/** What one routed utterance produced, and whether it left a question open. */
interface AnswerOutcome {
  speech: string;
  /**
   * True when this turn left a question the listener is meant to answer.
   *
   * On this channel that is a go-ahead question rather than a miss. It is set
   * both when the router itself answered without a tool call (the state-changing
   * tools tell it to ask first, tools/studio.ts) and when it did pick one but the
   * choice was held back for consent (CONFIRMATION_REQUIRED). Either way the
   * caller keeps the utterance so a following "yes" can route it again with
   * `confirmed`, which is what turns the question into the call.
   */
  awaitingGoAhead: boolean;
  /**
   * The words a "yes" should search the open web for.
   *
   * Set only when the question this turn asked was the offer made after a site
   * search (SITE_SEARCH_TOOLS). When it is set the yes-path calls search_web
   * with these words directly (confirmReply) rather than routing the sentence
   * again, which would only re-pick the tool that just answered.
   */
  webQuery?: string;
  /**
   * What this turn was about, for the next follow-up to lean on.
   *
   * Set from the tool that actually ran - the dish or species that answered,
   * named cleanly rather than as the question that reached it - and kept in the
   * session attributes (LAST_SUBJECT_ATTRIBUTE). Absent on a turn that ran
   * nothing, which leaves whatever the previous turn left in place.
   */
  subject?: string;
}

/**
 * Tools the listener has to agree to before they run.
 *
 * generate_soundscape's own description already tells the router to ask first,
 * because it spends the shared daily render quota - but a prompt is a request,
 * not a guarantee: on the Development simulator the very same sentence has gone
 * straight to the tool without a question, queueing a render nobody consented
 * to. So the ask is enforced here, where a prompt cannot talk it out of it. An
 * unconfirmed call to one of these is turned back into a question, which leaves
 * the sentence in the session attributes (PENDING_ATTRIBUTE); the only way the
 * tool then runs is the second pass over that sentence with `confirmed` set
 * (confirmReply) - nothing about the call itself is skipped.
 */
const CONFIRMATION_REQUIRED = new Set<string>(['generate_soundscape']);

/** The question an unconfirmed spend-gated call is turned back into. */
function goAheadQuestion(toolArguments: Record<string, unknown>): string {
  const title = typeof toolArguments.title === 'string' ? toolArguments.title.trim() : '';
  return title
    ? `I can make "${title}" for you. Shall I go ahead?`
    : 'I can make that soundscape for you. Shall I go ahead?';
}

/**
 * The site's own searches that the open-web offer follows.
 *
 * Both answer from Globie's catalogue - the forest knowledge and the cookbook -
 * and what they hold is the site, not the world. The offer is made after either
 * of them every time, not only on a miss: the semantic search answers with its
 * closest passages whatever was asked, because a small embedding model's cosine
 * floor is high (tools/catalog.ts), so a genuinely empty `hits` list is
 * effectively never produced and an offer waiting on one would never be heard.
 * Whether the site really covers the question is the listener's call, so the
 * question is theirs to answer, and the open web is where they go next.
 * describe_species is left out because it already reads Wikipedia, and
 * get_recipe because it reads a dish the cookbook holds rather than a question
 * (its miss arrives as an error, not as something to search around).
 */
const SITE_SEARCH_TOOLS = new Set<string>(['search_forest_knowledge', 'search_local_culture']);

/**
 * What a site search is followed by.
 *
 * Appended to the tool's own answer - the sentence it already wrote for the ear -
 * so the listener hears the site's answer and then the one way past it. Search
 * results are already the tool's own words, so a bare "shall I search the web"
 * would not say what for; the offer names the question instead.
 */
const WEB_OFFER_SUFFIX = ' Would you like me to search the open web for that too?';

/** What the listener hears after turning the open-web offer off. */
const WEB_OFFER_OFF_SPEECH =
  'Understood. I will answer from the site’s own records and leave the open web out of it. ' +
  'Just ask me to turn web search offers back on if you change your mind. ' +
  'What would you like to know?';

/** And after turning it back on. */
const WEB_OFFER_ON_SPEECH =
  'Happy to. After a site search I will ask whether you want me to look on the open web as ' +
  'well. What would you like to know?';

/**
 * Answers one utterance: route it, call the tool the router chose, and speak
 * what came back.
 *
 * The MCP surface is built in-process and thrown away per utterance. That is
 * the point of the in-memory transport pair - this is a webhook, so there is no
 * session to keep, and a fresh server per request means one listener's identity
 * can never outlive their request.
 *
 * `confirmed` marks the second pass over a sentence the listener has already
 * agreed to, which is the only thing the router needs to stop asking. `tool`
 * forces a named tool with the utterance as its `query`, which is how the web
 * offer's "yes" becomes a search without going near the router. `offerWeb` is
 * false once the listener has asked not to be offered the open web any more
 * (WEB_OFFER_ATTRIBUTE, read in the request handler). `lastSubject` is what the
 * previous turn was about, handed to the router so a follow-up that leans on a
 * pronoun ("how do I cook it") can be read back to its subject
 * (LAST_SUBJECT_ATTRIBUTE).
 */
async function answer(
  utterance: string,
  caller: Caller,
  log: FastifyInstance['log'],
  options: {
    confirmed?: boolean;
    tool?: string;
    offerWeb?: boolean;
    lastSubject?: string;
  } = {},
): Promise<AnswerOutcome> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(caller);
  const client = new Client({ name: 'globie-alexa-skill', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // A confirmed web search skips the router: the tool and the words are both
    // already known - the listener just said yes to the offer made after an
    // empty site search (confirmReply). Routing the sentence again would only
    // pick the site tool that had nothing to say.
    if (options.tool) {
      const result = await client.callTool({ name: options.tool, arguments: { query: utterance } });
      return { speech: speakableResult(result) || NO_MATCH_SPEECH, awaitingGoAhead: false };
    }

    const { tools } = await client.listTools();

    const routed = await routeToTool(
      {
        utterance,
        tools,
        ...(options.confirmed ? { confirmed: true } : {}),
        // What the last tool-running turn was about. A follow-up that leans on a
        // pronoun ("how do I cook it") names nothing the router can act on, so
        // the subject is stated in the prompt for it to read the pronoun back
        // against (router.ts, RouteInput.context).
        ...(options.lastSubject ? { context: options.lastSubject } : {}),
      },
      log,
    );
    if (!routed.ok) {
      log.warn({ status: routed.status, error: routed.error }, 'alexa: the router refused');
      return { speech: refusalSpeech(routed.status, routed.error), awaitingGoAhead: false };
    }

    const { tool, arguments: toolArguments } = routed.decision;
    if (!tool) {
      // The router's own line for a miss is a note written for the model, not
      // for an ear ("...doesn't name a dish or ask anything a tool can act
      // on"), so it is never read aloud. The listener hears a sentence written
      // for them instead - one that names the last subject when there is one, so
      // a near-miss follow-up can still be spelled out.
      return { speech: noMatchSpeech(options.lastSubject), awaitingGoAhead: true };
    }

    // A spend-gated tool may not run on the strength of the model's word alone.
    // The prompt asks it to check first, but it does not always obey, so the
    // unconfirmed call is answered with the question instead - and the sentence
    // is handed to the next turn (PENDING_ATTRIBUTE) so a following "yes" can
    // come back through here with `confirmed`, which is the only pass that runs
    // the tool.
    if (!options.confirmed && CONFIRMATION_REQUIRED.has(tool)) {
      log.info({ tool }, 'alexa: holding a spend-gated call for a go-ahead');
      return { speech: goAheadQuestion(toolArguments), awaitingGoAhead: true };
    }

    const result = await client.callTool({ name: tool, arguments: toolArguments });

    // What this turn was about, for the next follow-up to lean on. Read from the
    // tool's own answer where it names one - a dish, a species - so the subject
    // the next turn leans on is a noun, not the question that reached it.
    const subject = subjectFrom(result, toolArguments, utterance);

    // A site search the site's own records could not answer is the one case the
    // open web is for: the question is genuinely outside the catalogue. A search
    // that *did* answer has said its last word, so the listener is not talked
    // over with a question about somewhere else (siteAnswered) - which used to
    // happen after every good cookbook answer, turning a "yes" into a web page
    // instead of the recipe already in hand. A listener who has turned the offer
    // off hears the plain answer too (WEB_OFFER_ATTRIBUTE), and a second pass
    // over an already-confirmed sentence is never offered again - that turn was
    // already answering the question this one would ask.
    if (
      !options.confirmed &&
      options.offerWeb !== false &&
      SITE_SEARCH_TOOLS.has(tool) &&
      !siteAnswered(result)
    ) {
      log.info({ tool }, 'alexa: offering the open web after an empty site search');
      return {
        speech: `${speakableResult(result) || NO_MATCH_SPEECH}${WEB_OFFER_SUFFIX}`,
        awaitingGoAhead: true,
        webQuery: utterance,
        subject,
      };
    }

    return { speech: speakableResult(result) || NO_MATCH_SPEECH, awaitingGoAhead: false, subject };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/** The sentence the previous turn left waiting on a yes, or null when there is none. */
function pendingUtterance(envelope: AlexaEnvelope): string | null {
  const value = envelope.session?.attributes?.[PENDING_ATTRIBUTE];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The words a pending web-search offer is waiting to search for, or null. */
function pendingWebQuery(envelope: AlexaEnvelope): string | null {
  const value = envelope.session?.attributes?.[PENDING_WEB_ATTRIBUTE];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Whether this session has asked not to be offered the open web (WEB_OFFER_ATTRIBUTE). */
function webOfferSuppressed(envelope: AlexaEnvelope): boolean {
  return envelope.session?.attributes?.[WEB_OFFER_ATTRIBUTE] === true;
}

/** The subject the last tool-running turn left behind, or null (LAST_SUBJECT_ATTRIBUTE). */
function lastSubject(envelope: AlexaEnvelope): string | null {
  const value = envelope.session?.attributes?.[LAST_SUBJECT_ATTRIBUTE];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The session attributes every in-session reply should carry.
 *
 * `spoken` always writes the attribute set, and an empty set is what drops
 * whatever the last turn left behind - which would take the listener's "do not
 * offer me the open web" answer with it, since that answer is meant to last the
 * conversation. So each reply inside a session re-states the flag through here;
 * anything the turn itself wants to leave behind is merged on top. The last
 * subject is carried the same way: it is the memory a follow-up leans on, so a
 * turn that named no new subject must not erase the one it inherited.
 */
function keepAttributes(
  envelope: AlexaEnvelope,
  attributes: Record<string, unknown> = {},
): Record<string, unknown> {
  const kept: Record<string, unknown> = { ...attributes };
  if (webOfferSuppressed(envelope)) kept[WEB_OFFER_ATTRIBUTE] = true;
  const subject = lastSubject(envelope);
  if (subject && kept[LAST_SUBJECT_ATTRIBUTE] === undefined) {
    kept[LAST_SUBJECT_ATTRIBUTE] = subject;
  }
  return kept;
}

/**
 * What to say when the router found nothing to run.
 *
 * The router explains itself for the model, not the listener, so that line is
 * not spoken. This is written for the ear instead, and names the last subject
 * when there is one so a near-miss follow-up can be spelled out rather than
 * answered with a generic prompt.
 */
function noMatchSpeech(subject: string | null | undefined): string {
  return subject
    ? `I did not find anything to run for that. If it was about ${subject}, try putting it a ` +
        'little more directly. What would you like to know?'
    : NO_MATCH_SPEECH;
}

/**
 * What to say when no sample matched at all - most often AMAZON.FallbackIntent,
 * which arrives with no utterance to route (see the dispatch). Naming the last
 * subject is the only context left to offer, and it is enough to tell the
 * listener the skill was following along rather than starting over.
 */
function fallbackSpeech(subject: string): string {
  return (
    `I did not catch a question in that. We were talking about ${subject} - say a little more ` +
    'about what you want to know, or ask me something else.'
  );
}

/**
 * What a tool-running turn was about, for the next follow-up to lean on.
 *
 * The name of what actually answered is the cleanest subject to carry, so a
 * hit's own title is preferred - with a trailing parenthetical ("Green Curry
 * with Chicken (Gaeng Keow Wan Gai)") trimmed to the name a listener would say.
 * get_recipe carries no hits list, so its payload's dish names stand in; the
 * raw sentence is the last resort.
 */
function subjectFrom(
  result: unknown,
  toolArguments: Record<string, unknown>,
  utterance: string,
): string {
  const record = isRecord(result) ? result : {};
  const payload = isRecord(record.structuredContent) ? record.structuredContent : {};
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  const first = isRecord(hits[0]) ? hits[0] : {};
  if (typeof first.title === 'string' && first.title.trim()) {
    return first.title.trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
  }
  for (const key of ['nameEn', 'nameLocal', 'nameThai']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const value of Object.values(toolArguments)) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return utterance;
}

/**
 * Whether a site search actually answered from Globie's own records.
 *
 * Both site searches report their catalogue rows in `hits` (tools/catalog.ts,
 * tools/cookbook.ts), and an empty list is the one case the open-web offer is
 * for: the question is genuinely outside the site. Anything unreadable counts as
 * an answer, so the offer never appears on a tool it was not designed for.
 */
function siteAnswered(result: unknown): boolean {
  const record = isRecord(result) ? result : {};
  const payload = isRecord(record.structuredContent) ? record.structuredContent : {};
  const hits = Array.isArray(payload.hits) ? payload.hits : null;
  return hits === null ? true : hits.length > 0;
}

/**
 * Answers a spoken yes or no to whatever the previous turn asked.
 *
 * Without this the confirmation the router asks for is unanswerable: a bare
 * "yes" carries no words to route, so it fell through to the fallback prompt and
 * the listener could never agree to anything the skill had asked them. The
 * sentence being confirmed travels in the session attributes (PENDING_ATTRIBUTE)
 * rather than in this server, which keeps a webhook with no session of its own
 * from needing one.
 */
async function confirmReply(
  intent: string,
  envelope: AlexaEnvelope,
  caller: Caller,
  log: FastifyInstance['log'],
): Promise<AlexaSpeech> {
  const pending = pendingUtterance(envelope);
  const pendingWeb = pendingWebQuery(envelope);

  // Neither reply carries the attribute forward: the question has been answered
  // either way, and a stale pending sentence must not be reachable later.
  if (intent === 'AMAZON.NoIntent') {
    return spoken(
      pending || pendingWeb
        ? 'No problem, I will leave that alone. What else would you like to know?'
        : 'Okay. What would you like to know?',
      keepAttributes(envelope),
    );
  }

  // A web-search offer is answered by searching, not by routing the sentence a
  // second time: the site tool that just answered would only be picked again
  // (see PENDING_WEB_ATTRIBUTE). The words were kept for exactly this call.
  if (pendingWeb) {
    const answered = await answer(pendingWeb, caller, log, { tool: 'search_web' });
    return spoken(answered.speech, keepAttributes(envelope));
  }

  if (!pending) {
    return spoken(
      'There is nothing waiting on a yes just now. Ask me to make a soundscape, and I will ' +
        'check with you before starting it.',
      keepAttributes(envelope),
    );
  }

  const answered = await answer(pending, caller, log, { confirmed: true });
  return spoken(answered.speech, keepAttributes(envelope));
}

/**
 * Starts the newest finished soundscape this listener owns.
 *
 * This one has nothing to add to a track the listener already asked for, so it
 * either sends the directive or explains itself in words - never both. (A Play
 * reply may carry speech; announcing() is what the paths below use when there
 * is something worth saying first.)
 * The list it chooses from is the studio's own library, scoped to the caller's
 * device by RLS and ordered newest first (studio/src/store.ts), so the first
 * ready track is the last one worth hearing. The URL is made absolute because
 * the device fetches it with no headers and no page to resolve against.
 */
async function playLatestSoundscape(
  caller: Caller,
  log: FastifyInstance['log'],
  carry: Record<string, unknown>,
): Promise<AlexaSpeech | AlexaDirective> {
  try {
    const { tracks } = await callProxy<StudioLibrary>('studio', '/v1/studio/library', caller);
    const ready = (tracks ?? []).find((track) => track.status === 'ready' && track.audioUrl);
    if (!ready?.audioUrl) {
      const rendering = (tracks ?? []).some(
        (track) => track.status === 'queued' || track.status === 'generating',
      );
      return spoken(
        rendering
          ? 'Your soundscape is still being rendered. Give it a moment, then ask me to play it again.'
          : 'There is no soundscape to play yet. Ask me to make one first - for example, ' +
            'ask Globie Earth to generate a dawn chorus for the wetland.',
        carry,
      );
    }
    return playing(absoluteUrl('studio', ready.audioUrl) ?? ready.audioUrl, ready.id);
  } catch (error) {
    log.error({ err: error }, 'alexa: could not play the soundscape');
    return spoken('I could not start your soundscape just now. Please try again in a moment.', carry);
  }
}

/**
 * Plays the public sound library - what listeners at the site have already
 * published, oldest browse-able newest first.
 *
 * A different route from the one above, and deliberately so: /v1/studio/public
 * is the shared catalogue and answers without a device header, while
 * /v1/studio/library is private to the caller. Its tracks carry the same
 * relative audioUrl, so the same absoluteUrl makes them playable.
 */
async function playPublicTrack(
  caller: Caller,
  log: FastifyInstance['log'],
  carry: Record<string, unknown>,
): Promise<AlexaSpeech | AlexaDirective> {
  try {
    const { tracks } = await callProxy<StudioPublic>('studio', '/v1/studio/public?limit=5', caller);
    const ready = (tracks ?? []).find((track) => track.audioUrl);
    if (!ready?.audioUrl) {
      return spoken(
        'The public library has nothing to play just now. Ask me to make a new soundscape instead.',
        carry,
      );
    }
    return announcing(
      `Here is ${ready.title}, from the public library.`,
      absoluteUrl('studio', ready.audioUrl) ?? ready.audioUrl,
      ready.id,
    );
  } catch (error) {
    log.error({ err: error }, 'alexa: could not play from the public library');
    return spoken(
      'I could not reach the public library just now. Please try again in a moment.',
      carry,
    );
  }
}

/**
 * Walks the listener through a guided meditation.
 *
 * Both shapes are one mixed media file served by the Globie Earth site itself,
 * so each starts and runs to the end on its own - no chaining, because there is
 * nothing to chain. A duration the listener asked for (10, 15 or 30 minutes) is
 * one such file; everything else is the short grounding lesson, mixed the same
 * way. The media is Globie Earth's own published asset, so this server links it
 * at VOICE_BASE_URL rather than rehosting a copy of its own.
 */
function playMeditation(
  minutes: number | null,
  carry: Record<string, unknown>,
): AlexaSpeech | AlexaDirective {
  const guide = minutes ? GUIDES[minutes] : undefined;
  const bed = randomBed();
  if (guide) {
    const name = `${guide.name}-${bed.id}`;
    return announcing(
      `Here is your ${guide.minutes} minute guided meditation, with ${bed.label} in the background. Settle in, and follow the voice.`,
      `${VOICE_BASE_URL}/voice/guides/${name}.mp3`,
      `guide:${name}`,
    );
  }
  // The grounding lesson is mixed into one file too, for the same reason the
  // long guides are: a bed carried across a chain of separate streams would
  // restart at every line.
  const name = `${SHORT_GUIDE}-${bed.id}`;
  return announcing(
    `Here is a grounding meditation, with ${bed.label} in the background. Settle in and follow the voice.`,
    `${VOICE_BASE_URL}/voice/guides/${name}.mp3`,
    `guide:${name}`,
  );
}

/** One episode, as the list route reports it. */
type PodcastEpisode = NonNullable<PodcastEpisodes['episodes']>[number];

/** One show on a podcast shelf. */
type PodcastFeed = NonNullable<PodcastFeeds['feeds']>[number];

/**
 * How many episodes of a show are read, so "next" has somewhere to go.
 *
 * The same list also names the newest episode, so this is the lookup depth as
 * well as the queue depth.
 */
const PODCAST_QUEUE = 10;

/**
 * The token that names one episode: its show, and its place in that show.
 *
 * `podcast:<feedId>:<index>` is the third token vocabulary in this file - see
 * nextMeditationStep for `meditation:<n>` and playMeditation for `guide:<name>`
 * - and it carries its own state the same way: the device echoes the token back
 * on every playback event and on every request sent while it plays, so the index
 * (0-based, newest first) is how a later "next" finds its neighbour without this
 * server keeping a queue.
 */
function podcastToken(feedId: number, index: number): string {
  return `podcast:${feedId}:${index}`;
}

/** The show and position a playing token names, or null for any other stream. */
function parsePodcastToken(token: string | undefined): { feedId: number; index: number } | null {
  const played = /^podcast:(\d+):(\d+)$/.exec(token ?? '');
  if (!played) return null;
  return { feedId: Number(played[1]), index: Number(played[2]) };
}

/**
 * The theme a PlayPodcastIntent named, or null for the default forest shelf.
 *
 * The slot is the custom PodcastTheme type, whose values are the listening
 * themes themselves (infra/podcast/src/themes.ts). Alexa echoes back what was
 * *said*, not what it matched - "play a wellness podcast" arrives as
 * `value: "wellness"` with the canonical `wellbeing` only inside `resolutions`
 * - and the library knows only the canonical one, so the resolved value is
 * what a lookup must use. The raw value is the fallback for a slot filled
 * without entity resolution (a Manual JSON request, say).
 *
 * Either way the answer is normalised to the slug the library's themes use:
 * the model's value is "personal development", the library's is
 * "personal-development", and passing the model's form on would be rejected.
 */
function podcastThemeFrom(request: AlexaEnvelope['request']): string | null {
  const slot = request?.intent?.slots?.theme;
  const resolved = slot?.resolutions?.resolutionsPerAuthority
    ?.flatMap((authority) => authority?.values ?? [])
    .map((entry) => entry?.value?.name)
    .find((name) => name?.trim());
  const value = (resolved ?? slot?.value)?.trim();
  return value ? value.toLowerCase().replace(/\s+/g, '-') : null;
}

/**
 * The episodes of one show, newest first, as the library holds them now.
 *
 * Read live rather than out of the mirror: the mirror's newestEnclosureUrl only
 * moves when it is next crawled - it was three episodes behind the live list
 * when this was written - so the episode list is what actually names the newest
 * episode.
 *
 * A list the index will not answer for is not fatal, because the mirror still
 * carries one playable URL for the show; the failure is reported and an empty
 * list returned, and the caller falls back to that URL.
 */
async function podcastEpisodes(
  feedId: number,
  caller: Caller,
  log: FastifyInstance['log'],
): Promise<PodcastEpisode[]> {
  try {
    const { episodes } = await callProxy<PodcastEpisodes>(
      'podcast',
      `/v1/podcast/feeds/${feedId}/episodes?max=${PODCAST_QUEUE}`,
      caller,
    );
    return (episodes ?? []).filter((episode) => episode.enclosureUrl);
  } catch (error) {
    log.warn({ err: error, feedId }, 'alexa: could not read a show’s episode list');
    return [];
  }
}

/**
 * The freshest playable show on one shelf, or undefined if that shelf has
 * nothing to offer - including when it refuses to answer at all.
 *
 * A refusal is absorbed rather than raised because a shelf is only ever one
 * attempt at a theme: `bytheme` answers 400 for a theme its list does not
 * carry (`{ error: "bytheme needs a theme from /v1/podcast/themes." }`), which
 * is a miss to fall past - the caller's next shelf may still answer - not a
 * reason to abandon the turn.
 */
async function freshestShow(
  shelf: string,
  caller: Caller,
  log: FastifyInstance['log'],
): Promise<PodcastFeed | undefined> {
  try {
    const { feeds } = await callProxy<PodcastFeeds>('podcast', shelf, caller);
    return (feeds ?? []).find((feed) => feed.newestEnclosureUrl);
  } catch (error) {
    log.warn({ err: error, shelf }, 'alexa: a podcast shelf did not answer');
    return undefined;
  }
}

/**
 * Plays the freshest episode of a show from the public library.
 *
 * The stream is the publisher's own enclosureUrl, which is how a podcast is
 * meant to be played and what the podcast plan specifies - the show's file is
 * linked, never rehosted. A theme narrows the shelf to that theme's shows; with
 * no theme the freshest forest show is used, which is the one show this skill
 * played before themes could be named by voice.
 *
 * A named theme is asked of `bytheme` first and of the library's keyword search
 * second, so a word the theme list does not carry still finds its shows rather
 * than ending the turn; only when neither shelf answers is the caller told
 * there is no such podcast.
 */
async function playPodcast(
  caller: Caller,
  log: FastifyInstance['log'],
  carry: Record<string, unknown>,
  theme: string | null,
): Promise<AlexaSpeech | AlexaDirective> {
  const shelves = theme
    ? [
        `/v1/podcast/bytheme?theme=${encodeURIComponent(theme)}&max=5`,
        `/v1/podcast/search?q=${encodeURIComponent(theme)}&max=5`,
      ]
    : ['/v1/podcast/search?q=forest&max=5'];

  try {
    let show: PodcastFeed | undefined;
    for (const shelf of shelves) {
      show = await freshestShow(shelf, caller, log);
      if (show) break;
    }
    if (!show?.newestEnclosureUrl) {
      return spoken(
        theme
          ? `I could not find a ${theme.replace(/-/g, ' ')} podcast to play just now.`
          : 'I could not find a podcast episode to play just now.',
        carry,
      );
    }
    const episodes = await podcastEpisodes(show.id, caller, log);
    return announcing(
      `Here is the latest episode of ${show.title}.`,
      episodes[0]?.enclosureUrl ?? show.newestEnclosureUrl,
      podcastToken(show.id, 0),
    );
  } catch (error) {
    log.error({ err: error }, 'alexa: could not play a podcast');
    return spoken(
      'I could not reach the podcast library just now. Please try again in a moment.',
      carry,
    );
  }
}

/**
 * Moves to the episode after the one now playing.
 *
 * The playing stream is named by the token the device reports on the request -
 * the same token its Play directive carried - so `podcast:<feedId>:<index>` is
 * all this needs to find the neighbour. Only a podcast is skippable: a guided
 * session is one file with nothing behind it, and a meditation lesson is chained
 * by nextMeditationStep instead - so both are answered by their tokens simply
 * not parsing here.
 */
async function playNextEpisode(
  caller: Caller,
  log: FastifyInstance['log'],
  carry: Record<string, unknown>,
  token: string | undefined,
): Promise<AlexaSpeech | AlexaDirective> {
  const playing = parsePodcastToken(token);
  if (!playing) return spoken('Nothing is playing that I can move past.', carry);
  const episodes = await podcastEpisodes(playing.feedId, caller, log);
  const next = episodes[playing.index + 1];
  if (!next) return spoken('That is the last episode I have for this show.', carry);
  return announcing(
    'Here is the next episode.',
    next.enclosureUrl,
    podcastToken(playing.feedId, playing.index + 1),
  );
}

/** What /health reports about this front door. */
export function alexaHealth(): {
  verifySignature: boolean;
  skillId: string | null;
  certExpiryGraceDays: number;
} {
  return {
    verifySignature: alexaVerificationEnabled(),
    skillId: alexaSkillId(),
    // Non-zero means this deployment accepts certificates Amazon has already
    // retired, which is the case only because the echo.api bucket and the clock
    // disagree by years. Reported so the deviation is visible from outside.
    certExpiryGraceDays: alexaCertExpiryGraceDays(),
  };
}

export function registerAlexaRoute(app: FastifyInstance): void {
  app.post('/alexa', async (request, reply) => {
    // The untouched bytes, captured by the JSON parser in server.ts. The
    // signature is over these, not over the re-serialised object.
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;

    const envelope = parseEnvelope(request.body);
    if (!envelope) {
      return reply.code(400).send({ error: 'The body is not an Alexa request envelope.' });
    }

    const person: AlexaPerson = envelope.context?.System?.user ?? envelope.session?.user ?? {};

    if (alexaVerificationEnabled()) {
      const verification = await verifyAlexaRequest({
        certChainUrl: headerString(request.headers['signaturecertchainurl']),
        signature: headerString(request.headers.signature),
        rawBody,
        timestamp: envelope.request?.timestamp,
        skillId: envelope.session?.application?.applicationId,
        headers: request.headers,
      });
      if (!verification.ok) {
        // The detail is what makes a refusal fixable: which certificate Amazon
        // named, how long the body was and what it hashed to, and whether the
        // signature header arrived intact. Without it the only way to tell those
        // apart is to guess, rebuild and redeploy.
        request.log.warn(
          { reason: verification.reason, ...verification.detail },
          'alexa: refused an unverified request',
        );
        return reply.code(401).send({ error: `Alexa request verification failed: ${verification.reason}` });
      }
      if (verification.detail) {
        request.log.info(verification.detail, 'alexa: verified, but only after repairing the request');
      }
    } else {
      // Loud on purpose: with this off, anyone who can reach the port can spend
      // this server's model key through /alexa.
      request.log.warn('alexa: signature verification is DISABLED (ALEXA_VERIFY_SIGNATURE=false)');
    }

    const type = envelope.request?.type;

    // The AudioPlayer events carry no intent - they report what the device did
    // with the stream. A reply to one of these may carry a directive and no
    // standard properties (the interface reference), so they are answered with
    // a directive or with nothing at all, never with speech. Only
    // PlaybackNearlyFinished has anything to say back: it is the one event that
    // lets the next track be queued, which is how a guided meditation runs past
    // its first voice line. Every other event is logged and left unanswered.
    if (type?.startsWith('AudioPlayer.')) {
      request.log.info({ type }, 'alexa: playback event');
      if (type === 'AudioPlayer.PlaybackNearlyFinished') {
        const next = nextMeditationStep(envelope.request?.token);
        if (next) return reply.send(next);
      }
      return reply.send({ version: '1.0', response: {} });
    }
    if (type === 'SessionEndedRequest') {
      return reply.send({ version: '1.0', response: { shouldEndSession: true } });
    }
    if (type === 'LaunchRequest') {
      return reply.send(spoken(LAUNCH_SPEECH));
    }
    if (type !== 'IntentRequest') {
      return reply.send(spoken(HELP_SPEECH));
    }

    const intent = envelope.request?.intent?.name ?? '';
    if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') {
      return reply.send(ending(GOODBYE_SPEECH));
    }
    if (intent === 'AMAZON.PauseIntent') {
      // While the skill is streaming, Alexa delivers "stop" as a PauseIntent
      // (the audio-player guide), so this is the branch that actually silences
      // the forest. There is no Pause directive - Stop is the pause.
      return reply.send(stopping());
    }
    if (intent === 'AMAZON.HelpIntent') {
      return reply.send(spoken(HELP_SPEECH, keepAttributes(envelope)));
    }
    // The open-web offer is useful until it is not, so the listener can turn it
    // off in one sentence. The flag rides the session attributes because that is
    // the only memory this webhook has: it lasts the conversation, and the next
    // one starts with the offer back on. Both replies state the attribute
    // explicitly - `true` to set it, the default empty set to drop it - which
    // also abandons any question the previous turn was still waiting on.
    if (intent === 'DisableWebOfferIntent') {
      return reply.send(spoken(WEB_OFFER_OFF_SPEECH, { [WEB_OFFER_ATTRIBUTE]: true }));
    }
    if (intent === 'EnableWebOfferIntent') {
      return reply.send(spoken(WEB_OFFER_ON_SPEECH));
    }
    // A bare yes or no carries no words to route, so it is answered from the
    // question the previous turn left in the session attributes rather than by
    // the router. See confirmReply.
    if (intent === 'AMAZON.YesIntent' || intent === 'AMAZON.NoIntent') {
      const caller = callerFor(envelope);
      if (!caller) {
        request.log.warn({ userId: person.userId ?? null }, 'alexa: the envelope named no caller');
        return reply.send(
          spoken('I could not tell who is asking, so I cannot act on that.', keepAttributes(envelope)),
        );
      }
      return reply.send(await confirmReply(intent, envelope, caller, request.log));
    }
    if (intent === 'PlaySoundscapeIntent' || intent === 'AMAZON.ResumeIntent') {
      const caller = callerFor(envelope);
      if (!caller) {
        request.log.warn({ userId: person.userId ?? null }, 'alexa: the envelope named no caller');
        return reply.send(
          spoken('I could not tell who is asking, so I cannot find your music.', keepAttributes(envelope)),
        );
      }
      return reply.send(await playLatestSoundscape(caller, request.log, keepAttributes(envelope)));
    }
    // "Next" only means something while a podcast plays, and the only thing that
    // names that podcast is the token the device is holding - the one this skill
    // put in its Play directive and which the host echoes back here on every
    // request that arrives mid-stream. A token for anything else (a guided
    // session, a meditation lesson, a soundscape) simply does not parse.
    // AMAZON.NextIntent ships with its own utterance set and the model cannot
    // extend it, so the phrased forms ("next episode") arrive as our own
    // NextEpisodeIntent - the two mean the same thing here.
    if (intent === 'AMAZON.NextIntent' || intent === 'NextEpisodeIntent') {
      const caller = callerFor(envelope);
      if (!caller) {
        request.log.warn({ userId: person.userId ?? null }, 'alexa: the envelope named no caller');
        return reply.send(
          spoken('I could not tell who is asking, so I cannot change the episode.', keepAttributes(envelope)),
        );
      }
      return reply.send(
        await playNextEpisode(
          caller,
          request.log,
          keepAttributes(envelope),
          envelope.context?.AudioPlayer?.token,
        ),
      );
    }
    // The three share one branch because they differ only in which track they
    // pick - all three take the caller, decide a URL, and hand the device a Play
    // directive (announcing their choice first).
    if (
      intent === 'PlayPodcastIntent' ||
      intent === 'PlayMeditationIntent' ||
      intent === 'PlayPublicTrackIntent'
    ) {
      const caller = callerFor(envelope);
      if (!caller) {
        request.log.warn({ userId: person.userId ?? null }, 'alexa: the envelope named no caller');
        return reply.send(
          spoken('I could not tell who is asking, so I cannot start that audio.', keepAttributes(envelope)),
        );
      }
      if (intent === 'PlayPodcastIntent') {
        return reply.send(
          await playPodcast(caller, request.log, keepAttributes(envelope), podcastThemeFrom(envelope.request)),
        );
      }
      if (intent === 'PlayPublicTrackIntent') {
        return reply.send(await playPublicTrack(caller, request.log, keepAttributes(envelope)));
      }
      return reply.send(
        playMeditation(guideMinutesFrom(envelope.request), keepAttributes(envelope)),
      );
    }

    // Everything else that is not our own intent is a model miss - most often
    // AMAZON.FallbackIntent, which arrives with no utterance to route. Asking
    // the listener to rephrase is the only honest thing left to do, and naming
    // the last subject keeps the thread: "we were talking about green curry"
    // tells the listener the skill was following along rather than starting over.
    if (intent !== 'AskGlobieIntent') {
      const subject = lastSubject(envelope);
      return reply.send(
        spoken(subject ? fallbackSpeech(subject) : FALLBACK_SPEECH, keepAttributes(envelope)),
      );
    }

    const utterance = envelope.request?.intent?.slots?.query?.value?.trim() ?? '';
    if (!utterance) {
      const subject = lastSubject(envelope);
      return reply.send(
        spoken(subject ? fallbackSpeech(subject) : FALLBACK_SPEECH, keepAttributes(envelope)),
      );
    }

    const caller = callerFor(envelope);
    if (!caller) {
      request.log.warn({ userId: person.userId ?? null }, 'alexa: the envelope named no caller');
      return reply.send(
        spoken(
          'I could not tell who is asking, so I cannot look anything up. Please try again.',
          keepAttributes(envelope),
        ),
      );
    }

    try {
      const answered = await answer(utterance, caller, request.log, {
        offerWeb: !webOfferSuppressed(envelope),
        lastSubject: lastSubject(envelope) ?? undefined,
      });
      // A turn that left a question open is the one this reply has to keep
      // answerable. The words go into the session attributes, and a following
      // "yes" either searches the web for them (webQuery, PENDING_WEB_ATTRIBUTE)
      // or routes that same sentence again as confirmed (confirmReply) - the two
      // are kept apart because a site search must not be routed back into the
      // tool that just answered. A turn that ran a tool asked nothing, so it
      // leaves the attributes to keepAttributes alone - and an empty set there
      // is what actually drops the sentence, since a reply that omits the key
      // leaves the previous one in place.
      //
      // What this turn was about travels the same way: a new subject is written
      // over the old one so a follow-up leans on the latest thing answered, while
      // a turn that named nothing new leaves keepAttributes to carry the old one
      // forward.
      const carried: Record<string, unknown> = {};
      if (answered.subject) carried[LAST_SUBJECT_ATTRIBUTE] = answered.subject;
      if (answered.awaitingGoAhead) {
        if (answered.webQuery) carried[PENDING_WEB_ATTRIBUTE] = answered.webQuery;
        else carried[PENDING_ATTRIBUTE] = utterance;
      }
      return reply.send(spoken(answered.speech, keepAttributes(envelope, carried)));
    } catch (error) {
      request.log.error({ err: error }, 'alexa: the utterance failed');
      return reply.send(
        spoken(
          'Something went wrong while looking that up. Please try again in a moment.',
          keepAttributes(envelope),
        ),
      );
    }
  });
}

/** The first value of a possibly repeated header, or undefined. */
function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || undefined;
}
