// Exercises the Alexa Skill (ASK) webhook at POST /alexa without Amazon in the
// loop - no signature, no skill id, no certification. It posts the same request
// envelopes a real Alexa service would and prints the spoken reply, so the
// whole voice path (envelope -> router -> MCP tool -> speech) can be checked
// locally before anything is registered in the developer console.
//
//   npm run simulate:skill                       (from infra/mcp; local server)
//   ALEXA_URL=https://mcp.globie.earth/alexa node scripts/simulate-alexa-skill.mjs
//
// It is deliberately two-mode, because /alexa behaves differently when
// signature verification is on:
//
//   verification ON  (the default, ALEXA_VERIFY_SIGNATURE unset)
//     A local caller cannot produce Amazon's RSA signature, so the script sends
//     one unsigned request and asserts the server refuses it with 401. That is
//     the proof the door is shut - /alexa must never be an open relay onto a
//     billed model key. It then says how to run the rest.
//
//   verification OFF (ALEXA_VERIFY_SIGNATURE=false, for local dev only)
//     The script walks the envelopes: LaunchRequest, the catch-all
//     AskGlobieIntent with a real query, HelpIntent, FallbackIntent (which
//     carries no utterance) and StopIntent - asserting each returns spoken text
//     and printing it.
//
// Exit 0 = the run behaved as expected, 2 = the URL is unreachable.
//
// Against production this script only ever performs the 401 check, which is the
// honest thing it can do from outside Amazon.

import { randomUUID } from 'node:crypto';

const ALEXA_URL = (process.env.ALEXA_URL ?? 'http://localhost:8080/alexa').trim();
const SKILL_ID = (process.env.ALEXA_SKILL_ID ?? '').trim() || 'amzn1.ask.skill.00000000-0000-4000-8000-000000000000';
// Fixed, so the device id the server derives from it is the same on every run
// and a listener's own deeds/adoptions stay with them between probes.
const USER_ID = (process.env.ALEXA_USER_ID ?? '').trim() || 'amzn1.ask.account.00000000-0000-4000-8000-000000000000';
// A sample the store listing and the help prompt both advertise, so a run that
// comes back empty is a real defect in the sample rather than in this script.
const PROBE_QUERY = 'trees that fix paddy soil';

/** The /health sibling of the configured /alexa URL. */
function healthUrl() {
  const url = new URL(ALEXA_URL);
  url.pathname = url.pathname.replace(/\/alexa\/?$/, '/health');
  return url;
}

function buildEnvelope(request) {
  return {
    version: '1.0',
    session: {
      new: request.type !== 'SessionEndedRequest',
      sessionId: `amzn1.echo-api.session.${randomUUID()}`,
      application: { applicationId: SKILL_ID },
      user: { userId: USER_ID },
    },
    context: {
      System: {
        application: { applicationId: SKILL_ID },
        user: { userId: USER_ID },
        device: { deviceId: `amzn1.ask.device.${randomUUID()}` },
      },
    },
    request: { requestId: `amzn1.echo-api.request.${randomUUID()}`, timestamp: new Date().toISOString(), ...request },
  };
}

function intent(name, query) {
  const slots = query ? { query: { name: 'query', value: query, confirmationStatus: 'NONE' } } : undefined;
  return { type: 'IntentRequest', intent: { name, confirmationStatus: 'NONE', ...(slots ? { slots } : {}) } };
}

/** An intent whose only slot is not `query` (the TV pair intent carries `code`). */
function intentWithSlot(name, slot, value) {
  return {
    type: 'IntentRequest',
    intent: {
      name,
      confirmationStatus: 'NONE',
      slots: { [slot]: { name: slot, value, confirmationStatus: 'NONE' } },
    },
  };
}

/** The relay routes live on the same origin as /alexa. */
function relayUrl(path, params = {}) {
  const url = new URL(ALEXA_URL);
  url.pathname = path;
  url.search = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** How the recogniser hands a spoken code to the slot: words, not digits. */
function spokenDigits(code) {
  return code
    .split('')
    .map(digit => DIGIT_WORDS[Number(digit)] ?? digit)
    .join(' ');
}

/** One POST of an envelope. Signs nothing - see the header comment. */
async function post(request) {
  const response = await fetch(ALEXA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEnvelope(request)),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

/** The spoken text of a reply, or the reason there is none. */
function speech(body) {
  const value = body?.response?.outputSpeech?.text;
  return typeof value === 'string' ? value : '';
}

let failures = 0;

console.log('Simulated Alexa Skill host - raw ASK envelopes to /alexa');
console.log(`   target  ${ALEXA_URL}`);
console.log(`   skill   ${SKILL_ID}`);

console.log('\n0. health');
let verifySignature = null;
try {
  const response = await fetch(healthUrl(), { headers: { Accept: 'application/json' } });
  const body = await response.json();
  verifySignature = body?.alexa?.verifySignature ?? null;
  console.log(`   health  ${response.status}  alexa=${JSON.stringify(body?.alexa ?? null)}`);
} catch (error) {
  console.error(`\n${ALEXA_URL} is not reachable (${error instanceof Error ? error.message : error}).`);
  console.error('Start the server first, e.g. npm run dev in infra/mcp.');
  process.exit(2);
}

if (verifySignature !== false) {
  console.log('\n1. unsigned request, with signature verification ON');
  const { status, body } = await post(intent('AskGlobieIntent', PROBE_QUERY));
  console.log(`   ← ${status}  ${JSON.stringify(body).slice(0, 200)}`);
  if (status === 401) {
    console.log('\nRefused with 401, as it must be: /alexa only answers a request Amazon signed.');
    console.log('Run the envelope walk against a local server with:');
    console.log('  ALEXA_VERIFY_SIGNATURE=false npm run dev');
    console.log('then re-run this script.');
  } else {
    failures += 1;
    console.error(`\n! expected 401 for an unsigned request, got ${status}`);
  }
} else {
  console.log('\n   verification is OFF - walking the envelopes (local dev only)');

  const steps = [
    ['1. LaunchRequest', { type: 'LaunchRequest' }, (text) => text.length > 0],
    [
      `2. AskGlobieIntent  "${PROBE_QUERY}"`,
      intent('AskGlobieIntent', PROBE_QUERY),
      (text) => text.length > 0,
    ],
    ['3. AMAZON.HelpIntent', intent('AMAZON.HelpIntent'), (text) => text.length > 0],
    // Delivered with no utterance: the model missed, so the reply must ask the
    // listener to rephrase rather than guess.
    ['4. AMAZON.FallbackIntent (no utterance)', intent('AMAZON.FallbackIntent'), (text) => text.length > 0],
    ['5. AMAZON.StopIntent', intent('AMAZON.StopIntent'), (text) => text.length > 0],
  ];

  let stopping = true;
  for (const [label, request, check] of steps) {
    console.log(`\n${label}`);
    const { status, body } = await post(request);
    const text = speech(body);
    console.log(`   ← ${status}  shouldEndSession=${body?.response?.shouldEndSession}`);
    console.log(`   🔊 ${text.slice(0, 400) || '(no speech)'}`);
    if (status !== 200 || !check(text)) {
      failures += 1;
      console.error('   ! expected a 200 with spoken text');
    }
    if (label.startsWith('5.')) stopping = body?.response?.shouldEndSession === true;
  }

  // --- The TV relay ------------------------------------------------------
  // The Skill cannot navigate the television: every directive it can send
  // only speaks or plays audio. "Search the TV for ..." therefore becomes a
  // command the Vega app polls for. This walks that path with the same
  // envelopes Alexa sends - the TV mints a code, the listener says it as
  // words, the Skill binds the identity and queues a search, and the TV
  // drains the command from the same relay.
  const TV_DEVICE_ID = randomUUID();
  const TV_QUERY = 'forest rain sounds';

  console.log('\n6. PairTvIntent - TV code spoken as words');
  const minted = await fetch(relayUrl('/v1/tv/pair'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': TV_DEVICE_ID },
    body: '{}',
  })
    .then(async response => ({ status: response.status, body: await response.json() }))
    .catch(error => ({ status: 0, body: { error: String(error) } }));
  const code = minted.body?.code;
  console.log(`   TV asks for a code  ← ${minted.status}  ${code ?? JSON.stringify(minted.body)}`);
  if (minted.status !== 200 || typeof code !== 'string') {
    failures += 1;
    console.error('   ! the TV could not mint a pairing code');
  } else {
    const spoken = spokenDigits(code);
    console.log(`   listener says "${spoken}"`);
    const { status, body } = await post(intentWithSlot('PairTvIntent', 'code', spoken));
    const text = speech(body);
    console.log(`   ← ${status}  🔊 ${text || '(no speech)'}`);
    if (status !== 200 || !/paired/i.test(text)) {
      failures += 1;
      console.error('   ! a spoken code did not pair');
    }

    console.log('\n7. SearchOnTvIntent');
    const searched = await post(intent('SearchOnTvIntent', TV_QUERY));
    const searchSpeech = speech(searched.body);
    console.log(`   ← ${searched.status}  🔊 ${searchSpeech || '(no speech)'}`);
    if (searched.status !== 200 || !new RegExp(TV_QUERY, 'i').test(searchSpeech)) {
      failures += 1;
      console.error('   ! the search was not accepted');
    }

    console.log('\n8. the TV drains the command');
    const polled = await fetch(relayUrl('/v1/tv/commands', { waitMs: '3000' }), {
      headers: { 'X-Device-Id': TV_DEVICE_ID },
    })
      .then(async response => ({ status: response.status, body: await response.json() }))
      .catch(error => ({ status: 0, body: { error: String(error) } }));
    const command = polled.body?.command;
    console.log(`   ← ${polled.status}  ${JSON.stringify(command ?? polled.body)}`);
    if (polled.status !== 200 || command?.type !== 'search' || command?.query !== TV_QUERY) {
      failures += 1;
      console.error('   ! the TV did not receive the spoken search');
    }
  }

  if (stopping) {
    console.log('\nStopIntent ended the session, as it should.');
  } else {
    failures += 1;
    console.error('\n! StopIntent did not set shouldEndSession');
  }
}

if (failures === 0) {
  console.log(
    verifySignature === false
      ? '\nThe voice path answers: envelope in, routed tool call and spoken reply out.'
      : '\nThe unverified path is closed.',
  );
} else {
  console.error(`\n${failures} check(s) failed.`);
}
process.exit(failures === 0 ? 0 : 1);
