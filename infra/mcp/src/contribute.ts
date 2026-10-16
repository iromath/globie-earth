// The photo-contribution route: a visitor's photographs in, a verdict out.
//
// A species page may hold no photograph, and the visitor standing in front of
// the plant has one. This route is where that photograph is offered. It sits
// beside /route and /voice/* rather than on the MCP surface because it is a
// browser form, not a tool call: the page posts the images, and this server -
// which holds both the vision key and the storage key - does everything the
// page cannot do safely.
//
// Four things happen here, in one order that cannot be reordered:
//
//   1. Globie's vision model reads the photographs before anything is written.
//      It is told the species by its scientific name and family as well as its
//      local name, and each photo arrives labelled with the organ it shows
//      (the whole habit, a leaf, a flower, a fruit, ...). It answers one strict
//      JSON object rating the set safe/unsafe and giving EACH PHOTO its own
//      identity verdict - match / unsure / mismatch - not a bare yes/no. A
//      single leaf can be a thistle or it can be Acanthus; the model is allowed
//      to say "unsure, show me the flower" rather than being forced into a
//      wrong rejection.
//   2. An unsafe image is refused outright and NEVER stored - no bytes reach
//      object storage, no row reaches the database. The visitor gets a firm
//      warning saying why. This is the "strongly filter out" rule: the filter
//      is fail-closed (only an explicit safe=true passes) and it runs before
//      the write, so a harmful upload leaves no trace to clean up later.
//   3. The identity is judged per photograph, because one visitor may bundle a
//      good leaf, a good flower and a fruit that belongs to a different
//      species. A frame the model clearly contradicts is dropped here, before
//      its bytes reach storage - the wrong fruit does not ride in on the right
//      photographs. Only when NO frame matches or is merely unclear is the
//      whole submission refused and the visitor guided elsewhere.
//   4. The safe, on-subject frames are put into object storage and recorded as
//      one `pending` contribution, each frame carrying its own pending status
//      and a zeroed tally so the crowd votes on the media file (233). Accepting
//      a frame is a separate human act; the "unsure" case exists so a correct
//      photo the model is unsure about is not thrown away - it reaches a
//      steward instead.
//
// The identity is the same device credential /mcp and /route accept. The row
// is inserted through PostgREST with the caller's own X-Device-Id, so RLS -
// not this route - is the final authority on what gets written.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { chat, LlmError, providerConfigured, visionTarget, type LlmPart, type LlmProvider } from './llm.js';
import { resolveCaller } from './identity.js';
import { deletePhoto, keyForUrl, minioConfig, minioHealth, putPhoto } from './minio.js';
import { del, get, insert, PostgrestError } from './postgrest.js';

/** How long the vision model may take before the scan gives up. */
const TIMEOUT_MS = 30_000;

/**
 * The largest single media file the route will store, and the most all of them
 * may weigh together. The client downscales a photo to ~1024px before sending,
 * so MAX_IMAGE_BYTES is a backstop against a hand-built request, not the size a
 * real contribution reaches. A recorded clip is the heaviest thing a visitor
 * can send: at the sheet's ~1.2 Mbps a full 30-second take is near 4.5 MB, so
 * MAX_VIDEO_BYTES leaves headroom for a longer, denser encode.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;

/** The largest one sampled still from a clip may be. Only the first is kept, as the poster. */
const MAX_FRAME_BYTES = 1 * 1024 * 1024;

/** The most the whole request may weigh once base64 is decoded. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** How many media files (photos and clips together) one contribution may carry. */
const MAX_PHOTOS = 4;

/** How many clips one contribution may carry. The clip is the heavy one. */
const MAX_VIDEOS = 1;

/** How many stills a clip may be sampled into for the scan. Mirrors the sheet. */
const MAX_FRAMES_PER_VIDEO = 4;

/**
 * The four DNP reference universes that carry photographs. The DNP species media
 * gave the survey (`dnp_species`) a photo column and admitted it to the
 * species_type check, so a survey species page can be contributed to like the
 * other three. Mirrored in src/lib/contribute.ts (CONTRIBUTABLE_TYPES) and
 * src/lib/dnp.ts (PHOTO_TYPES); all three lists must agree.
 */
const SPECIES_TYPES = ['dnp_plant', 'dnp_fauna', 'dnp_wildlife', 'dnp_species'] as const;
type SpeciesType = (typeof SPECIES_TYPES)[number];

/**
 * The organ each photo may be labelled with. One shared set covers plants and
 * animals: `whole` is the habit or the whole body, the rest name the part.
 * Anything unrecognised is kept as `other` rather than refused.
 */
const ORGANS = ['whole', 'leaf', 'flower', 'fruit', 'bark', 'head', 'body', 'habitat', 'other'] as const;
type Organ = (typeof ORGANS)[number];

/** Whether the route can serve, and where it stores - for /health. */
export function contributeHealth(): { configured: boolean; model: string; storage: ReturnType<typeof minioHealth> } {
  const { provider, model } = visionTarget();
  const storage = minioHealth();
  return { configured: providerConfigured(provider) && storage.configured, model, storage };
}

/** The identity verdict, which replaces 220's bare `relevant` boolean. */
const VERDICTS = ['match', 'unsure', 'mismatch'] as const;
type Verdict = (typeof VERDICTS)[number];

/**
 * The identity verdict for ONE photograph. The scanner judges each frame on its
 * own so a single wrong frame is caught without condemning the right ones, and
 * `index` is the photo's 1-based position in the request - the thread that ties
 * a verdict back to a single media file.
 */
interface FrameScan {
  index: number;
  verdict: Verdict;
  subject: string;
  confidence: number | null;
  reason: string;
}

/**
 * The scan the model returns. `safe` and the per-frame verdicts are the
 * load-bearing keys: a reply without a real boolean for `safe`, or with no
 * usable per-frame and no whole-set verdict, is malformed - and a malformed
 * scan is not allowed to become an accepted upload (safe is fail-closed
 * below). `verdict`, `subject` and `reason` carry the older whole-set shape and
 * stay as a fallback so a model that answers the previous prompt is still read.
 */
interface Scan {
  safe: boolean;
  category: string;
  frames: FrameScan[];
  verdict: Verdict | null;
  subject: string;
  missingOrgans: string[];
  suggestedSpecies: string;
  confidence: number | null;
  reason: string;
}

/** The instruction the scanner answers under. Strict JSON, and nothing else. */
const SYSTEM_PROMPT = [
  'You are the safety and identity scanner behind Globie Earth, a regenerative',
  'agroforestry site in Isaan, Thailand. A visitor is offering one or more media files to',
  'illustrate ONE named species on its page. A media file is either a photograph or',
  'a short video; a video is shown to you as a few stills sampled from the clip, each',
  'labelled as a frame of that same clip. The species is given to you by its',
  'scientific name and family as well as its local and English names; the scientific',
  'name and family are the reliable identity, and a local name you do not recognise is',
  'NOT a reason to reject. Each media file is labelled with the organ it shows',
  '(whole, leaf, flower, fruit, bark, head, body, habitat, other).',
  'Judge EVERY media file ON ITS OWN. One visitor may send a good leaf, a good flower',
  'and a fruit that belongs to a different species; the wrong file must be caught',
  'without condemning the right ones, so each media file gets its own identity verdict.',
  'Answer with ONE JSON object, and nothing else - no prose, no markdown, no code',
  'fences - with exactly these keys:',
  '{"safe":boolean,"category":string,"frames":[{"index":number,"verdict":string,',
  '"subject":string,"confidence":number,"reason":string}],"missingOrgans":string[],',
  '"suggestedSpecies":string}.',
  'Set safe to false for anything pornographic, sexually explicit, nude, violent, gory,',
  'hateful, harassing, graphic, self-harming, criminal, or otherwise harmful - with no',
  'exceptions, however the image is framed or captioned. When in doubt about safety,',
  'answer safe=false.',
  'category is a short lowercase label such as "plant","animal","person","pornography",',
  '"violence","document","object" or "other".',
  'frames must hold ONE entry for EACH image you are shown, in the order the images were',
  'given, with index being that image\'s 1-based number. When several images are frames',
  'sampled from the same short video, judge them as one file and give them the same',
  'identity verdict. On each entry, verdict is about identity, not safety, and is one of',
  'exactly three words:',
  '"match" when the image is consistent with the named species, judged on the',
  'scientific name, the family and the structure you can see - not on whether the given',
  'name is familiar to you; many species are known mainly by their scientific name, and',
  'an unfamiliar name is not evidence against the image;',
  '"unsure" when the image is a plausible plant or animal of the right kind but',
  'does not yet show enough to confirm - for example a single leaf with no flower or',
  'fruit; prefer "unsure" over "mismatch" whenever the evidence is merely thin;',
  '"mismatch" ONLY when the image clearly contradicts the named species - a',
  'different family, or a plainly different kind of organism. Never answer "mismatch"',
  'merely because you would have named the image differently, and never let one',
  'mismatched image make you answer "mismatch" for the others.',
  'On each frame, subject is what that image actually shows in one short phrase,',
  'confidence is your confidence in that frame\'s verdict (a number from 0 to 1), and',
  'reason is one short sentence a visitor can read.',
  'missingOrgans lists the organs that would most help confirm the identity when a',
  'frame is "unsure" (for example ["flower","fruit"]); otherwise [].',
  'suggestedSpecies is the species the media most likely show when the verdicts',
  'are "mismatch" and you are confident, otherwise "".',
].join(' ');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A media kind a data URL may carry: a still image, or a recorded clip. */
type MediaKind = 'image' | 'video';

/** Why a media data URL was rejected: unreadable, or readable but overweight. */
type ParseFailure = 'malformed' | 'too-large';

/** A parsed data URL, or the reason it was refused. */
type ParsedDataUrl =
  | { ok: true; mime: string; buffer: Buffer }
  | { ok: false; reason: ParseFailure };

/**
 * A data:<kind>/…;base64,… URL, split into its bare mime and bytes, or the
 * reason it was refused. The media type may carry parameters - a recorder
 * produces `video/webm;codecs=vp8`, for instance - so anything after the first
 * `;` is dropped before the type is checked, and the bare `video/webm` is what
 * callers store. The mime must match `kind`; the decoded bytes must be non-empty
 * and fit `maxBytes`, so a clip cannot be smuggled in where a still is expected
 * (or vice versa), and the two failure kinds stay distinct so the caller can
 * say "too large" only when size really is the problem.
 */
function parseDataUrl(
  value: string,
  kind: MediaKind,
  maxBytes: number,
): ParsedDataUrl {
  const match = /^data:([^,]+);base64,([a-z0-9+/=]+)$/i.exec(value.trim());
  if (!match) return { ok: false, reason: 'malformed' };
  const mime = match[1].split(';')[0].trim().toLowerCase();
  if (!mime.startsWith(`${kind}/`)) return { ok: false, reason: 'malformed' };
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) return { ok: false, reason: 'malformed' };
  if (buffer.length > maxBytes) return { ok: false, reason: 'too-large' };
  return { ok: true, mime, buffer };
}

/** The file extension for a stored mime; anything unlisted is kept as .bin. */
function extensionFor(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'video/ogg') return 'ogv';
  return 'bin';
}

/**
 * One media file on its way through the route: the data URL, its organ, its
 * bytes, and the images the vision scan actually reads. A still is one image -
 * itself. A clip is stored as the clip, but scanned through its sampled stills,
 * which the browser drew from the decoded video (the container has no video
 * toolchain, and the page already holds the frames).
 */
interface IncomingMedia {
  image: string;
  organ: Organ;
  mediaType: MediaKind;
  mime: string;
  buffer: Buffer;
  /** The data URLs the model reads: [image] for a still, the sampled stills for a clip. */
  scanImages: string[];
  /**
   * The first sampled still, decoded, kept to be stored as the clip's poster so
   * a grid or a player can show a light thumbnail without loading the clip.
   */
  poster?: { mime: string; buffer: Buffer };
}

/**
 * Reads the scanner's reply, tolerant only of the wrapping the model sometimes
 * adds. The object itself must satisfy the schema, and `safe` is taken as
 * strictly true - a missing or non-boolean value fails closed. A per-frame
 * verdict the model did not return is left absent; the call site applies the
 * whole-set verdict to it, and from there "unsure". The whole-set `verdict`
 * accepts 220's older `relevant` boolean too, so a model that answers the
 * previous shape is still understood.
 */
function parseScan(content: string): Scan | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const { safe } = parsed;
  if (typeof safe !== 'boolean') return null;

  const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const asList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [];
  const asConfidence = (value: unknown): number | null =>
    typeof value === 'number' && value >= 0 && value <= 1 ? value : null;
  const asVerdict = (value: unknown): Verdict | null => {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return (VERDICTS as readonly string[]).includes(raw) ? (raw as Verdict) : null;
  };

  // The per-photo verdicts the current prompt asks for. An entry without a
  // usable index or verdict is dropped rather than guessed at.
  const frames: FrameScan[] = [];
  if (Array.isArray(parsed.frames)) {
    for (const raw of parsed.frames) {
      if (!isRecord(raw)) continue;
      const index = Number(raw.index);
      const verdict = asVerdict(raw.verdict);
      if (!Number.isInteger(index) || index < 1 || !verdict) continue;
      frames.push({
        index,
        verdict,
        subject: asText(raw.subject),
        confidence: asConfidence(raw.confidence),
        reason: asText(raw.reason),
      });
    }
  }

  // The older whole-set shape: a single `verdict`, or 220's bare `relevant`
  // boolean. The call site applies it to every photo it has no frame for.
  let verdict = asVerdict(parsed.verdict);
  if (!verdict && typeof parsed.relevant === 'boolean') {
    verdict = parsed.relevant ? 'match' : 'mismatch';
  }

  // A reply with neither per-frame verdicts nor a whole-set verdict is not a
  // usable identity answer, and an unreadable scan is refused rather than saved.
  if (frames.length === 0 && !verdict) return null;

  return {
    safe,
    category: asText(parsed.category) || 'other',
    frames,
    verdict,
    subject: asText(parsed.subject),
    missingOrgans: asList(parsed.missingOrgans).filter((organ) =>
      (ORGANS as readonly string[]).includes(organ),
    ),
    suggestedSpecies: asText(parsed.suggestedSpecies),
    confidence: asConfidence(parsed.confidence),
    reason: asText(parsed.reason),
  };
}

/** The species exactly as the page knows it - the strongest identity available. */
function speciesDossier(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const text = (field: unknown): string => (typeof field === 'string' ? field.trim().slice(0, 200) : '');
  const parts: string[] = [];
  const thai = text(record.thaiName);
  const scientific = text(record.scientificName);
  const genus = text(record.genus);
  const family = text(record.family);
  const english = text(record.englishName);
  if (thai) parts.push(`Thai name "${thai}"`);
  if (scientific) parts.push(`scientific name "${scientific}"`);
  if (genus) parts.push(`genus "${genus}"`);
  if (family) parts.push(`family "${family}"`);
  if (english) parts.push(`English name "${english}"`);
  return parts.join('; ');
}

/**
 * Runs the one vision call over the whole set of media. Each media file is
 * preceded by a text line naming it and its organ; a clip additionally labels
 * each of its sampled frames, so the model reads them as one file rather than
 * several. Returns the raw reply text, or throws on a bad call.
 */
async function scanPhotos(
  media: IncomingMedia[],
  subjectLine: string,
  provider: LlmProvider,
  model: string,
): Promise<string> {
  const parts: LlmPart[] = [{ type: 'text', text: subjectLine }];
  media.forEach((item, index) => {
    const kind = item.mediaType === 'video' ? 'a short video' : 'a photo';
    parts.push({
      type: 'text',
      text: `Media ${index + 1} of ${media.length} - ${kind} - organ: ${item.organ}`,
    });
    item.scanImages.forEach((url, frameIndex) => {
      if (item.scanImages.length > 1) {
        parts.push({
          type: 'text',
          text: `Frame ${frameIndex + 1} of ${item.scanImages.length} sampled from this video`,
        });
      }
      parts.push({ type: 'image', url });
    });
  });

  try {
    // The reply is required to be a JSON object; `json` sets response_format on
    // the DeepSeek path, which is what makes the parse below reliable rather
    // than lucky. The call site maps the failure kind back to its own wording.
    const result = await chat({
      provider,
      model,
      request: {
        system: SYSTEM_PROMPT,
        parts,
        json: true,
        temperature: 0,
      },
      timeoutMs: TIMEOUT_MS,
    });
    return result.text;
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    if (error.kind === 'upstream') {
      throw new Error(`upstream ${error.status}: ${error.detail}`.trim());
    }
    throw new Error(error.kind);
  }
}

/** The uuid shape a contribution id must have, in a path as in a body. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The columns removal reads back to learn which objects the row owns. */
interface StoredContribution {
  id: string;
  device_id: string;
  photo_key: string | null;
  photos: unknown;
}

/** One upstream message an operator can act on, from a PostgREST failure. */
function upstreamMessage(error: unknown): string {
  if (error instanceof PostgrestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every object key a contribution's stored media live under: the cover photo,
 * each frame's own key, and each clip poster walked back from its URL.
 *
 * Deduplicated, because the cover is also the first frame's key. A poster URL
 * that maps to no key is logged and skipped rather than guessed at - deleting
 * the wrong object would be worse than leaving one poster behind.
 */
function storedKeys(row: StoredContribution, log: FastifyInstance['log']): string[] {
  const keys = new Set<string>();
  if (row.photo_key) keys.add(row.photo_key);
  if (Array.isArray(row.photos)) {
    for (const frame of row.photos) {
      if (!isRecord(frame)) continue;
      if (typeof frame.key === 'string' && frame.key) keys.add(frame.key);
      if (typeof frame.poster === 'string' && frame.poster) {
        const posterKey = keyForUrl(frame.poster);
        if (posterKey) keys.add(posterKey);
        else log.warn({ poster: frame.poster }, 'contribute: a poster URL did not map to a key');
      }
    }
  }
  return [...keys];
}

export function registerContributeRoute(app: FastifyInstance): void {
  app.post('/contribute', async (request, reply) => {
    // The same identity /mcp and /route require. Without it a poster could
    // spend this server's vision key and fill its bucket anonymously.
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({
        error:
          'Contributing a photo needs a caller identity: the same X-Device-Id (or demo ' +
          'Authorization bearer) that /mcp accepts. See infra/mcp/README.md.',
      });
    }

    const body: unknown = request.body;
    if (!isRecord(body)) {
      return reply.code(400).send({ error: 'The contribution body must be a JSON object.' });
    }

    const speciesType = typeof body.speciesType === 'string' ? body.speciesType.trim() : '';
    if (!SPECIES_TYPES.includes(speciesType as SpeciesType)) {
      return reply.code(400).send({
        error: `speciesType must be one of: ${SPECIES_TYPES.join(', ')}.`,
      });
    }
    const speciesId = Number(body.speciesId);
    if (!Number.isInteger(speciesId) || speciesId <= 0) {
      return reply.code(400).send({ error: 'speciesId must be the dataset row id (a positive integer).' });
    }
    const speciesName = typeof body.speciesName === 'string' ? body.speciesName.trim().slice(0, 200) : '';

    // The second scan after the visitor has supplied the organs Globie asked
    // for. On attempt 2 an "unsure" verdict is stored for a steward instead of
    // asking again, so the loop is bounded at exactly one extra round.
    const attempt = Number(body.attempt) === 2 ? 2 : 1;

    // The media. `photos` is the shape the page sends - each entry a still, or
    // a clip when mediaType is 'video'; a bare `image` is the single-photo
    // shorthand 220 used and is still accepted.
    const rawPhotos: unknown[] = Array.isArray(body.photos)
      ? body.photos
      : typeof body.image === 'string'
        ? [{ image: body.image, organ: 'whole' }]
        : [];
    if (rawPhotos.length < 1 || rawPhotos.length > MAX_PHOTOS) {
      return reply.code(400).send({
        error: `Send between 1 and ${MAX_PHOTOS} media files.`,
      });
    }

    const media: IncomingMedia[] = [];
    let totalBytes = 0;
    let videoCount = 0;
    for (const entry of rawPhotos) {
      if (!isRecord(entry)) {
        return reply.code(400).send({ error: 'Each media file must be an object with an image and an organ.' });
      }
      const image = typeof entry.image === 'string' ? entry.image : '';
      const isVideo = entry.mediaType === 'video';
      const organRaw = typeof entry.organ === 'string' ? entry.organ.trim().toLowerCase() : '';
      const organ = (ORGANS as readonly string[]).includes(organRaw) ? (organRaw as Organ) : 'other';

      if (isVideo) {
        if (videoCount + 1 > MAX_VIDEOS) {
          return reply.code(400).send({ error: `Send at most ${MAX_VIDEOS} video per contribution.` });
        }
        const parsed = parseDataUrl(image, 'video', MAX_VIDEO_BYTES);
        if (!parsed.ok) {
          return reply.code(400).send({
            error:
              parsed.reason === 'too-large'
                ? `A video must be no larger than ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB.`
                : 'A video must be a data:video/…;base64,… URL (for example data:video/webm;base64,…).',
          });
        }
        // The clip is what gets stored; the scan reads the stills the browser
        // sampled from it. Without at least one, there is nothing to look at.
        const rawFrames = Array.isArray(entry.frames) ? entry.frames : [];
        const scanImages: string[] = [];
        let poster: { mime: string; buffer: Buffer } | undefined;
        let frameBytes = 0;
        for (const rawFrame of rawFrames.slice(0, MAX_FRAMES_PER_VIDEO)) {
          const frame = typeof rawFrame === 'string' ? parseDataUrl(rawFrame, 'image', MAX_FRAME_BYTES) : null;
          if (!frame || !frame.ok) {
            return reply.code(400).send({
              error:
                frame && frame.reason === 'too-large'
                  ? `Each video frame sample must be no larger than ${Math.round(MAX_FRAME_BYTES / (1024 * 1024))} MB.`
                  : 'Each video frame sample must be a small data:image/…;base64,… URL.',
            });
          }
          scanImages.push(rawFrame as string);
          frameBytes += frame.buffer.length;
          if (!poster) poster = frame;
        }
        if (scanImages.length === 0) {
          return reply.code(400).send({
            error: 'A video must carry at least one still frame sampled from it for the scan.',
          });
        }
        videoCount += 1;
        totalBytes += parsed.buffer.length + frameBytes;
        media.push({ image, organ, mediaType: 'video', mime: parsed.mime, buffer: parsed.buffer, scanImages, poster });
      } else {
        const parsed = parseDataUrl(image, 'image', MAX_IMAGE_BYTES);
        if (!parsed.ok) {
          return reply.code(400).send({
            error:
              parsed.reason === 'too-large'
                ? `Each photo must be no larger than ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`
                : 'Each photo must be a data:image/…;base64,… URL (for example data:image/jpeg;base64,…).',
          });
        }
        totalBytes += parsed.buffer.length;
        media.push({
          image,
          organ,
          mediaType: 'image',
          mime: parsed.mime,
          buffer: parsed.buffer,
          scanImages: [image],
        });
      }
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      return reply.code(400).send({
        error: `The upload is too large; keep the set under ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB.`,
      });
    }

    const { provider, model } = visionTarget();
    if (!providerConfigured(provider)) {
      return reply.code(503).send({
        error:
          provider === 'nova'
            ? 'Photo contributions are not configured for Nova. Set the Bedrock credentials ' +
              '(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or an AWS_BEARER_TOKEN_BEDROCK ' +
              'API key, and BEDROCK_REGION or AWS_REGION) in the MCP server environment so ' +
              'the vision scan can run.'
            : 'Photo contributions are not configured. Set DEEPSEEK_API_KEY in the MCP server ' +
              'environment so the vision scan can run.',
      });
    }
    if (!minioConfig()) {
      return reply.code(503).send({
        error:
          'Photo contributions are not configured. Set MINIO_ENDPOINT / MINIO_ACCESS_KEY / ' +
          'MINIO_SECRET_KEY so accepted photos can be stored.',
      });
    }

    // ---- 1. scan before anything is written -------------------------------
    const dossier = speciesDossier(body.species);
    const named = dossier || speciesName || `${speciesType} #${speciesId}`;
    const count = media.length;
    const subjectLine =
      `The visitor is contributing ${count} media file${count === 1 ? '' : 's'} for ONE species: ${named}. ` +
      'A media file is a photo, or a short video shown as stills sampled from it. ' +
      'Each is labelled with the organ it shows. Judge identity against the scientific ' +
      'name and family - a local name you do not recognise is not a reason to reject - and ' +
      'answer with the one JSON object described.';

    let raw: string;
    try {
      raw = await scanPhotos(media, subjectLine, provider, model);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      request.log.error({ err: error }, 'contribute: vision scan failed');
      const message =
        reason === 'timeout'
          ? `The photo scan timed out after ${TIMEOUT_MS} ms.`
          : reason === 'empty'
            ? 'The photo scan returned no verdict. Please try again.'
            : `The photo scan could not complete (${reason}). Please try again.`;
      return reply.code(502).send({ error: message });
    }

    const scan = parseScan(raw);
    if (!scan) {
      // A reply that is not the required shape cannot be trusted to say the
      // media is safe, so it is refused rather than stored. Fail closed.
      request.log.warn({ raw: raw.slice(0, 300) }, 'contribute: unparseable scan verdict');
      return reply.code(502).send({
        error: 'The photo scan returned an unreadable verdict, so the upload was not saved. Please try again.',
      });
    }

    // The model sees a flattened run of images: a still is one, a clip is its
    // sampled frames. This maps each image back to the media file it came from,
    // so a clip's frames collapse into ONE verdict for the whole clip.
    const imageOwner: number[] = [];
    media.forEach((item, mediaIndex) => {
      item.scanImages.forEach(() => imageOwner.push(mediaIndex));
    });
    const framesOf = (mediaIndex: number): FrameScan[] => {
      const group: FrameScan[] = [];
      imageOwner.forEach((owner, imageIndex) => {
        if (owner !== mediaIndex) return;
        const frame = scan.frames.find((candidate) => candidate.index === imageIndex + 1);
        if (frame) group.push(frame);
      });
      return group;
    };
    // One identity verdict per media file, in the order they were sent. Any
    // frame that matches makes the whole file a match; otherwise any unsure
    // keeps it plausible; otherwise a file the model said nothing about falls
    // back to the whole-set verdict, and from there to "unsure" - a thin answer
    // goes to a person, never to an automatic no.
    const verdicts: Verdict[] = media.map((_, mediaIndex) => {
      const group = framesOf(mediaIndex);
      if (group.some((frame) => frame.verdict === 'match')) return 'match';
      if (group.some((frame) => frame.verdict === 'unsure')) return 'unsure';
      if (group.length) return 'mismatch';
      return scan.verdict ?? 'unsure';
    });
    const hasMatch = verdicts.includes('match');
    const hasUnsure = verdicts.includes('unsure');
    // The set-level verdict reported back, worst-first so it never overstates.
    const overall: Verdict = hasMatch ? 'match' : hasUnsure ? 'unsure' : 'mismatch';
    const frameSubjects = scan.frames.map((frame) => frame.subject).filter(Boolean);
    const setSubject = scan.subject || frameSubjects.join('; ');

    // ---- 2. an unsafe photo is refused and never stored -------------------
    if (!scan.safe) {
      request.log.warn(
        { deviceId: caller.deviceId, category: scan.category },
        'contribute: blocked an unsafe upload',
      );
      return reply.send({
        status: 'blocked',
        safe: false,
        category: scan.category,
        verdict: overall,
        reason:
          scan.reason ||
          'This image was flagged as harmful or inappropriate. Please contribute a clear photo of the species only.',
        model,
      });
    }

    // ---- 3. only a set wrong in every frame is refused, and the visitor is
    //         guided ---------------------------------------------------------
    // A single mismatched frame no longer sinks the submission: only when NO
    // frame matched and none was merely unclear is the whole set refused.
    if (!hasMatch && !hasUnsure) {
      return reply.send({
        status: 'off_topic',
        safe: true,
        category: scan.category,
        verdict: 'mismatch',
        subject: setSubject,
        suggestedSpecies: scan.suggestedSpecies,
        reason:
          scan.reason ||
          'This photo does not look like the species on this page. Try a close, well-lit photo of the plant or animal itself.',
        model,
      });
    }

    // ---- 3b. "unsure" asks for the missing organs, once -------------------
    // The first thin scan is not a rejection: the visitor is told which parts
    // would settle it and is invited to add them. Only after that second look
    // does an unresolved photo go to a steward rather than back to the visitor.
    if (!hasMatch && hasUnsure && attempt < 2) {
      return reply.send({
        status: 'need_more',
        safe: true,
        category: scan.category,
        verdict: 'unsure',
        subject: setSubject,
        organsSeen: media.map((item) => item.organ),
        missingOrgans: scan.missingOrgans,
        reason:
          scan.reason ||
          'Globie cannot confirm this from the upload yet. A clearer photo of another part of the plant or animal will help.',
        model,
        attempt,
      });
    }

    // ---- 4. the media that are not plainly wrong are stored as one pending
    //         contribution ---------------------------------------------------
    // A media file the model called "mismatch" is dropped here, before its
    // bytes reach object storage: the wrong fruit does not ride in on the right
    // photographs. Each stored file carries its own pending status, its media
    // type and a zeroed tally, so the crowd votes on the media file (233).
    // Reached by a confirmed match, and by an unresolved "unsure" on the second
    // attempt - that file is safe and plausible, so it is kept for a steward.
    const kept = media
      .map((photo, index) => ({ photo, verdict: verdicts[index], frames: framesOf(index) }))
      .filter((entry) => entry.verdict !== 'mismatch');

    const stored: {
      key: string;
      url: string;
      organ: Organ;
      mediaType: MediaKind;
      contentType: string;
      byteSize: number;
      status: string;
      voteUp: number;
      voteDown: number;
      /** Set for a clip: the URL of its stored poster still. */
      poster?: string;
    }[] = [];
    try {
      for (const entry of kept) {
        const key = `contributions/${caller.deviceId}/${randomUUID()}.${extensionFor(entry.photo.mime)}`;
        const url = await putPhoto(key, entry.photo.buffer, entry.photo.mime);
        // A poster is a nicety, not load-bearing: if storing it fails, the clip
        // still plays, so the failure is logged and swallowed rather than
        // sinking an otherwise good contribution.
        let poster: string | undefined;
        if (entry.photo.poster) {
          try {
            const posterKey = `contributions/${caller.deviceId}/${randomUUID()}.${extensionFor(entry.photo.poster.mime)}`;
            poster = await putPhoto(posterKey, entry.photo.poster.buffer, entry.photo.poster.mime);
          } catch (error) {
            request.log.warn({ err: error }, 'contribute: storing a clip poster failed');
          }
        }
        stored.push({
          key,
          url,
          organ: entry.photo.organ,
          mediaType: entry.photo.mediaType,
          contentType: entry.photo.mime,
          byteSize: entry.photo.buffer.length,
          status: 'pending',
          voteUp: 0,
          voteDown: 0,
          ...(poster ? { poster } : {}),
        });
      }
    } catch (error) {
      request.log.error({ err: error }, 'contribute: storing the upload failed');
      return reply.code(502).send({
        error: 'The upload passed the scan but could not be stored. Please try again.',
      });
    }

    const primary = stored[0];
    const keptSubjects = kept
      .flatMap((entry) => entry.frames.map((frame) => frame.subject))
      .filter((value): value is string => Boolean(value));
    const acceptedVerdict: Verdict = kept.some((entry) => entry.verdict === 'match') ? 'match' : 'unsure';
    try {
      const rows = await insert<{ id: string }[]>(
        'species_contributions',
        {
          device_id: caller.deviceId,
          species_type: speciesType,
          species_id: speciesId,
          species_name: speciesName || null,
          photo_key: primary.key,
          photo_url: primary.url,
          content_type: primary.contentType,
          byte_size: primary.byteSize,
          organs: stored.map((photo) => photo.organ),
          photos: stored,
          ai_category: scan.category,
          ai_subject: keptSubjects.join('; ') || scan.subject || null,
          ai_reason: scan.reason || null,
          ai_model: model,
          ai_verdict: acceptedVerdict,
          ai_confidence: scan.confidence,
        },
        caller,
      );
      return reply.send({
        status: 'accepted',
        id: rows[0]?.id ?? null,
        photoUrl: primary.url,
        speciesType,
        speciesId,
        verdict: acceptedVerdict,
        organs: stored.map((photo) => photo.organ),
        subject: keptSubjects.join('; ') || scan.subject,
        reason: scan.reason,
        model,
        pending: true,
      });
    } catch (error) {
      // The bytes are already in the bucket; a missing row would orphan them,
      // so this is reported as a failure rather than a quiet success.
      request.log.error({ err: error }, 'contribute: recording the contribution failed');
      return reply.code(502).send({
        error: 'The photo passed the scan but could not be recorded. Please try again.',
      });
    }
  });

  /**
   * DELETE /contribute/:id - the owner withdrawing their own upload.
   *
   * A contributor uploads tentatively: a wrong species tapped by mistake, a
   * photo they would rather not have shown. The row is theirs (RLS scopes it by
   * device), and this route is the one place that turns "mine" into "gone" -
   * the bytes in object storage as well as the row, so a withdrawn photo is not
   * left publicly fetchable behind a deleted record.
   *
   * Ownership is enforced twice: this route reads the row pinned to the
   * caller's own device_id, and the final DELETE repeats the pin. RLS is the
   * real guard (species_contributions_delete, the contributions table);
   * the pins only make a wrong id read as 404 rather than as someone else's.
   *
   * The order is deliberate. The objects go first and a storage failure aborts
   * before the row is dropped, so a partial run stays retryable. Deleting the
   * row first would strand the bytes - the exact opposite of the intent.
   */
  app.delete('/contribute/:id', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({
        error:
          'Removing a contribution needs a caller identity: the same X-Device-Id (or demo ' +
          'Authorization bearer) that /contribute accepts. See infra/mcp/README.md.',
      });
    }

    const params = request.params as { id?: string };
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    if (!UUID.test(id)) {
      return reply.code(400).send({ error: 'The contribution id must be a uuid.' });
    }

    if (!minioConfig()) {
      return reply.code(503).send({
        error:
          'Photo contributions are not configured. Set MINIO_ENDPOINT / MINIO_ACCESS_KEY / ' +
          'MINIO_SECRET_KEY so stored media can be removed.',
      });
    }

    // Read back the row to learn which objects it owns. The pin on device_id is
    // not redundant with RLS: the approved-row select policy is world-readable,
    // so without it a caller could read - though never delete - another
    // device's approved upload.
    let rows: StoredContribution[];
    try {
      rows = await get<StoredContribution[]>(
        `species_contributions?id=eq.${id}&device_id=eq.${caller.deviceId}` +
          '&select=id,device_id,photo_key,photos',
        caller,
      );
    } catch (error) {
      request.log.error({ err: error }, 'contribute: loading a contribution to remove failed');
      return reply.code(502).send({
        error: `The contribution could not be read (${upstreamMessage(error)}).`,
      });
    }

    const row = rows[0];
    if (!row) {
      return reply.code(404).send({
        error: 'No contribution of yours has that id. It may already have been removed.',
      });
    }

    // Best-effort but not silent: a storage error aborts here, before the row
    // is touched, so the removal can simply be retried - deleting an object
    // twice is a no-op, so a retry finishes whatever the first attempt missed.
    const keys = storedKeys(row, request.log);
    try {
      await Promise.all(keys.map((key) => deletePhoto(key)));
    } catch (error) {
      request.log.error({ err: error, contributionId: id }, 'contribute: removing stored media failed');
      return reply.code(502).send({
        error: 'The stored media could not be removed, so the contribution was left in place. Please try again.',
      });
    }

    try {
      // The filter repeats the ownership pin. api.contribution_frame_votes and
      // api.contribution_votes reference this row ON DELETE CASCADE, so the
      // votes cast on it go with it.
      const removed = await del<{ id: string }[]>(
        'species_contributions',
        `id=eq.${id}&device_id=eq.${caller.deviceId}`,
        caller,
      );
      if (removed.length === 0) {
        return reply.code(404).send({
          error: 'No contribution of yours has that id. It may already have been removed.',
        });
      }
      request.log.info({ deviceId: caller.deviceId, contributionId: id }, 'contribute: removed an upload');
      return reply.send({ status: 'removed', id });
    } catch (error) {
      request.log.error({ err: error }, 'contribute: deleting the contribution row failed');
      return reply.code(502).send({
        error: `The contribution could not be removed (${upstreamMessage(error)}).`,
      });
    }
  });
}
