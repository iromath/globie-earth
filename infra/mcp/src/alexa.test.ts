// Tests for the three podcast defects the Alexa adapter had: an episode that
// never advanced, a "resume" that started a soundscape instead, and a Play
// directive handed out for a URL that would refuse the device.
//
// They drive the real route rather than calling helpers, because the behaviour
// under test is a reply to an Alexa request - the directive and the speech are
// the contract, and the token vocabulary that carries a paused stream's
// position is only observable through them. Every upstream (PostgREST, the
// studio and podcast proxies, the publisher's file) is answered by the fetch
// stub below, so nothing here needs a network.
//
// The file lives under src/ because that is all tsconfig compiles; the script
// in package.json builds first and then runs this file from dist.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

import Fastify from 'fastify';

import { registerAlexaRoute } from './alexa.js';
import { registerTvCommandsRoute } from './tvCommands.js';
import { registerTvGameRoutes } from './tvGame.js';

// Read lazily by the code under test, so setting them here is early enough.
process.env.ALEXA_VERIFY_SIGNATURE = 'false';
process.env.POSTGREST_URL = 'https://postgrest.test';
process.env.PODCAST_URL = 'https://podcast.test';
process.env.STUDIO_URL = 'https://studio.test';
process.env.STUDIO_PUBLIC_URL = 'https://studio.test';

const EPISODE_TWO = 'https://audio.test/episode-2.mp3';
const EPISODE_ONE = 'https://audio.test/episode-1.mp3';
/** The television every TV-relay test pairs with. Must be a UUID: that is
 * what resolveCaller accepts from the X-Device-Id header. */
const TV_DEVICE_ID = '11111111-1111-4111-8111-111111111111';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;

/**
 * Identities whose durable pairing is withdrawn.
 *
 * The stub pairs everyone by default, which is what the relay tests want; the
 * unpaired test names its identity up front so no pairing is cached first.
 */
const unpairedAlexaIds = new Set<string>();

/**
 * The Alexa identity a userId derives to, re-stated from alexa.ts.
 *
 * Duplicated on purpose: the test needs to name the identity before the route
 * has ever seen it, and a four-line hash is cheaper to read here than a
 * test-only export would be to carry in production code.
 */
function alexaDeviceIdFor(userId: string): string {
  const bytes = createHash('sha256').update(`globie-alexa:${userId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Answers every upstream this adapter can reach, from fixed fixtures. */
function stubFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

  // ensureDevice: the insert is accepted and its row is never read back.
  if (url.hostname === 'postgrest.test') {
    // tv_claim_pairing is a scalar RPC: PostgREST answers with the uuid itself.
    if (url.pathname === '/rpc/tv_claim_pairing') {
      return Promise.resolve(json(TV_DEVICE_ID));
    }
    // The durable pairing read. The row echoes the identity in the filter, so
    // each test's derived Alexa device id matches without computing it here.
    if (url.pathname === '/tv_pairings') {
      const alexa = url.searchParams.get('alexa_device_id');
      const tv = url.searchParams.get('tv_device_id');
      if (alexa) {
        const id = alexa.replace(/^eq\./, '');
        if (unpairedAlexaIds.has(id)) return Promise.resolve(json([]));
        return Promise.resolve(
          json([
            {
              tv_device_id: TV_DEVICE_ID,
              alexa_device_id: id,
              paired_at: new Date(0).toISOString(),
            },
          ]),
        );
      }
      if (tv) {
        return Promise.resolve(
          json([
            {
              tv_device_id: tv.replace(/^eq\./, ''),
              alexa_device_id: '22222222-2222-4222-8222-222222222222',
              paired_at: new Date(0).toISOString(),
            },
          ]),
        );
      }
      return Promise.resolve(json([]));
    }
    return Promise.resolve(new Response(null, { status: 201 }));
  }

  if (url.hostname === 'studio.test') {
    return Promise.resolve(
      json({ tracks: [{ id: 'track-1', status: 'ready', audioUrl: '/audio/dawn.mp3' }] }),
    );
  }

  if (url.hostname === 'podcast.test') {
    // A theme the library cannot play is asked for by name by the rejection test.
    if (url.search.includes('refused')) {
      return Promise.resolve(
        json({ feeds: [{ id: 9, title: 'Refusing Show', newestEnclosureUrl: 'https://refused.test/ep.mp3' }] }),
      );
    }
    if (/\/v1\/podcast\/(search|bytheme)/.test(url.pathname)) {
      return Promise.resolve(
        json({
          feeds: [
            {
              id: 7,
              url: 'https://example.test/feed/7',
              title: 'Forest Hour',
              author: 'Forest Author',
              link: null,
              image: null,
              language: 'en',
              categories: [],
              episodeCount: 2,
              popularityScore: null,
              newestItemAt: null,
              newestEnclosureUrl: EPISODE_ONE,
              newestEnclosureDurationSec: null,
              podcastGuid: null,
              itunesId: null,
              description: null,
            },
          ],
        }),
      );
    }
    if (url.pathname === '/v1/podcast/feeds/7') {
      return Promise.resolve(
        json({
          feed: {
            id: 7,
            url: 'https://example.test/feed/7',
            title: 'Forest Hour',
            author: 'Forest Author',
            link: null,
            image: null,
            language: 'en',
            categories: [],
            episodeCount: 2,
            popularityScore: null,
            newestItemAt: null,
            newestEnclosureUrl: null,
            newestEnclosureDurationSec: null,
            podcastGuid: null,
            itunesId: null,
            description: null,
          },
        }),
      );
    }
    if (url.pathname === '/v1/podcast/feeds/404') {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'No feed with that id.' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.pathname === '/v1/podcast/feeds/7/episodes') {
      return Promise.resolve(
        json({
          episodes: [
            { id: 1, title: 'One', enclosureUrl: EPISODE_ONE, durationSec: 600 },
            { id: 2, title: 'Two', enclosureUrl: EPISODE_TWO, durationSec: 600 },
          ],
        }),
      );
    }
    // Show 9 has no episode list, so its mirror URL is the one probed.
    if (url.pathname === '/v1/podcast/feeds/9/episodes') {
      return Promise.resolve(json({ episodes: [] }));
    }
  }

  if (url.hostname === 'audio.test') {
    return Promise.resolve(
      new Response(null, { status: 206, headers: { 'content-type': 'audio/mpeg' } }),
    );
  }

  if (url.hostname === 'refused.test') {
    return Promise.resolve(new Response(null, { status: 403 }));
  }

  return Promise.reject(new Error(`unexpected fetch: ${url.href}`));
}

/** An envelope whose caller is one derived device id per userId. */
function envelope(
  request: Record<string, unknown>,
  userId: string,
  context: Record<string, unknown> = {},
  attributes?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: '1.0',
    request,
    context: { System: { user: { userId } }, ...context },
    // What the previous reply's sessionAttributes come back as. Only sent when
    // a test is following a turn that kept the session open.
    ...(attributes ? { session: { attributes } } : {}),
  };
}

const app = Fastify();

before(async () => {
  globalThis.fetch = stubFetch as typeof fetch;
  registerAlexaRoute(app);
  registerTvCommandsRoute(app);
  registerTvGameRoutes(app);
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

interface AlexaReply {
  response: {
    outputSpeech?: { text?: string };
    reprompt?: { outputSpeech?: { text?: string } };
    shouldEndSession?: boolean;
    directives?: Array<{
      type: string;
      playBehavior?: string;
      audioItem?: {
        stream?: { token?: string; url?: string; offsetInMilliseconds?: number; expectedPreviousToken?: string };
      };
    }>;
  };
  sessionAttributes?: Record<string, unknown>;
}

async function ask(body: Record<string, unknown>): Promise<AlexaReply> {
  const response = await app.inject({ method: 'POST', url: '/alexa', payload: body });
  assert.equal(response.statusCode, 200);
  return response.json() as AlexaReply;
}

test('a nearly finished podcast queues the next episode', async () => {
  const reply = await ask(
    envelope(
      { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'podcast:7:0' },
      'user-advance',
    ),
  );

  const directive = reply.response.directives?.[0];
  assert.equal(directive?.type, 'AudioPlayer.Play');
  assert.equal(directive?.playBehavior, 'ENQUEUE');
  assert.equal(directive?.audioItem?.stream?.url, EPISODE_TWO);
  assert.equal(directive?.audioItem?.stream?.token, 'podcast:7:1');
  // ENQUEUE is only legal when it names the stream it follows.
  assert.equal(directive?.audioItem?.stream?.expectedPreviousToken, 'podcast:7:0');
});

test('the last episode of a show ends without a directive', async () => {
  const reply = await ask(
    envelope(
      { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'podcast:7:1' },
      'user-last-episode',
    ),
  );

  assert.deepEqual(reply.response.directives, undefined);
  assert.equal(reply.response.outputSpeech, undefined);
});

test('a one-file stream queues nothing', async () => {
  const reply = await ask(
    envelope({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'guide:rain-1' }, 'user-guide'),
  );

  assert.deepEqual(reply.response.directives, undefined);
});

test('resume picks the paused podcast up where it stopped', async () => {
  const userId = 'user-resume';
  const context = { AudioPlayer: { token: 'podcast:7:0' } };

  // What the device holds while it plays, then what it reports on pause.
  await ask(envelope({ type: 'IntentRequest', intent: { name: 'PlayPodcastIntent', slots: {} } }, userId, context));
  await ask(envelope({ type: 'AudioPlayer.PlaybackStarted', token: 'podcast:7:0' }, userId, context));
  await ask(
    envelope(
      { type: 'AudioPlayer.PlaybackStopped', token: 'podcast:7:0', offsetInMilliseconds: 61_000 },
      userId,
      context,
    ),
  );

  const reply = await ask(
    envelope({ type: 'IntentRequest', intent: { name: 'AMAZON.ResumeIntent', slots: {} } }, userId, context),
  );

  const stream = reply.response.directives?.[0]?.audioItem?.stream;
  assert.equal(reply.response.directives?.[0]?.playBehavior, 'REPLACE_ALL');
  assert.equal(stream?.url, EPISODE_ONE);
  assert.equal(stream?.token, 'podcast:7:0');
  assert.equal(stream?.offsetInMilliseconds, 61_000);
});

test('resume falls back to the soundscape when nothing is remembered', async () => {
  const reply = await ask(
    envelope({ type: 'IntentRequest', intent: { name: 'AMAZON.ResumeIntent', slots: {} } }, 'user-fresh'),
  );

  const stream = reply.response.directives?.[0]?.audioItem?.stream;
  assert.equal(stream?.url, 'https://studio.test/audio/dawn.mp3');
  assert.equal(stream?.token, 'track-1');
  assert.equal(stream?.offsetInMilliseconds, 0);
});

test('a publisher that refuses the probe is passed over for speech, not silence', async () => {
  const reply = await ask(
    envelope(
      { type: 'IntentRequest', intent: { name: 'PlayPodcastIntent', slots: { theme: { value: 'refused' } } } },
      'user-refused',
    ),
  );

  assert.deepEqual(reply.response.directives, undefined);
  assert.match(reply.response.outputSpeech?.text ?? '', /could not find a playable/);
});

/** Drains whatever the relay has queued for one television. */
async function drain(deviceId: string): Promise<unknown> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/tv/commands?waitMs=1',
    headers: { 'x-device-id': deviceId },
  });
  assert.equal(response.statusCode, 200);
  return (response.json() as { command: unknown }).command;
}

test('a spoken home command reaches the paired television', async () => {
  const reply = await ask(
    envelope(
      { type: 'IntentRequest', intent: { name: 'AMAZON.NavigateHomeIntent', slots: {} } },
      'user-tv-home',
    ),
  );

  assert.match(reply.response.outputSpeech?.text ?? '', /home screen on the TV/);
  assert.deepEqual(await drain(TV_DEVICE_ID), { type: 'home' });
});

test('the custom home intent reaches the television, because "go home" never does', async () => {
  const reply = await ask(
    envelope({ type: 'IntentRequest', intent: { name: 'GoHomeIntent', slots: {} } }, 'user-tv-go-home'),
  );

  assert.match(reply.response.outputSpeech?.text ?? '', /home screen on the TV/);
  assert.deepEqual(await drain(TV_DEVICE_ID), { type: 'home' });
});

test('a spoken "back" reaches the paired television as one screen-relative move', async () => {
  const reply = await ask(
    envelope({ type: 'IntentRequest', intent: { name: 'BackIntent', slots: {} } }, 'user-tv-back'),
  );

  assert.match(reply.response.outputSpeech?.text ?? '', /Going back on the TV/);
  // No destination in the command: the TV resolves it against the screen that
  // is showing, so a queued back can never land on a stale one.
  assert.deepEqual(await drain(TV_DEVICE_ID), { type: 'back' });
});

test('a spoken screen name jumps the TV to that chip', async () => {
  const cases = [
    ['OpenQuestsIntent', 'quests', /Opening Quests on the TV/],
    ['OpenLearnIntent', 'learn', /Opening Globie Learn on the TV/],
    ['OpenFocusIntent', 'focus', /Opening Focus mode on the TV/],
  ] as const;

  for (const [intent, screen, speech] of cases) {
    const reply = await ask(
      envelope({ type: 'IntentRequest', intent: { name: intent, slots: {} } }, `user-tv-${screen}`),
    );

    assert.match(reply.response.outputSpeech?.text ?? '', speech);
    assert.deepEqual(await drain(TV_DEVICE_ID), { type: 'openScreen', screen });
  }
});

test('a spoken pause and resume move the TV, not the Echo stream', async () => {
  const paused = await ask(
    envelope({ type: 'IntentRequest', intent: { name: 'PauseTvIntent', slots: {} } }, 'user-tv-pause'),
  );
  assert.match(paused.response.outputSpeech?.text ?? '', /Pausing the TV/);
  // AMAZON.PauseIntent owns the skill's own stream; this intent must not.
  assert.deepEqual(paused.response.directives, undefined);
  assert.deepEqual(await drain(TV_DEVICE_ID), { type: 'player.pause' });

  const resumed = await ask(
    envelope({ type: 'IntentRequest', intent: { name: 'ResumeTvIntent', slots: {} } }, 'user-tv-resume'),
  );
  assert.match(resumed.response.outputSpeech?.text ?? '', /Resuming the TV/);
  assert.deepEqual(await drain(TV_DEVICE_ID), { type: 'player.resume' });
});

test('an openScreen for a screen that does not exist is refused instead of queued', async () => {
  const refused = await app.inject({
    method: 'POST',
    url: '/v1/tv/commands',
    headers: { 'x-device-id': '55555555-5555-4555-8555-555555555555' },
    payload: { type: 'openScreen', screen: 'somewhere' },
  });

  assert.equal(refused.statusCode, 400);
  assert.match(
    (refused.json() as { error: string }).error,
    /welcome, quests, learn, focus, settings, wardrobe/,
  );
});

test('a raw key press is not a command the relay will queue', async () => {
  // The union deliberately has no `key` member: a queued relative press would
  // move focus from wherever the viewer has since parked it.
  const refused = await app.inject({
    method: 'POST',
    url: '/v1/tv/commands',
    headers: { 'x-device-id': '66666666-6666-4666-8666-666666666666' },
    payload: { type: 'key', key: 'KEY_DOWN' },
  });

  assert.equal(refused.statusCode, 400);
});

test('a spoken show title opens that show on the paired television', async () => {
  const reply = await ask(
    envelope(
      {
        type: 'IntentRequest',
        intent: { name: 'OpenPlayerIntent', slots: { feed: { value: 'forest hour' } } },
      },
      'user-tv-open',
    ),
  );

  assert.match(reply.response.outputSpeech?.text ?? '', /Opening Forest Hour on the TV/);
  const command = (await drain(TV_DEVICE_ID)) as {
    type: string;
    feedId: number;
    feed: { title: string };
  };
  assert.equal(command.type, 'openFeed');
  assert.equal(command.feedId, 7);
  assert.equal(command.feed.title, 'Forest Hour');
});

test('openFeed resolves the show before queueing it', async () => {
  const alexaDeviceId = '33333333-3333-4333-8333-333333333333';
  const queued = await app.inject({
    method: 'POST',
    url: '/v1/tv/commands',
    headers: { 'x-device-id': alexaDeviceId },
    payload: { type: 'openFeed', feedId: 7 },
  });

  assert.equal(queued.statusCode, 200);
  const body = queued.json() as {
    command: { type: string; feedId: number; feed: { title: string } };
  };
  assert.equal(body.command.type, 'openFeed');
  assert.equal(body.command.feedId, 7);
  assert.equal(body.command.feed.title, 'Forest Hour');
  assert.deepEqual(await drain(TV_DEVICE_ID), body.command);
});

test('an unknown feed is refused instead of queued', async () => {
  const alexaDeviceId = '44444444-4444-4444-8444-444444444444';
  const refused = await app.inject({
    method: 'POST',
    url: '/v1/tv/commands',
    headers: { 'x-device-id': alexaDeviceId },
    payload: { type: 'openFeed', feedId: 404 },
  });

  assert.equal(refused.statusCode, 404);
  assert.match((refused.json() as { error: string }).error, /No show with that feed id/);
});

// --- Pairing ---------------------------------------------------------------
//
// The phrase the TV prints is "pair my TV" with no code, and the code only
// exists once the skill asks for it. These three turns are the whole loop: the
// question, the digits, and what happens when there is no TV yet. The old
// behaviour failed each of them - no codeless sample, no question, and a reply
// that ended the session so the follow-up left the skill.

test('a codeless "pair my TV" asks for the six digits and keeps the session open', async () => {
  const reply = await ask(
    envelope({ type: 'IntentRequest', intent: { name: 'PairTvIntent', slots: {} } }, 'user-pair-ask'),
  );

  assert.match(reply.response.outputSpeech?.text ?? '', /six digits/);
  assert.match(reply.response.reprompt?.outputSpeech?.text ?? '', /six digits/);
  assert.equal(reply.response.shouldEndSession, false);
  // Without this flag the next sentence - six words of numbers - has nothing
  // to tell it apart from an ordinary question, so it would be routed as one.
  assert.equal(reply.sessionAttributes?.globiePairPending, true);
});

test('reading the digits pairs the TV and the next search queues for it', async () => {
  const userId = 'user-pair-complete';
  const asked = await ask(
    envelope({ type: 'IntentRequest', intent: { name: 'PairTvIntent', slots: {} } }, userId),
  );

  const paired = await ask(
    envelope(
      {
        type: 'IntentRequest',
        intent: { name: 'PairTvIntent', slots: { code: { value: 'zero four seven nine five one' } } },
      },
      userId,
      {},
      asked.sessionAttributes,
    ),
  );

  assert.match(paired.response.outputSpeech?.text ?? '', /^Paired\./);
  // The confirmation keeps the session open. Ending it here handed the next
  // bare sentence to the device ("go home" was silence) or to another skill
  // ("play guess who" was a trivia skill), so the follow-up now stays here.
  assert.equal(paired.response.shouldEndSession, false);
  assert.match(paired.response.reprompt?.outputSpeech?.text ?? '', /go home, or play guess who/);

  const searched = await ask(
    envelope(
      {
        type: 'IntentRequest',
        intent: { name: 'SearchOnTvIntent', slots: { query: { value: 'forest podcasts' } } },
      },
      userId,
    ),
  );

  assert.match(searched.response.outputSpeech?.text ?? '', /Searching the TV for forest podcasts/);
  assert.deepEqual(await drain(TV_DEVICE_ID), { type: 'search', query: 'forest podcasts' });
});

test('an unpaired TV request keeps the session open for the pairing phrase', async () => {
  const userId = 'user-tv-unpaired';
  unpairedAlexaIds.add(alexaDeviceIdFor(userId));

  const reply = await ask(
    envelope(
      {
        type: 'IntentRequest',
        intent: { name: 'SearchOnTvIntent', slots: { query: { value: 'forest podcasts' } } },
      },
      userId,
    ),
  );

  assert.match(reply.response.outputSpeech?.text ?? '', /No TV is paired yet/);
  assert.match(reply.response.reprompt?.outputSpeech?.text ?? '', /pair my TV/i);
  // This is the defect: ending here closed the session, so the follow-up was no
  // longer addressed to the skill and Alexa's own device intent claimed it.
  assert.equal(reply.response.shouldEndSession, false);
});

// --- Session lock ----------------------------------------------------------
//
// While the conversation is live the skill should be the only thing the
// listener has to talk to. A model miss used to end the session, which handed
// the next sentence to the device: "tell me about trees that fix paddy soil"
// became an Alexa general-knowledge answer, "play guess who" was claimed by
// another skill, and a retried pairing phrase went nowhere. These turns pin
// the lock and the one sentence that leaves it.

test('a model miss keeps the session open and names the exit', async () => {
  const reply = await ask(
    envelope(
      { type: 'IntentRequest', intent: { name: 'AMAZON.FallbackIntent', slots: {} } },
      'user-lock-miss',
      {},
      { globieLastSubject: 'trees that fix paddy soil' },
    ),
  );

  assert.equal(reply.response.shouldEndSession, false);
  assert.match(reply.response.outputSpeech?.text ?? '', /trees that fix paddy soil/);
  assert.match(reply.response.outputSpeech?.text ?? '', /goodbye/);
  assert.match(reply.response.reprompt?.outputSpeech?.text ?? '', /goodbye/);
});

test('exit closes the session', async () => {
  const reply = await ask(
    envelope(
      { type: 'IntentRequest', intent: { name: 'ExitGlobieIntent', slots: {} } },
      'user-lock-exit',
    ),
  );

  assert.equal(reply.response.shouldEndSession, true);
  assert.match(reply.response.outputSpeech?.text ?? '', /Goodbye/);
});

test('a TV command with nothing to act on keeps the session open', async () => {
  const reply = await ask(
    envelope(
      { type: 'IntentRequest', intent: { name: 'SearchOnTvIntent', slots: {} } },
      'user-lock-tv',
    ),
  );

  assert.equal(reply.response.shouldEndSession, false);
  assert.match(reply.response.outputSpeech?.text ?? '', /What should I search the TV for/);
});
