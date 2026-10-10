// Species encyclopaedia context, read from Wikipedia's keyless MediaWiki API.
//
// The same honest-fetch shape as src/conditions.ts: one keyless public
// endpoint, a bounded request, and null on any failure - so a caller reports
// what it could not read rather than inventing a summary (house rule,
// AMAZON-MCP-PLAN.md 1.1). Wikipedia needs no key and, reached server-side, no
// CORS, which is exactly the Open-Meteo shape already proven here.
//
// The lookup is by scientific name (the title Wikipedia files a species under),
// with redirects followed so a synonym lands on the accepted article. Two
// things are deliberately NOT taken:
//
//   - the full article. The lead (exintro) is the encyclopaedic summary a
//     species page wants; the remainder is out of scope for a voice answer.
//   - non-free media. Wikipedia hosts freely-licensed files (Wikimedia Commons
//     and free local files) alongside non-free "fair use" ones that may only be
//     used inside the article. Only the former may be shown, so the lead image
//     is used only when its licence is provably free (see freeLicense below);
//     a file whose licence cannot be read, or names a non-free one, is refused
//     exactly as the photograph model refuses an unproven licence
//     (SPECIES-ENCYCLOPEDIA-PLAN 8). The lead image is a bonus: text always
//     stands alone when no free image is found.
//
// Wikipedia text is CC BY-SA 4.0 - attribution is not optional - so every
// result carries the licence and the canonical URL for the caller to show and
// link, and callers describe it as external reference that may be unverified,
// never as Globie's own verified record. A shown image carries its own licence,
// photographer credit and Commons file page for the same reason.
//
// The image bytes are re-hosted into object storage (minio.ts) so a species
// page serves the picture from our own origin rather than hot-linking
// Wikimedia's CDN; the key is derived from the file name, so a repeat lookup
// finds the object already there. When storage is unconfigured or the transfer
// fails, the Wikimedia thumbnail URL is returned instead - the picture is
// still shown, not dropped.

import { createHash } from 'node:crypto';
import { minioConfig, objectExists, putPhoto } from './minio.js';

/** A hung request must not pin an Alexa+ turn. */
const TIMEOUT_MS = 10000;

const API_URL = 'https://en.wikipedia.org/w/api.php';

/** The lead image is bounded to this width, so a card never pulls an original. */
const LEAD_IMAGE_PX = 1024;

/** A re-hosted image larger than this is refused rather than copied into storage. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** The free lead image, with everything a CC attribution must show. */
export interface WikiImage {
  /** Our own copy in object storage, or Wikimedia's thumbnail when it was not cached. */
  url: string;
  /** The image's own licence, e.g. "CC BY-SA 4.0". */
  license: string;
  /** The licence deed URL, so the credit can link to it. */
  licenseUrl: string | null;
  /** The photographer / rights holder, as attribution requires. */
  credit: string | null;
  /** The Wikimedia file page the image came from. */
  descriptionUrl: string | null;
}

export interface WikiSummary {
  /** The article title, after redirect resolution. */
  title: string;
  /** The plain-text lead section, with wiki markup stripped. */
  extract: string;
  /** The canonical article URL, for the required attribution link. */
  url: string;
  /** The licence the text is reused under - always shown with the text. */
  license: string;
  /** The freely-licensed lead image, or null when there is none to show. */
  image: WikiImage | null;
}

export interface WikiLookupOptions {
  /**
   * Copy the lead image into object storage and return our URL. The species
   * page sets this; a voice/machine caller leaves it off and gets Wikimedia's
   * canonical thumbnail URL without a download on the turn.
   */
  hostImage?: boolean;
}

interface WikiPage {
  title?: string;
  extract?: string;
  fullurl?: string;
  /** The lead image's file name (without the File: prefix), from piprop=name. */
  pageimage?: string;
  thumbnail?: { source?: string };
  /** Present (as an empty marker) when Wikipedia has no article for the title. */
  missing?: unknown;
}

interface WikiQueryResponse {
  query?: { pages?: Record<string, WikiPage> };
}

interface ExtMetadataValue {
  value?: string;
}

interface ImageInfo {
  descriptionurl?: string;
  extmetadata?: Record<string, ExtMetadataValue>;
}

interface ImageInfoResponse {
  query?: { pages?: Record<string, { imageinfo?: ImageInfo[] }> };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // Offline, blocked or timed out: the caller reports what it could not read.
    return null;
  }
}

/** Expands the handful of HTML entities a Wikipedia caption actually uses. */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith('#')) {
      const code = key.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    return named[key] ?? whole;
  });
}

/** An extmetadata value as readable text: entities decoded, tags stripped. */
function plainText(value: string | undefined): string {
  if (!value) return '';
  return decodeEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A value only when it is an http(s) URL, so a caption never links to nothing. */
function httpUrl(value: string | undefined): string | null {
  const text = value?.trim();
  return text && /^https?:\/\//i.test(text) ? text : null;
}

/**
 * The licence to show the image under, or null when it is not provably free.
 *
 * Wikipedia's `extmetadata` names the licence three ways - a short name
 * (`LicenseShortName`), the usage terms (`UsageTerms`) and a deed URL
 * (`LicenseUrl`) - and any one of them may be the informative one. A file is
 * accepted only when one of them names public domain, CC0, or a Creative
 * Commons licence; non-free "fair use" files and files whose licence cannot be
 * read are refused, so nothing is shown on an unproven licence.
 */
function freeLicense(shortName: string, usageTerms: string, licenseUrl: string): string | null {
  const haystack = `${shortName} ${usageTerms} ${licenseUrl}`.toLowerCase();
  if (!haystack.trim()) return null;

  // The non-commercial and no-derivatives variants are not free enough to
  // reuse here, and their names contain the "CC BY" stem the allow-list below
  // matches on, so they are refused first.
  if (/\bby-nc\b|\bby-nd\b|noncommercial|non-commercial|no derivativ/.test(haystack)) return null;

  // Public domain: the PD marks, CC0, and the public-domain dedication.
  if (/public domain|creativecommons\.org\/publicdomain|\bcc0\b|\bcc-?pdm\b|\bpd-/.test(haystack)) {
    return shortName || usageTerms || 'Public domain';
  }
  // The free Creative Commons licences only - CC BY and CC BY-SA - by deed URL
  // or by name.
  if (/creativecommons\.org\/licenses\/by(-sa)?\/|\bcc by(-sa)?\b/.test(haystack)) {
    return shortName || usageTerms || 'Creative Commons';
  }
  return null;
}

/** The `imageinfo` block for one file, or null when it could not be read. */
async function fetchImageInfo(fileName: string): Promise<ImageInfo | null> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    titles: `File:${fileName}`,
  });

  const data = await getJson<ImageInfoResponse>(`${API_URL}?${params.toString()}`);
  const pages = data?.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  return page?.imageinfo?.[0] ?? null;
}

/**
 * Copies a Wikimedia thumbnail into object storage and returns its public URL,
 * or null when storage is unconfigured or the copy fails - the caller then
 * keeps the Wikimedia URL rather than dropping the picture.
 *
 * The key is a hash of the file name, so the same image is stored once no
 * matter how often the species is looked up; the existence check makes a
 * repeat lookup cost one HEAD rather than a download and a re-upload.
 */
async function hostImage(canonicalUrl: string, fileName: string): Promise<string | null> {
  const config = minioConfig();
  if (!config) return null;

  const extension = canonicalUrl.match(/\.([a-z0-9]+)(?:$|\?)/i)?.[1]?.toLowerCase() ?? 'jpg';
  const key = `wiki-media/${createHash('sha1').update(fileName).digest('hex')}.${extension}`;

  try {
    if (await objectExists(key)) return `${config.publicUrl}/${key}`;

    const response = await fetch(canonicalUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_IMAGE_BYTES) return null;
    return await putPhoto(key, body, response.headers.get('content-type') ?? 'image/jpeg');
  } catch {
    return null;
  }
}

/**
 * The freely-licensed lead image for a page, or null when the page has none, its
 * licence is not provably free, or its metadata could not be read.
 */
async function resolveImage(page: WikiPage, options: WikiLookupOptions): Promise<WikiImage | null> {
  const fileName = page.pageimage?.trim();
  const canonicalUrl = page.thumbnail?.source?.trim();
  if (!fileName || !canonicalUrl) return null;

  const info = await fetchImageInfo(fileName);
  if (!info) return null;

  const meta = info.extmetadata ?? {};
  const license = freeLicense(
    plainText(meta.LicenseShortName?.value),
    plainText(meta.UsageTerms?.value),
    meta.LicenseUrl?.value ?? '',
  );
  if (!license) return null;

  const hosted = options.hostImage ? await hostImage(canonicalUrl, fileName) : null;
  return {
    url: hosted ?? canonicalUrl,
    license,
    licenseUrl: httpUrl(meta.LicenseUrl?.value),
    credit: plainText(meta.Artist?.value ?? meta.Credit?.value) || null,
    descriptionUrl: httpUrl(info.descriptionurl),
  };
}

/**
 * The lead-section summary for a species, or null when Wikipedia has no article
 * under that name or the lookup could not be read. The lead image is included
 * only when it is freely licensed; `hostImage` asks for the bytes to be copied
 * into object storage so the caller serves them from our own origin.
 */
export async function fetchWikiSummary(
  name: string,
  options: WikiLookupOptions = {},
): Promise<WikiSummary | null> {
  const title = name.trim();
  if (!title) return null;

  // The Action API answers one page object keyed by pageid for a single title.
  // `redirects=1` resolves a synonym, `exintro` keeps the lead, `explaintext`
  // strips markup, `inprop=url` adds the canonical URL for attribution, and
  // `pageimages` names and sizes the lead image for the free-licence check.
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    redirects: '1',
    prop: 'extracts|info|pageimages',
    exintro: '1',
    explaintext: '1',
    inprop: 'url',
    piprop: 'thumbnail|name',
    pithumbsize: String(LEAD_IMAGE_PX),
    titles: title,
  });

  const data = await getJson<WikiQueryResponse>(`${API_URL}?${params.toString()}`);
  const pages = data?.query?.pages;
  if (!pages) return null;

  const page = Object.values(pages)[0];
  // `missing` marks a title Wikipedia has no article for; an empty extract is
  // the same dead end, so both become null rather than an empty summary.
  if (!page || page.missing !== undefined) return null;
  const extract = page.extract?.trim();
  if (!extract) return null;

  const articleTitle = page.title ?? title;
  return {
    title: articleTitle,
    extract,
    url: page.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(articleTitle.replace(/ /g, '_'))}`,
    license: 'Wikipedia · CC BY-SA 4.0',
    image: await resolveImage(page, options),
  };
}
