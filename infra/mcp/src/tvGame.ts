// Guess Who, played by voice.
//
// The relay (tvCommands.ts) is one-way: a Skill posts a command, the TV polls
// for it. That is enough to open a screen, but not to play a quiz, because the
// answer key lives in the app and the Skill cannot ask for it - Alexa abandons
// a request after roughly eight seconds, and there is no inbound channel to a
// Vega process.
//
// So the screen publishes its deck while it is still showing it
// (POST /v1/tv/game/deck), and the server keeps that copy for a quarter of an
// hour. A spoken answer is then judged here, against that copy, and the
// result travels back as a whole `GameSnapshot`. The same judge serves the
// D-pad through POST /v1/tv/game/answer, which is what makes the spoken score
// and the drawn score the same number instead of two counters that agree until
// they do not.
//
// Sessions are keyed by the television, not by the Echo that spoke: a second
// paired Echo in the same room continues the game already on the screen.

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import { resolveCaller } from './identity.js';
import type { Caller } from './identity.js';
import { enqueueForTv, tvDeviceIdForAlexa } from './tvCommands.js';

export interface GameChoice {
  key: string;
  /** English, or the Latin binomial - the spelling worth reading aloud. */
  primary: string;
  secondary: string | null;
}

export interface GameDeckRound {
  roundId: string;
  answerKey: string;
  options: GameChoice[];
  clues: string[];
  hasPhoto: boolean;
  /**
   * Absolute URL of the species photo, when the publisher has one. It travels
   * with the round so every screen that draws the deck (a host television, a
   * joining one, a phone) can show the same picture the round is asking about.
   */
  image?: string | null;
}

export interface GameDeck {
  deckId: string;
  rounds: GameDeckRound[];
}

export interface GameVerdict {
  roundIndex: number;
  choice: string;
  correct: boolean;
  answerKey: string;
  answerPrimary: string;
}

export interface GameSnapshot {
  sessionId: string;
  game: 'quiz';
  index: number;
  total: number;
  score: number;
  verdict: GameVerdict | null;
  finished: boolean;
}

/** A deck is useful while the screen is on it; a stale one only misleads. */
const DECK_TTL_MS = 15 * 60_000;
/** A game nobody spoke to for this long is over. */
const SESSION_TTL_MS = 15 * 60_000;
/** The quiz is five rounds; the ceiling only stops a malformed publisher. */
export const DECK_ROUNDS_MAX = 10;
const OPTIONS = 3;
const CLUES_MAX = 3;
const TEXT_MAX = 300;
/** Species photos are CDN URLs, not prose; they routinely run past TEXT_MAX. */
const IMAGE_URL_MAX = 2048;
const ID_MAX = 120;

interface DeckEntry {
  deck: GameDeck;
  at: number;
}

interface GameSession {
  sessionId: string;
  /** Owned by this session, so a republish cannot retarget a live game. */
  deck: GameDeck;
  index: number;
  score: number;
  verdict: GameVerdict | null;
  /**
   * The round `verdict` belongs to. A retried utterance (or a D-pad press and
   * a spoken answer to the same question) must not score twice, and this is
   * the only record that the question has already been judged.
   */
  judgedRoundId: string | null;
  at: number;
}

/** Keyed by the TV device id, which is the screen the game is drawn on. */
const decks = new Map<string, DeckEntry>();
const sessions = new Map<string, GameSession>();

interface DeckLock {
  roomId: string;
  expiresAt: number;
}

/**
 * Decks a live challenge room has frozen.
 *
 * A room is judged against the copy it captured at creation, so republishing
 * mid-room would not corrupt it - but it would leave the TV showing questions
 * the room is not scoring. Refusing the publish is the honest answer. The room
 * owns the lock and its expiry; this map only remembers it for the route below,
 * which keeps the dependency one-way (challenge -> tvGame).
 */
const deckLocks = new Map<string, DeckLock>();

export function lockDeckForChallenge(tvDeviceId: string, roomId: string, expiresAt: number): void {
  deckLocks.set(tvDeviceId, { roomId, expiresAt });
}

/** Releases the lock only if it still belongs to the room that took it. */
export function unlockDeckForChallenge(tvDeviceId: string, roomId: string): void {
  if (deckLocks.get(tvDeviceId)?.roomId !== roomId) return;
  deckLocks.delete(tvDeviceId);
}

function pruneDecks(now: number): void {
  for (const [tvDeviceId, entry] of decks) {
    if (now - entry.at > DECK_TTL_MS) decks.delete(tvDeviceId);
  }
}

function pruneSessions(now: number): void {
  for (const [tvDeviceId, session] of sessions) {
    if (now - session.at > SESSION_TTL_MS) sessions.delete(tvDeviceId);
  }
}

function liveDeck(tvDeviceId: string, now: number): GameDeck | null {
  pruneDecks(now);
  return decks.get(tvDeviceId)?.deck ?? null;
}

function liveSession(tvDeviceId: string, now: number): GameSession | null {
  pruneSessions(now);
  const session = sessions.get(tvDeviceId);
  if (!session) return null;
  session.at = now;
  return session;
}

function snapshotOf(session: GameSession): GameSnapshot {
  const total = session.deck.rounds.length;
  return {
    sessionId: session.sessionId,
    game: 'quiz',
    index: session.index,
    total,
    score: session.score,
    verdict: session.verdict,
    finished: session.index >= total,
  };
}

const NUMBER_WORDS = ['one', 'two', 'three'];

/** What the listener hears in place of the photo they cannot be shown. */
function questionSpeech(deck: GameDeck, index: number): string {
  const round = deck.rounds[index];
  if (!round) return '';
  const labels = round.options.map(
    (option, position) => `${NUMBER_WORDS[position]} ${option.primary}`,
  );
  const clue = round.clues[0]?.trim() || 'Which species is it?';
  const lead = round.hasPhoto ? 'Look at the TV, or use this. ' : '';
  return (
    `Question ${index + 1} of ${deck.rounds.length}. ${lead}${clue} ` +
    `Is it ${labels[0]}, ${labels[1]}, or ${labels[2]}?`
  );
}

function verdictSpeech(verdict: GameVerdict): string {
  return verdict.correct
    ? `Correct! It is ${verdict.answerPrimary}.`
    : `Not quite. It is ${verdict.answerPrimary}.`;
}

function closingSpeech(snapshot: GameSnapshot): string {
  const perfect = snapshot.score === snapshot.total && snapshot.total > 0;
  return (
    `That is the end of the quiz. You scored ${snapshot.score} out of ${snapshot.total}.` +
    (perfect ? ' A perfect run.' : '')
  );
}

export type GameFailure = 'not_paired' | 'no_deck' | 'no_session' | 'already_answered' | 'invalid_choice';

export type GameTurn =
  | { ok: true; snapshot: GameSnapshot; speech: string; reprompt: string; finished: boolean }
  | { ok: false; reason: GameFailure };

/**
 * Compares one answer with the round at `index`.
 *
 * The one comparison in the server: the voice turn, the D-pad and a challenge
 * room all call this, so a spoken answer and a pressed one cannot disagree
 * about which option was right. Returns null when the round is not the one
 * named (a stale command) or when the choice is not on the card.
 */
export function evaluateAnswer(
  deck: GameDeck,
  index: number,
  roundId: string,
  choiceKey: string,
): GameVerdict | null {
  const round = deck.rounds[index];
  if (!round || round.roundId !== roundId) return null;
  const choice = round.options.find(option => option.key === choiceKey);
  if (!choice) return null;

  const answer = round.options.find(option => option.key === round.answerKey);
  return {
    roundIndex: index,
    choice: choiceKey,
    correct: choiceKey === round.answerKey,
    answerKey: round.answerKey,
    answerPrimary: answer?.primary ?? 'that one',
  };
}

/**
 * Judges one answer against the stored session.
 *
 * Every path goes through here - voice and D-pad - so the verdict and the
 * score are produced by the same comparison. Returns null when the round is
 * not the one on screen, which is a stale command rather than an answer.
 */
function judge(session: GameSession, roundId: string, choiceKey: string): GameVerdict | null {
  const verdict = evaluateAnswer(session.deck, session.index, roundId, choiceKey);
  if (!verdict) return null;

  if (verdict.correct && session.judgedRoundId !== roundId) session.score += 1;
  session.judgedRoundId = roundId;
  session.verdict = verdict;
  return verdict;
}

/**
 * Moves to the next question.
 *
 * `keepVerdict` is for the spoken path, where one utterance both judges the
 * round and asks the next one: the screen has to be able to show the verdict
 * for the round just answered *and* the question it is now on. The verdict
 * carries its own `roundIndex`, so it is never mistaken for the current round.
 */
function advance(session: GameSession, keepVerdict = false): void {
  session.index += 1;
  session.judgedRoundId = null;
  if (!keepVerdict) session.verdict = null;
}

/** Starts a game the listener asked for by name. */
export async function startGameForAlexa(caller: Caller): Promise<GameTurn> {
  const tvDeviceId = await tvDeviceIdForAlexa(caller);
  if (!tvDeviceId) return { ok: false, reason: 'not_paired' };

  const now = Date.now();
  const deck = liveDeck(tvDeviceId, now);
  if (!deck) {
    // Spoken from anywhere but the quiz, there is no deck yet: the screen only
    // publishes one once it is open. Open it, then let the listener say
    // "start the game" - the next turn finds the deck and deals. This is the
    // voice-only way in; without it the Skill can only ask the viewer to press
    // the tile, which is the one thing the relay exists to avoid.
    enqueueForTv(tvDeviceId, { type: 'openScreen', screen: 'guessWho' });
    return { ok: false, reason: 'no_deck' };
  }

  const session: GameSession = {
    sessionId: randomUUID(),
    deck,
    index: 0,
    score: 0,
    verdict: null,
    judgedRoundId: null,
    at: now,
  };
  sessions.set(tvDeviceId, session);

  const snapshot = snapshotOf(session);
  enqueueForTv(tvDeviceId, { type: 'game.start', snapshot });
  const question = questionSpeech(deck, 0);
  return {
    ok: true,
    snapshot,
    finished: false,
    speech: `Here is Guess Who. ${question}`,
    reprompt: question,
  };
}

/**
 * Answers the question on screen with choice 1, 2 or 3.
 *
 * The reply carries both halves of the turn - the verdict and the next
 * question - because keeping the session open only helps if one utterance can
 * finish one round. The caller decides how to reprompt it.
 */
export async function answerForAlexa(caller: Caller, optionNumber: number): Promise<GameTurn> {
  const tvDeviceId = await tvDeviceIdForAlexa(caller);
  if (!tvDeviceId) return { ok: false, reason: 'not_paired' };

  const now = Date.now();
  const session = liveSession(tvDeviceId, now);
  if (!session) return { ok: false, reason: 'no_session' };

  const round = session.deck.rounds[session.index];
  if (!round) return { ok: false, reason: 'no_session' };
  if (session.judgedRoundId === round.roundId) return { ok: false, reason: 'already_answered' };

  const option = round.options[optionNumber - 1];
  if (!option) return { ok: false, reason: 'invalid_choice' };

  const verdict = judge(session, round.roundId, option.key);
  if (!verdict) return { ok: false, reason: 'invalid_choice' };

  advance(session, true);
  const snapshot = snapshotOf(session);
  enqueueForTv(tvDeviceId, { type: 'game.answer', snapshot });

  const next = snapshot.finished ? '' : questionSpeech(session.deck, session.index);
  return {
    ok: true,
    snapshot,
    finished: snapshot.finished,
    speech: snapshot.finished
      ? `${verdictSpeech(verdict)} ${closingSpeech(snapshot)}`
      : `${verdictSpeech(verdict)} ${next}`,
    reprompt: snapshot.finished ? closingSpeech(snapshot) : next,
  };
}

/**
 * Moves past a question without scoring it.
 *
 * Also the recovery path for a round the D-pad already answered: the verdict
 * exists, the score is already right, and only the index is left behind.
 */
export async function skipForAlexa(caller: Caller): Promise<GameTurn> {
  const tvDeviceId = await tvDeviceIdForAlexa(caller);
  if (!tvDeviceId) return { ok: false, reason: 'not_paired' };

  const now = Date.now();
  const session = liveSession(tvDeviceId, now);
  if (!session) return { ok: false, reason: 'no_session' };

  advance(session);
  const snapshot = snapshotOf(session);
  enqueueForTv(tvDeviceId, { type: 'game.next', snapshot });

  const speech = snapshot.finished
    ? closingSpeech(snapshot)
    : questionSpeech(session.deck, session.index);
  return {
    ok: true,
    snapshot,
    finished: snapshot.finished,
    speech,
    reprompt: speech,
  };
}

/** Ends the game and tells the screen to stop mirroring a server score. */
export async function quitForAlexa(caller: Caller): Promise<boolean> {
  const tvDeviceId = await tvDeviceIdForAlexa(caller);
  if (!tvDeviceId) return false;
  sessions.delete(tvDeviceId);
  // The deck goes with the game. Left behind, it outlives the screen by its
  // fifteen-minute TTL, and the next "play guess who" starts a game on
  // questions no screen is showing: the quiz screen reshuffles when it mounts
  // and republishes, which deletes the session just created here.
  decks.delete(tvDeviceId);
  enqueueForTv(tvDeviceId, { type: 'game.quit' });
  return true;
}

/** Whether this Alexa identity is in the middle of a game on its TV. */
export async function gameOpenForAlexa(caller: Caller): Promise<boolean> {
  const tvDeviceId = await tvDeviceIdForAlexa(caller);
  if (!tvDeviceId) return false;
  return liveSession(tvDeviceId, Date.now()) !== null;
}

/**
 * The question already on the screen, without changing anything.
 *
 * Used by the two turns that must not advance the game: "what is the score"
 * and a reprompt after an utterance the model could not match.
 */
export async function currentGameForAlexa(caller: Caller): Promise<GameTurn> {
  const tvDeviceId = await tvDeviceIdForAlexa(caller);
  if (!tvDeviceId) return { ok: false, reason: 'not_paired' };

  const session = liveSession(tvDeviceId, Date.now());
  if (!session) return { ok: false, reason: 'no_session' };

  const snapshot = snapshotOf(session);
  const speech = snapshot.finished
    ? closingSpeech(snapshot)
    : questionSpeech(session.deck, session.index);
  return {
    ok: true,
    snapshot,
    finished: snapshot.finished,
    speech,
    reprompt: speech,
  };
}

function readText(value: unknown, max = TEXT_MAX): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function parseChoice(value: unknown, index: number): GameChoice | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const key = readText(record.key, ID_MAX);
  const primary = readText(record.primary);
  if (!key || !primary) return null;
  return {
    key,
    primary,
    secondary: readText(record.secondary) ?? null,
  };
}

/**
 * One round, as a publisher sends it.
 *
 * Exported because a challenge room freezes the same shape the screen already
 * publishes: one parser means a malformed round is refused identically by
 * both routes.
 */
export function parseGameRound(value: unknown): GameDeckRound | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const roundId = readText(record.roundId, ID_MAX);
  const answerKey = readText(record.answerKey, ID_MAX);
  if (!roundId || !answerKey) return null;
  if (!Array.isArray(record.options) || record.options.length !== OPTIONS) return null;

  const options: GameChoice[] = [];
  for (let index = 0; index < OPTIONS; index += 1) {
    const choice = parseChoice(record.options[index], index);
    if (!choice) return null;
    if (options.some(option => option.key === choice.key)) return null;
    options.push(choice);
  }
  if (!options.some(option => option.key === answerKey)) return null;

  const rawClues = Array.isArray(record.clues) ? record.clues : [];
  const clues = rawClues
    .map(clue => readText(clue))
    .filter((clue): clue is string => clue !== null)
    .slice(0, CLUES_MAX);

  const image = readText(record.image, IMAGE_URL_MAX);

  return {
    roundId,
    answerKey,
    options,
    clues,
    hasPhoto: record.hasPhoto === true,
    ...(image ? { image } : {}),
  };
}

export function registerTvGameRoutes(app: FastifyInstance): void {
  // --- The screen hands over the questions it is showing ------------------
  app.post('/v1/tv/game/deck', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Publishing a deck needs a caller identity.' });
    }

    const lock = deckLocks.get(caller.deviceId);
    if (lock && lock.expiresAt > Date.now()) {
      return reply.code(409).send({
        error: 'A challenge is live on this television; its deck is frozen.',
        code: 'deck_locked',
        roomId: lock.roomId,
      });
    }
    if (lock) deckLocks.delete(caller.deviceId);

    const body = (request.body ?? {}) as { deckId?: unknown; rounds?: unknown };
    const deckId = readText(body.deckId, ID_MAX);
    if (!deckId) return reply.code(400).send({ error: 'A deck needs a deckId.' });
    if (!Array.isArray(body.rounds) || body.rounds.length < 1 || body.rounds.length > DECK_ROUNDS_MAX) {
      return reply
        .code(400)
        .send({ error: `A deck needs 1 to ${DECK_ROUNDS_MAX} rounds.` });
    }

    const rounds: GameDeckRound[] = [];
    for (const raw of body.rounds) {
      const round = parseGameRound(raw);
      if (!round) {
        return reply
          .code(400)
          .send({ error: 'Each round needs a roundId, an answerKey among three options, and clues.' });
      }
      if (rounds.some(existing => existing.roundId === round.roundId)) {
        return reply.code(400).send({ error: 'Round ids must be unique within a deck.' });
      }
      rounds.push(round);
    }

    const now = Date.now();
    pruneDecks(now);
    // A new deck is a new game: anything being played on the old one would be
    // judged against questions the screen no longer shows.
    sessions.delete(caller.deviceId);
    decks.set(caller.deviceId, { deck: { deckId, rounds }, at: now });

    return reply.send({ stored: true, deckId, rounds: rounds.length });
  });

  // --- The D-pad answers, and the server keeps the score ------------------
  app.post('/v1/tv/game/answer', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Reporting an answer needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { roundId?: unknown; choice?: unknown };
    const roundId = readText(body.roundId, ID_MAX);
    const choice = readText(body.choice, ID_MAX);
    if (!roundId || !choice) {
      return reply.code(400).send({ error: 'An answer needs a roundId and a choice.' });
    }

    const session = liveSession(caller.deviceId, Date.now());
    if (!session) return reply.send({ snapshot: null });

    // No advance here: the screen still shows the verdict until NEXT is
    // pressed, and only then does the question change.
    const verdict = judge(session, roundId, choice);
    return reply.send({ snapshot: verdict ? snapshotOf(session) : null });
  });

  // --- The D-pad moves on ------------------------------------------------
  app.post('/v1/tv/game/next', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Advancing a game needs a caller identity.' });
    }

    const session = liveSession(caller.deviceId, Date.now());
    if (!session) return reply.send({ snapshot: null });

    advance(session);
    return reply.send({ snapshot: snapshotOf(session) });
  });
}
