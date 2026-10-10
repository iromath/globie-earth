// The voice-ish layer: speech in, speech out.
//
// Two ways in, in order of preference. When the server has its self-hosted
// cascade configured, the browser records raw audio with MediaRecorder and the
// server transcribes it (startRecording, below); that keeps the audio off the
// browser vendor's servers. When it does not - or the browser cannot record -
// the Web Speech API is the fallback, and every entry point says which one it
// is using rather than pretending they are the same thing.
//
// Web Speech is not available everywhere (Firefox ships neither half by
// default, and recognition routes audio through the browser vendor), so the
// entry points report whether they are supported and the UI says so rather than
// failing silently. Nothing here pretends to be an Alexa wake word.

/** Minimal shapes for the Web Speech API, which lib.dom does not type. */
interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
}
interface RecognitionResultList {
  length: number;
  [index: number]: RecognitionResult;
}
interface RecognitionEvent extends Event {
  resultIndex: number;
  results: RecognitionResultList;
}
interface RecognitionErrorEvent extends Event {
  error: string;
}
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export interface VoiceSupport {
  input: boolean;
  output: boolean;
}

export function speechSupport(): VoiceSupport {
  return {
    input: typeof recognitionConstructor() === 'function',
    output: 'speechSynthesis' in window,
  };
}

export interface ListenHandlers {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

/**
 * Starts one recognition session and returns a function that stops it. Returns
 * null when the browser has no recognition, so the caller can disable the
 * control instead of offering a button that does nothing.
 */
export function startListening(handlers: ListenHandlers): (() => void) | null {
  const Constructor = recognitionConstructor();
  if (!Constructor) return null;

  const recognition = new Constructor();
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) final += text;
      else interim += text;
    }
    if (final) handlers.onTranscript(final.trim(), true);
    else if (interim) handlers.onTranscript(interim.trim(), false);
  };
  recognition.onerror = (event) => handlers.onError(describeError(event.error));
  recognition.onend = () => handlers.onEnd();

  try {
    recognition.start();
  } catch (error) {
    handlers.onError(error instanceof Error ? error.message : String(error));
    return null;
  }

  return () => {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      // Already stopped; nothing to do.
    }
  };
}

/** Reads text aloud. Returns false when the browser cannot speak. */
export function speak(
  text: string,
  handlers: { onStart?: () => void; onEnd?: () => void } = {},
): boolean {
  if (!('speechSynthesis' in window) || !text.trim()) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language || 'en-US';
  utterance.onstart = () => handlers.onStart?.();
  utterance.onend = () => handlers.onEnd?.();
  utterance.onerror = () => handlers.onEnd?.();
  window.speechSynthesis.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function describeError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The browser blocked microphone access. Allow it in the site permissions and try again.';
    case 'no-speech':
      return 'Nothing was heard. Try again.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'Recognition needs a network connection the browser could not reach.';
    default:
      return `Speech recognition reported: ${code}.`;
  }
}

/* ── Recording, for the server-side cascade ─────────────────────────────── */

/**
 * Whether this browser can record raw audio for the server to transcribe.
 * Separate from `speechSupport().input`: a browser can record without having
 * Web Speech, and vice versa, and the UI has to tell the two apart.
 */
export function recorderSupport(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/** The container formats worth asking MediaRecorder for, best first. */
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

function pickRecordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The recording could not be read.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (result) resolve(result);
      else reject(new Error('The recording could not be read.'));
    };
    reader.readAsDataURL(blob);
  });
}

/** One live recording: stop() yields a data URL, cancel() discards it. */
export interface Recorder {
  /** Stops the microphone and resolves with the recording as a data URL. */
  stop(): Promise<string>;
  /** Stops the microphone and discards the recording. */
  cancel(): void;
}

/**
 * Opens the microphone and starts recording. The caller stops it, which is why
 * this is a toggle rather than the auto-ending Web Speech session: there is no
 * silence detector here, so the listener decides when the question is finished.
 */
export async function startRecording(): Promise<Recorder> {
  if (!recorderSupport()) throw new Error('This browser cannot record audio.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickRecordingType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
    recorder.onerror = () => reject(new Error('The recording failed.'));
  });
  recorder.start();

  // The microphone stays live until every track is stopped, so releasing it is
  // part of both endings - otherwise the browser keeps showing the recording
  // indicator after the question has been sent.
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop();
  };

  return {
    async stop(): Promise<string> {
      recorder.stop();
      const blob = await stopped;
      release();
      return blobToDataUrl(blob);
    },
    cancel(): void {
      try {
        recorder.stop();
      } catch {
        // Already stopped; nothing to do.
      }
      release();
    },
  };
}
