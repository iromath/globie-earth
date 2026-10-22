// /play/<code>: the phone's half of a challenge room.
//
// A television opens a room and shows six digits; a phone opens
// /play/<digits>, types a name, and answers. It is the same bundle as the MCP
// host — one shell, no router — so this module hides the host page and drives
// the phone board instead.
//
// Two rules shape everything here:
//
//   1. The page never holds an answer key. It draws the options the room sent
//      it and learns whether *this* seat was right from its own answer
//      response, never from the state.
//   2. The server owns the clock. A press that arrives before the round opens
//      is refused with 409 not_playing; the phone keeps the tile pressed and
//      sends it again when a state says that card is playing.

interface GameChoice {
  key: string;
  primary: string;
  secondary: string | null;
}

interface PhoneQuestion {
  roundId: string;
  options: GameChoice[];
  clues: string[];
  hasPhoto: boolean;
}

interface PhonePlayer {
  slot: number;
  name: string;
  team: 0 | 1;
  score: number;
  correct: number;
  streak: number;
  answered: boolean;
}

interface ChallengeAward {
  tokens: number;
  awarded: number;
  balance: number | null;
  available: boolean;
}

interface PhoneState {
  roomId: string;
  code: string;
  phase: 'lobby' | 'playing' | 'standings' | 'finished';
  index: number;
  total: number;
  question: PhoneQuestion | null;
  endsAt: number;
  players: PhonePlayer[];
  /** Which seats are offering a camera. Off until a seat turns it on. */
  presence?: Array<{ slot: number; on: boolean; frameUrl: string | null }>;
  award: ChallengeAward | null;
}

interface Reply {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

interface AnswerResult {
  roundId: string;
  correct: boolean;
  points: number;
  late: boolean;
}

const PHASE: Record<PhoneState['phase'], string> = {
  lobby: 'Lobby',
  playing: 'Question',
  standings: 'Standings',
  finished: 'Final',
};

/* ── Where this page is ─────────────────────────────────────────────────── */

/** The room code in the address, or null when this is the MCP host page. */
export function playCode(): string | null {
  const match = /^\/play\/([0-9]{6})\/?$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

/**
 * The origin that serves the challenge routes.
 *
 * They live on the MCP server, not the PostgREST API: locally that is :8092,
 * and the live client is served from mcp-client.<domain> beside mcp.<domain>.
 * `?relay=` overrides it, which is how a phone on the LAN reaches a dev server
 * whose hostname this page cannot map.
 */
function socketBase(): string {
  const override = new URLSearchParams(window.location.search).get('relay');
  if (override) return override.replace(/\/+$/, '');

  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8092';
  if (host.startsWith('mcp-client.')) {
    return `${window.location.protocol}//mcp.${host.slice('mcp-client.'.length)}`;
  }
  if (host.startsWith('mcp.')) return window.location.origin;
  return 'https://mcp.globie.earth';
}

// The same key src/main.ts uses, so a phone is the same device to the wallet
// whether it is playing or asking the forest a question.
function deviceId(): string {
  const key = 'globie-mcp-device-id';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  window.localStorage.setItem(key, fresh);
  return fresh;
}

/* ── Elements ───────────────────────────────────────────────────────────── */

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const hostApp = requireElement('host-app');
const playApp = requireElement('play-app');
const codeLabel = requireElement<HTMLSpanElement>('play-code');
const joinPanel = requireElement('play-join');
const joinForm = requireElement<HTMLFormElement>('play-join-form');
const nameField = requireElement<HTMLInputElement>('play-name');
const joinButton = requireElement<HTMLButtonElement>('play-join-button');
const joinStatus = requireElement<HTMLParagraphElement>('play-join-status');
const roomPanel = requireElement('play-room');
const phaseLabel = requireElement<HTMLSpanElement>('play-phase');
const roundLabel = requireElement<HTMLSpanElement>('play-round');
const clockLabel = requireElement<HTMLSpanElement>('play-clock');
const roomStatus = requireElement<HTMLParagraphElement>('play-room-status');
const cameraToggle = requireElement<HTMLButtonElement>('play-camera-toggle');
const cameraPreview = requireElement<HTMLVideoElement>('play-camera-preview');
const cameraStatus = requireElement<HTMLParagraphElement>('play-camera-status');
const clueLine = requireElement<HTMLParagraphElement>('play-clue');
const tiles = requireElement<HTMLDivElement>('play-tiles');
const chip = requireElement<HTMLParagraphElement>('play-chip');
const board = requireElement<HTMLOListElement>('play-board');
const overPanel = requireElement('play-over');
const overText = requireElement<HTMLParagraphElement>('play-over-text');

/* ── State ──────────────────────────────────────────────────────────────── */

let code = '';
let base = '';
/** This seat's credential. Kept only in memory: a reload rejoins. */
let token: string | null = null;
let slot: number | null = null;
let stream: EventSource | null = null;
let room: PhoneState | null = null;
/** Which card the tiles were built for, so a repeated state does not rebuild them. */
let renderedRoundId: string | null = null;
let picked: string | null = null;
let sentRoundId: string | null = null;
let answeredRoundId: string | null = null;
let result: AnswerResult | null = null;
/** A press the server refused because the round had not opened yet. */
let hold: { roundId: string; choice: string } | null = null;
let ticker: number | null = null;

/* ── Camera (Phase D Tier 1) ────────────────────────────────────────────── */
//
// This phone may be a camera for the television. Nothing starts until the
// viewer presses the button, the stream is stopped the moment they press it
// again, and the frames are small enough to ride the same uplink as an answer.

/** The TV tile is a thumbnail; 320x180 at 5 fps is under 40 KB a frame. */
const CAPTURE_W = 320;
const CAPTURE_H = 180;
const CAPTURE_MS = 200;
/** An advisory stillness event is worth sending at most this often. */
const STILL_EVENT_MS = 3_000;
/** Five refused frames in a row means the camera or the network has gone. */
const CAMERA_FAILURES_MAX = 5;
/** Stillness is measured on a thumbnail: 32x18 is plenty to see a fidget. */
const MOTION_W = 32;
const MOTION_H = 18;
/** Mean luma change below this counts as holding still. */
const STILL_DELTA = 1.5;

let cameraOn = false;
let cameraStream: MediaStream | null = null;
let cameraTimer: number | null = null;
let cameraCanvas: HTMLCanvasElement | null = null;
let motionCanvas: HTMLCanvasElement | null = null;
/** One frame in flight: a slow uplink should queue nothing, not pile up. */
let cameraBusy = false;
let cameraFailures = 0;
let stillPrev: Uint8ClampedArray | null = null;
let lastEventAt = 0;

/* ── Helpers ────────────────────────────────────────────────────────────── */

function setStatus(element: HTMLElement, text: string, kind?: 'ok' | 'err'): void {
  element.textContent = text;
  element.classList.toggle('ok', kind === 'ok');
  element.classList.toggle('err', kind === 'err');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Enough of the wire shape to render it; the server is the authority. */
function isState(value: unknown): value is PhoneState {
  if (!isRecord(value)) return false;
  if (typeof value.roomId !== 'string' || typeof value.code !== 'string') return false;
  if (!(value.phase === 'lobby' || value.phase === 'playing' || value.phase === 'standings' || value.phase === 'finished')) {
    return false;
  }
  if (!Array.isArray(value.players)) return false;
  if (!value.players.every(player => isRecord(player) && typeof player.slot === 'number' && typeof player.name === 'string')) {
    return false;
  }
  if (value.presence !== undefined && !Array.isArray(value.presence)) return false;
  if (value.question === null) return true;
  return (
    isRecord(value.question) &&
    typeof value.question.roundId === 'string' &&
    Array.isArray(value.question.options) &&
    Array.isArray(value.question.clues)
  );
}

function seat(): PhonePlayer | null {
  if (!room || slot === null) return null;
  return room.players.find(player => player.slot === slot) ?? null;
}

async function post(path: string, payload: unknown): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId() },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, body };
}

/* ── Mount ──────────────────────────────────────────────────────────────── */

export function mountPlay(roomCode: string): void {
  code = roomCode;
  base = socketBase();
  hostApp.hidden = true;
  playApp.hidden = false;
  codeLabel.textContent = code;
  document.title = `Room ${code} · Globie Earth challenge`;

  joinForm.addEventListener('submit', event => {
    event.preventDefault();
    void join();
  });
  cameraToggle.addEventListener('click', () => void toggleCamera());
  renderCamera();
}

async function join(): Promise<void> {
  const name = nameField.value.trim();
  if (!name) {
    setStatus(joinStatus, 'A name is needed — the TV shows it.', 'err');
    return;
  }

  joinButton.disabled = true;
  setStatus(joinStatus, 'Joining…');
  try {
    const reply = await post('/v1/challenge/join', { code, name });
    const body = reply.body;
    if (!reply.ok || !body || typeof body.playerToken !== 'string' || typeof body.slot !== 'number') {
      setStatus(joinStatus, refusal(reply), 'err');
      return;
    }
    token = body.playerToken;
    slot = body.slot;
    joinPanel.hidden = true;
    roomPanel.hidden = false;
    setStatus(roomStatus, 'In. Waiting for the TV to start.');
    openStream();
  } catch {
    setStatus(joinStatus, `Could not reach the game server at ${base}. Check the phone is online, then try again.`, 'err');
  } finally {
    joinButton.disabled = false;
  }
}

function refusal(reply: Reply): string {
  const reason = typeof reply.body?.code === 'string' ? reply.body.code : '';
  switch (reason) {
    case 'not_found':
      return 'No room is open with that code. Check the six digits on the TV.';
    case 'room_closed':
      return 'That challenge has already started. Ask the TV to open a new one.';
    case 'room_full':
      return 'That challenge is full — every seat is taken.';
    case 'rate_limited':
      return 'Too many tries from this phone. Wait a minute, then try again.';
    default:
      return typeof reply.body?.error === 'string'
        ? reply.body.error
        : `The room refused the join (${reply.status}).`;
  }
}

/* ── The stream ─────────────────────────────────────────────────────────── */

function openStream(): void {
  stream?.close();
  const url = new URL(`/v1/challenge/${code}/stream`, base);
  // EventSource cannot set X-Device-Id, so identity travels in the query the
  // same way the notifications stream takes it.
  url.searchParams.set('device_id', deviceId());
  stream = new EventSource(url.toString());

  stream.addEventListener('challenge.state', event => {
    const envelope = parse((event as MessageEvent<string>).data);
    if (!envelope || envelope.type !== 'challenge.state' || !isState(envelope.state)) return;
    apply(envelope.state);
  });

  stream.addEventListener('challenge.closed', event => {
    const envelope = parse((event as MessageEvent<string>).data);
    closeRoom(
      envelope?.reason === 'host_left'
        ? 'The television left the room.'
        : 'The room timed out. Ask the TV for a new code.',
    );
  });

  stream.onerror = () => {
    // CONNECTING means EventSource is retrying on its own; the server primes
    // every new stream with the round the room is actually on. CLOSED means it
    // gave up — a 404 ends the retries because there is no room to return to.
    if (!stream) return;
    if (stream.readyState === EventSource.CLOSED) {
      closeRoom('That room is no longer open.');
      return;
    }
    setStatus(roomStatus, 'Reconnecting — your seat is safe.');
  };
}

function apply(next: PhoneState): void {
  room = next;
  render();
  releaseHold(next);
}

/** Sends a held press once the server says the same card is playing. */
function releaseHold(next: PhoneState): void {
  if (!hold) return;
  const current = next.question?.roundId ?? null;
  if (next.phase === 'playing' && current === hold.roundId) {
    const { roundId, choice } = hold;
    hold = null;
    void answer(roundId, choice);
    return;
  }
  // A different card is on screen: the held press belongs to a round that has
  // gone, and sending it again would only earn stale_round.
  if (current !== hold.roundId) hold = null;
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

function render(): void {
  if (!room) return;
  const mine = seat();
  const playing = room.phase === 'playing' && room.question !== null;

  phaseLabel.textContent = PHASE[room.phase];
  roundLabel.textContent =
    room.phase === 'lobby'
      ? `${room.players.length} seated`
      : room.phase === 'finished'
        ? 'final'
        : `${Math.min(room.index + 1, room.total)} / ${room.total}`;

  clueLine.hidden = !playing;
  if (playing && room.question) {
    const clue = room.question.clues[0] ?? '';
    clueLine.textContent = room.question.hasPhoto
      ? `${clue} Look at the TV for the photo.`.trim()
      : clue;
    renderQuestion(room.question);
  } else {
    tiles.replaceChildren();
    renderedRoundId = null;
  }

  if (room.phase === 'lobby') {
    setStatus(roomStatus, mine ? 'In. Waiting for the TV to start.' : 'Waiting for the TV to start.');
  } else if (playing) {
    const answered = room.players.filter(player => player.answered).length;
    setStatus(
      roomStatus,
      `${answered} of ${room.players.length} answered${mine?.answered ? ' · yours is in' : ''}.`,
    );
  } else if (room.phase === 'standings') {
    setStatus(roomStatus, 'Scores after that question. The TV picks the next one.');
  } else {
    renderFinal();
  }

  if (playing) startTicker();
  else stopTicker();

  renderChip();
  renderBoard();
  syncCameraToRoom();
}

function renderQuestion(question: PhoneQuestion): void {
  if (renderedRoundId !== question.roundId) {
    // A fresh card: the last press, result and hold all belong to the old one.
    renderedRoundId = question.roundId;
    picked = null;
    result = null;
    sentRoundId = null;
    hold = null;
    tiles.replaceChildren();

    for (const option of question.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'play-tile';
      button.dataset.key = option.key;

      const primary = document.createElement('span');
      primary.textContent = option.primary;
      button.append(primary);
      if (option.secondary) {
        const secondary = document.createElement('span');
        secondary.className = 'second';
        secondary.textContent = option.secondary;
        button.append(secondary);
      }

      button.addEventListener('click', () => press(question.roundId, option.key));
      tiles.append(button);
    }
  }

  const locked = answeredRoundId === question.roundId || Boolean(seat()?.answered);
  for (const node of Array.from(tiles.children)) {
    const button = node as HTMLButtonElement;
    button.disabled = locked;
    button.setAttribute('aria-pressed', String(button.dataset.key === picked));
  }
}

function renderChip(): void {
  // `result` is cleared only when a new card is built, so it survives the
  // standings push that follows the last answer — the player who closed the
  // round is exactly the one who needs to read the verdict.
  if (!result) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.classList.toggle('ok', result.correct);
  chip.classList.toggle('err', !result.correct);
  chip.textContent = result.correct
    ? `Correct · +${result.points}${result.late ? ' — after the window, accuracy only' : ''}`
    : 'Not this time · +0';
}

function renderBoard(): void {
  if (!room) return;
  const ranked =
    room.phase === 'standings' || room.phase === 'finished'
      ? [...room.players].sort((left, right) => right.score - left.score)
      : [...room.players].sort((left, right) => left.slot - right.slot);

  board.replaceChildren();
  for (const player of ranked) {
    const row = document.createElement('li');
    if (player.slot === slot) row.className = 'me';

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = player.slot === slot ? `${player.name} · you` : player.name;
    row.append(who);

    if (room.phase === 'playing' && player.answered) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = '✓';
      row.append(tick);
    }

    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = room.phase === 'lobby' ? '·' : String(player.score);
    row.append(score);

    board.append(row);
  }
}

function renderFinal(): void {
  const award = room?.award;
  if (award && award.awarded > 0) {
    setStatus(roomStatus, `Challenge finished · eco tokens +${award.awarded}.`);
  } else if (award && !award.available) {
    setStatus(roomStatus, 'Challenge finished. Eco tokens are not available right now.');
  } else {
    setStatus(roomStatus, 'Challenge finished.');
  }
}

/* ── Clock ──────────────────────────────────────────────────────────────── */

function startTicker(): void {
  if (ticker !== null) return;
  ticker = window.setInterval(tick, 250);
  tick();
}

function stopTicker(): void {
  if (ticker === null) return;
  window.clearInterval(ticker);
  ticker = null;
  clockLabel.textContent = '';
}

function tick(): void {
  if (!room || room.phase !== 'playing' || room.endsAt === 0) {
    clockLabel.textContent = '';
    stopTicker();
    return;
  }
  const left = room.endsAt - Date.now();
  clockLabel.textContent = left > 0 ? `${Math.ceil(left / 1000)}s` : 'time';
}

/* ── Answering ──────────────────────────────────────────────────────────── */

function press(roundId: string, choice: string): void {
  if (!token || answeredRoundId === roundId) return;
  picked = choice;
  hold = null;
  for (const node of Array.from(tiles.children)) {
    const button = node as HTMLButtonElement;
    button.setAttribute('aria-pressed', String(button.dataset.key === choice));
  }
  void answer(roundId, choice);
}

async function answer(roundId: string, choice: string): Promise<void> {
  if (!token || sentRoundId === roundId) return;
  sentRoundId = roundId;
  setStatus(roomStatus, 'Sending your answer…');

  try {
    const reply = await post('/v1/challenge/answer', { playerToken: token, roundId, choice });
    const body = reply.body;
    if (reply.ok && body?.accepted === true) {
      answeredRoundId = roundId;
      result = {
        roundId,
        correct: body.correct === true,
        points: typeof body.points === 'number' ? body.points : 0,
        late: body.late === true,
      };
      render();
      return;
    }
    sentRoundId = null;
    refuse(reply, roundId, choice);
  } catch (error) {
    sentRoundId = null;
    setStatus(roomStatus, `Could not send that answer — ${message(error)}. Tap again.`, 'err');
  }
}

function refuse(reply: Reply, roundId: string, choice: string): void {
  const reason = typeof reply.body?.code === 'string' ? reply.body.code : '';
  switch (reason) {
    case 'not_playing':
      // Held, not scored from zero elapsed: the round has not opened. The
      // press is kept and sent again when a state says this card is playing.
      hold = { roundId, choice };
      setStatus(roomStatus, 'Holding your answer until the round opens.');
      return;
    case 'stale_round':
      picked = null;
      setStatus(roomStatus, 'That question has moved on.');
      return;
    case 'already_answered':
      answeredRoundId = roundId;
      setStatus(roomStatus, 'You have already answered this question.');
      return;
    case 'not_joined':
      closeRoom('That seat is no longer in the room.');
      return;
    case 'finished':
      setStatus(roomStatus, 'That challenge has finished.');
      return;
    case 'rate_limited':
      setStatus(roomStatus, 'Too many answers from this phone — wait a minute.', 'err');
      return;
    default:
      setStatus(
        roomStatus,
        typeof reply.body?.error === 'string'
          ? reply.body.error
          : `The answer was refused (${reply.status}).`,
        'err',
      );
  }
}

/* ── Camera (Phase D Tier 1) ────────────────────────────────────────────── */
//
// The phone is the lens and the television is the table. A frame is small,
// the server holds it for four seconds, and nothing is recorded.
// Stillness is measured here but only ever reported: the server does the
// scoring, so a phone cannot hand itself points.

async function toggleCamera(): Promise<void> {
  if (!token) {
    setStatus(cameraStatus, 'Join the room first — a camera belongs to a seat.', 'err');
    return;
  }

  cameraToggle.disabled = true;
  try {
    if (cameraOn) {
      // Local first: pressing off must close the lens even if the network is
      // slow or gone.
      stopCamera();
      renderCamera();
      setStatus(cameraStatus, 'Camera off. Nothing is being sent.');
      await setPresence(false);
      return;
    }
    if (!(await setPresence(true))) return;
    await startCamera();
  } finally {
    cameraToggle.disabled = false;
    renderCamera();
  }
}

/** Tells the room this seat's camera is on or off. */
async function setPresence(on: boolean): Promise<boolean> {
  if (!token) return false;
  try {
    const reply = await post('/v1/challenge/presence', { playerToken: token, on });
    if (reply.ok) return true;

    const reason = typeof reply.body?.code === 'string' ? reply.body.code : '';
    setStatus(
      cameraStatus,
      reason === 'finished'
        ? 'That challenge has finished, so the camera stayed off.'
        : reason === 'not_joined'
          ? 'That seat is no longer in the room.'
          : `The room refused the camera (${reply.status}).`,
      'err',
    );
    return false;
  } catch (error) {
    setStatus(cameraStatus, `Could not reach the game server — ${message(error)}.`, 'err');
    return false;
  }
}

async function startCamera(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(cameraStatus, 'This browser cannot open a camera — try Chrome or Safari over https.', 'err');
    await setPresence(false);
    return;
  }

  let media: MediaStream;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CAPTURE_W }, height: { ideal: CAPTURE_H }, frameRate: { ideal: 8, max: 12 } },
      audio: false,
    });
  } catch (error) {
    setStatus(cameraStatus, `The camera was not opened — ${message(error)}.`, 'err');
    await setPresence(false);
    return;
  }

  cameraStream = media;
  cameraPreview.srcObject = media;
  cameraPreview.hidden = false;
  await cameraPreview.play().catch(() => undefined);

  cameraOn = true;
  cameraFailures = 0;
  stillPrev = null;
  lastEventAt = 0;
  cameraTimer = window.setInterval(() => void captureFrame(), CAPTURE_MS);
  setStatus(cameraStatus, 'Live on the TV in this room. Press again to stop.');
  void captureFrame();
}

/** Closes the lens and forgets every byte of the last frame. */
function stopCamera(): void {
  if (cameraTimer !== null) {
    window.clearInterval(cameraTimer);
    cameraTimer = null;
  }
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  cameraPreview.srcObject = null;
  cameraPreview.hidden = true;
  cameraOn = false;
  cameraBusy = false;
  stillPrev = null;
}

function renderCamera(): void {
  cameraToggle.textContent = cameraOn ? 'Camera on' : 'Camera off';
  cameraToggle.setAttribute('aria-pressed', String(cameraOn));
  if (!cameraOn) cameraPreview.hidden = true;
}

/** Turns the camera off on this phone and in the room, with a reason shown. */
async function quitCamera(note: string): Promise<void> {
  stopCamera();
  renderCamera();
  setStatus(cameraStatus, note, 'err');
  await setPresence(false);
}

/** One refused frame is noise; five in a row means the link has gone. */
function noteFrameFailure(): void {
  cameraFailures += 1;
  if (cameraFailures >= CAMERA_FAILURES_MAX) {
    void quitCamera('The camera could not send frames, so it is off now.');
  }
}

async function captureFrame(): Promise<void> {
  if (!cameraOn || cameraBusy || !token || !cameraStream) return;
  if (cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

  // One frame in flight: a slow uplink should drop frames, not queue them.
  cameraBusy = true;
  try {
    if (!token) return;
    const frame = drawFrame();
    const stillness = measureStillness();
    const reply = await post('/v1/challenge/presence/frame', { playerToken: token, frame });
    if (!reply.ok) {
      refuseFrame(reply);
      return;
    }
    cameraFailures = 0;
    if (stillness !== null && cameraOn) void reportStillness(stillness);
  } catch {
    noteFrameFailure();
  } finally {
    cameraBusy = false;
  }
}

function drawFrame(): string {
  if (!cameraCanvas) {
    cameraCanvas = document.createElement('canvas');
    cameraCanvas.width = CAPTURE_W;
    cameraCanvas.height = CAPTURE_H;
  }
  const context = cameraCanvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(cameraPreview, 0, 0, CAPTURE_W, CAPTURE_H);
  const url = cameraCanvas.toDataURL('image/jpeg', 0.55);
  // The route takes bare base64, not a data URL.
  return url.slice(url.indexOf(',') + 1);
}

/**
 * How still the picture is, 0.5 (moving) to 1 (a held pose), or null while
 * there is no previous thumbnail to compare against.
 */
function measureStillness(): number | null {
  if (!motionCanvas) {
    motionCanvas = document.createElement('canvas');
    motionCanvas.width = MOTION_W;
    motionCanvas.height = MOTION_H;
  }
  const context = motionCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(cameraPreview, 0, 0, MOTION_W, MOTION_H);
  const pixels = context.getImageData(0, 0, MOTION_W, MOTION_H).data;
  const previous = stillPrev;
  stillPrev = new Uint8ClampedArray(pixels);
  if (!previous) return null;

  let delta = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const luma = 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
    const before = 0.299 * previous[index] + 0.587 * previous[index + 1] + 0.114 * previous[index + 2];
    delta += Math.abs(luma - before);
  }
  delta /= pixels.length / 4;
  if (delta > STILL_DELTA) return null;
  return 0.5 + 0.5 * (1 - delta / STILL_DELTA);
}

/**
 * Reports a held pose at most every three seconds.
 *
 * The event is advisory: it draws a badge on the TV and never moves a score.
 */
async function reportStillness(score: number): Promise<void> {
  if (!cameraOn || !token) return;
  const now = Date.now();
  if (now - lastEventAt < STILL_EVENT_MS) return;
  lastEventAt = now;
  try {
    await post('/v1/challenge/presence/event', { playerToken: token, type: 'freeze.hold', score });
  } catch {
    // A lost advisory event costs nothing; the next hold repeats it.
  }
}

function refuseFrame(reply: Reply): void {
  const reason = typeof reply.body?.code === 'string' ? reply.body.code : '';
  if (reason === 'finished') {
    void quitCamera('The challenge finished, so the camera is off.');
    return;
  }
  if (reason === 'not_joined' || reason === 'camera_off') {
    void quitCamera('The room no longer accepts this camera, so it is off.');
    return;
  }
  if (reason === 'frame_too_large' || reason === 'frame_invalid') noteFrameFailure();
  // 429 is transient: the next tick tries again.
}

/** The room is the truth about whether this seat's camera is wanted. */
function syncCameraToRoom(): void {
  if (!cameraOn || !room || slot === null) return;
  const mine = room.presence?.find(entry => entry.slot === slot);
  if (mine && !mine.on) {
    stopCamera();
    renderCamera();
    setStatus(cameraStatus, 'The room turned this camera off.');
  }
}

/* ── Closing ────────────────────────────────────────────────────────────── */

function closeRoom(text: string): void {
  stream?.close();
  stream = null;
  stopTicker();
  // The room is gone, so the lens closes with it; the server drops the frames
  // when it forgets the room.
  stopCamera();
  renderCamera();
  joinPanel.hidden = true;
  roomPanel.hidden = true;
  overPanel.hidden = false;
  const score = seat()?.score;
  overText.textContent = score === undefined ? text : `${text} Your last score was ${score}.`;
}
