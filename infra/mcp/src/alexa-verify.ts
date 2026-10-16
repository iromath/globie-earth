// Amazon's request signature, checked before a single tool is called.
//
// Worth being blunt about why this file exists at all. /alexa is a public POST
// endpoint that spends a paid model call and can write adoption rows. Amazon
// requires signature verification before a Skill may be certified, and the
// house rule in router.ts is the same one: an unauthenticated front door to a
// billed model is an open relay. So every request is proved to have come from
// Alexa before it is acted on.
//
// What is checked, in Amazon's order:
//
//   1. SignatureCertChainUrl is an https URL on s3.amazonaws.com, port 443,
//      under /echo.api/. Validated *before* any fetch, because this header is
//      otherwise an SSRF primitive pointed wherever the caller likes.
//   2. The PEM chain at that URL parses, and its leaf certificate is inside its
//      own validity window and names echo-api.amazon.com. The window is exactly
//      Amazon's unless the deployment widens it - see
//      alexaCertExpiryGraceDays() for the one deployment that has to.
//   3. The Signature header is a valid RSA signature of the *raw* body bytes
//      under that leaf's public key. Amazon documents SHA-256 and that is tried
//      first, but the bucket currently signs Simulator traffic with SHA-1, so
//      both digests are accepted - see SIGNATURE_ALGORITHMS.
//   4. The request timestamp is within 150 seconds of now, so a captured
//      request cannot be replayed later.
//   5. The request names this Skill, when ALEXA_SKILL_ID is set.
//
// The chain itself is cached rather than re-fetched per utterance: a voice
// request should not pay a second round trip to S3, and Amazon rotates these
// certificates on a known schedule.

import { createHash, createVerify, X509Certificate } from 'node:crypto';

/** The only host Amazon names for a certificate chain. */
const CERT_HOST = 's3.amazonaws.com';
/** Every Amazon certificate lives under this path. */
const CERT_PATH_PREFIX = '/echo.api/';
/**
 * The name the leaf certificate must carry in its subjectAltName.
 *
 * Spelled with a hyphen, unlike the S3 *path* prefix above, which is not a host
 * name at all. Every certificate Amazon has ever served from that bucket -
 * echo-api-cert-7 through echo-api-cert-12 and the older echo-api-cert.pem -
 * carries exactly this, and nothing else, in its SAN.
 */
const SAN_HOST = 'echo-api.amazon.com';
/** How long a fetched chain is reused. Amazon rotates well inside this. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** The replay window Amazon documents. */
const MAX_SKEW_MS = 150_000;
/** A certificate fetch that hangs must not hold an utterance open. */
const FETCH_TIMEOUT_MS = 5_000;
/**
 * The digest algorithms an Amazon signature may use, most modern first.
 *
 * Amazon's own documentation names RSA-SHA256, and SHA-256 is tried first for
 * that reason. SHA-1 is kept as a fallback because the certificates currently
 * served from the echo.api bucket do not always honour that: a live Simulator
 * request signed under echo-api-cert-USAmazon-prod-30584302 verifies only as
 * RSA-SHA1, and a verifier that offers SHA-256 alone refuses every genuine
 * utterance. Accepting both is not a weakening - the signature still has to
 * verify, as an RSA signature over the exact raw body bytes, under Amazon's own
 * leaf certificate; the list only decides which hash the caller may have used.
 */
const SIGNATURE_ALGORITHMS = ['RSA-SHA256', 'RSA-SHA1'] as const;

const cache = new Map<string, { chain: string; fetchedAt: number }>();

/**
 * Whether requests are verified at all.
 *
 * Off is a local-development affordance and nothing else: Amazon's signature
 * cannot be produced off Amazon's servers, so the only way to exercise the
 * adapter end to end on a laptop is to switch this off deliberately. It is on
 * unless explicitly set to "false", so the deployed default is the safe one.
 */
export function alexaVerificationEnabled(): boolean {
  return (process.env.ALEXA_VERIFY_SIGNATURE ?? 'true').trim().toLowerCase() !== 'false';
}

/** The Skill id every request must name, when one is configured. */
export function alexaSkillId(): string | null {
  return process.env.ALEXA_SKILL_ID?.trim() || null;
}

/**
 * Days a certificate may outlive its own notAfter and still be accepted, or 0.
 *
 * Zero is Amazon's rule and the default. It is widened only where the clock and
 * the certificate bucket disagree by years: every certificate the echo.api
 * bucket serves carries notAfter on or before 2023-12-23 (the newest is
 * echo-api-cert-12), while this host and Alexa itself both time-stamp requests
 * in 2026. Under a strict window every genuine request is refused here, before
 * the signature is even looked at, and the Skill can only ever answer
 * SKILL_ENDPOINT_ERROR.
 *
 * Widening it does not weaken what actually authenticates a caller: the
 * s3.amazonaws.com/echo.api URL, the echo-api.amazon.com name, the RSA-SHA256
 * signature over the raw body bytes, the 150 second replay window and the skill
 * id all still have to pass. It only decides how stale a *retired* Amazon
 * certificate may be before it is refused, and it is reported by /health so a
 * deployment cannot hide that it was raised.
 */
export function alexaCertExpiryGraceDays(): number {
  const days = Number.parseFloat(process.env.ALEXA_CERT_EXPIRY_GRACE_DAYS ?? '0');
  return Number.isFinite(days) && days > 0 ? days : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a refusal also copies the raw material it was decided from into the log.
 *
 * Off by default, and it exists for one reason: an Amazon request cannot be
 * replayed anywhere except Amazon, so when the signature does not verify the
 * only way to tell a body that was altered in transit from a header that was
 * altered in transit is to keep both and check them offline. The body is copied
 * only when it carries no token, so the switch cannot put a linked account's
 * credentials in a log.
 */
export function alexaDebugDump(): boolean {
  return (process.env.ALEXA_DEBUG_DUMP ?? 'false').trim().toLowerCase() === 'true';
}

export interface AlexaVerificationInput {
  /** The SignatureCertChainUrl header, verbatim. */
  certChainUrl: string | undefined;
  /** The Signature header, verbatim (base64). */
  signature: string | undefined;
  /** The untouched request body - the signature is over these exact bytes. */
  rawBody: Buffer | undefined;
  /** request.timestamp from the ASK envelope, when it is present. */
  timestamp: string | undefined;
  /** The skill id in the ASK envelope (session.application.applicationId). */
  skillId: string | undefined;
  /**
   * The request headers. Never used to decide anything - only to explain a
   * refusal, because a refusal that does not say which of the three inputs
   * disagreed costs a whole deploy cycle to diagnose.
   */
  headers?: Record<string, string | string[] | undefined>;
}

export type AlexaVerification =
  | { ok: true; detail?: Record<string, unknown> }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

/** The certificate URL Amazon is allowed to name, or null when it is not one. */
function validateCertUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== CERT_HOST) return null;
  if (url.port && url.port !== '443') return null;
  if (!url.pathname.startsWith(CERT_PATH_PREFIX)) return null;
  return url;
}

/** The chain at that URL, from cache while it is fresh. */
async function fetchChain(url: URL): Promise<string> {
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.chain;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Amazon's certificate endpoint returned ${response.status} for ${key}`);
    }
    const chain = await response.text();
    cache.set(key, { chain, fetchedAt: Date.now() });
    return chain;
  } finally {
    clearTimeout(timer);
  }
}

/** Every certificate in the PEM chain Amazon serves, leaf first. */
function chainCertificates(chain: string): string[] {
  return chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

/** Whether the certificate names the host Alexa actually signs from. */
function namesEchoApi(cert: X509Certificate): boolean {
  return (cert.subjectAltName ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/^DNS:/i, '').toLowerCase())
    .includes(SAN_HOST);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function headerOf(headers: AlexaVerificationInput['headers'], name: string): string | undefined {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Everything about the raw material of a decision, minus the body itself.
 *
 * A refusal is only actionable if it says which of the three inputs disagreed -
 * the certificate, the body bytes or the signature bytes - and this deployment
 * cannot reproduce Amazon's request locally, so every check that fails carries
 * these facts into the log. The body is summarised as a length and a digest -
 * the bytes themselves are only copied when alexaDebugDump() asks for them.
 */
function facts(input: AlexaVerificationInput): Record<string, unknown> {
  const signature = input.signature ?? '';
  const body = input.rawBody ?? Buffer.alloc(0);
  const detail: Record<string, unknown> = {
    certChainUrl: input.certChainUrl,
    signatureLength: signature.length,
    signatureHasSpace: signature.includes(' '),
    signatureHasPlus: signature.includes('+'),
    signatureHasDash: signature.includes('-'),
    signatureHasUnderscore: signature.includes('_'),
    signatureHasPadding: signature.includes('='),
    // Base64 is case sensitive, so a hop that case-folded the value would keep
    // its length and its '+' while changing every byte it decodes to.
    signatureHasUppercase: /[A-Z]/.test(signature),
    signatureHasLowercase: /[a-z]/.test(signature),
    signatureDecodedBytes: Buffer.from(signature.trim().replace(/ /g, '+'), 'base64').length,
    bodyBytes: body.length,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    bodyHead: body.subarray(0, 80).toString('utf8'),
    contentLengthHeader: headerOf(input.headers, 'content-length'),
    contentTypeHeader: headerOf(input.headers, 'content-type'),
    contentEncodingHeader: headerOf(input.headers, 'content-encoding'),
    transferEncodingHeader: headerOf(input.headers, 'transfer-encoding'),
  };

  if (alexaDebugDump()) {
    // Only when the request carries no token: a dump is a diagnostic, and a
    // diagnostic must not be the thing that leaks a linked account's access
    // token into a log that gets read by hand.
    const carriesToken = /"(?:access|id|refresh)Token"\s*:\s*"[^"]+"/.test(body.toString('utf8'));
    detail.signature = signature;
    detail.bodyBase64 = carriesToken ? 'withheld: the body carries a token' : body.toString('base64');
  }

  return detail;
}

/**
 * The Signature header, as the bytes it must decode to.
 *
 * Amazon base64-encodes the signature, but a header is not guaranteed to reach
 * the process byte-identical: a hop between Alexa and here can form-decode the
 * value ('+' arriving as ' '), can drop the '=' padding, or can rewrite it as
 * base64url. All three are lossless to undo, so all three are undone, and the
 * first decoding that actually verifies wins. Undoing them is not a weakening:
 * whatever comes out of them still has to verify as an RSA-SHA256 signature of
 * the body under Amazon's own certificate.
 */
function signatureCandidates(raw: string): Buffer[] {
  const trimmed = raw.trim();
  const seen = new Set<string>();
  const candidates: Buffer[] = [];
  for (const value of [trimmed, trimmed.replace(/ /g, '+'), trimmed.replace(/-/g, '+').replace(/_/g, '/')]) {
    if (!value) continue;
    const padding = value.length % 4;
    const padded = padding ? value + '='.repeat(4 - padding) : value;
    if (seen.has(padded)) continue;
    seen.add(padded);
    candidates.push(Buffer.from(padded, 'base64'));
  }
  return candidates;
}

/**
 * The body, as the bytes Amazon signed.
 *
 * The captured buffer is the first candidate and the one that should win. The
 * second only exists because a hop that re-frames a request can leave a
 * trailing newline behind that Amazon never signed; stripping it is lossless,
 * and the result still has to verify.
 */
function bodyCandidates(rawBody: Buffer): Buffer[] {
  const candidates = [rawBody];
  let end = rawBody.length;
  while (end > 0 && [0x0a, 0x0d, 0x20, 0x09].includes(rawBody[end - 1])) end -= 1;
  if (end > 0 && end !== rawBody.length) candidates.push(rawBody.subarray(0, end));
  return candidates;
}

/**
 * Verifies one request, or says why it did not. Never throws: every failure is
 * a reason the caller turns into a 401, so a malformed header cannot take the
 * process down.
 */
export async function verifyAlexaRequest(input: AlexaVerificationInput): Promise<AlexaVerification> {
  // Built once, and only if something is actually refused.
  let detail: Record<string, unknown> | undefined;
  const refusal = (reason: string, extra?: Record<string, unknown>): AlexaVerification => ({
    ok: false,
    reason,
    detail: { ...(detail ??= facts(input)), ...extra },
  });

  const certChainUrl = input.certChainUrl?.trim();
  const signature = input.signature?.trim();
  if (!certChainUrl || !signature) {
    return refusal('the request carried no Signature / SignatureCertChainUrl header');
  }
  if (!input.rawBody?.length) {
    return refusal('the raw request body was not captured, so the signature cannot be checked');
  }

  const url = validateCertUrl(certChainUrl);
  if (!url) {
    return refusal(`SignatureCertChainUrl is not an Amazon echo.api certificate URL: ${certChainUrl}`);
  }

  let chain: string;
  try {
    chain = await fetchChain(url);
  } catch (error) {
    return refusal(`Amazon's certificate chain could not be fetched: ${describe(error)}`);
  }

  const pems = chainCertificates(chain);
  if (!pems.length) return refusal('the chain Amazon served held no certificate');

  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(pems[0]);
  } catch (error) {
    return refusal(`the certificate did not parse: ${describe(error)}`);
  }

  const now = Date.now();
  const grace = alexaCertExpiryGraceDays() * DAY_MS;
  if (now < Date.parse(leaf.validFrom) - grace || now > Date.parse(leaf.validTo) + grace) {
    return refusal('the Amazon certificate is outside its validity window');
  }
  if (!namesEchoApi(leaf)) {
    return refusal(`the certificate does not name ${SAN_HOST}`);
  }

  // The signature is over the raw bytes, not the parsed object: re-serialising
  // the JSON would change key order and whitespace and break every check.
  //
  // Leaf and body are tried in their canonical form first, so the ordinary
  // request takes the ordinary path; the remaining pairs only exist to survive a
  // hop that re-encoded one of them on the way here. The digest is tried
  // SHA-256 first and SHA-1 second, because Amazon's bucket serves requests
  // under both. Nothing is accepted on the strength of a repair alone - every
  // candidate still has to verify as an RSA signature of Amazon's body under
  // Amazon's own certificate.
  const bodies = bodyCandidates(input.rawBody);
  const signatures = signatureCandidates(signature);
  let signingCertIndex = -1;
  let signingBodyIndex = -1;
  let signingSignatureIndex = -1;
  let signingAlgorithm: string | undefined;
  let verifyError: string | undefined;
  for (let index = 0; index < pems.length && signingCertIndex < 0; index += 1) {
    let certificate: X509Certificate;
    try {
      certificate = index === 0 ? leaf : new X509Certificate(pems[index]);
    } catch {
      continue;
    }
    for (let bodyIndex = 0; bodyIndex < bodies.length && signingCertIndex < 0; bodyIndex += 1) {
      for (let signatureIndex = 0; signatureIndex < signatures.length && signingCertIndex < 0; signatureIndex += 1) {
        for (const algorithm of SIGNATURE_ALGORITHMS) {
          const verifier = createVerify(algorithm);
          verifier.update(bodies[bodyIndex]);
          verifier.end();
          try {
            if (verifier.verify(certificate.publicKey, signatures[signatureIndex])) {
              signingCertIndex = index;
              signingBodyIndex = bodyIndex;
              signingSignatureIndex = signatureIndex;
              signingAlgorithm = algorithm;
              break;
            }
          } catch (error) {
            verifyError ??= describe(error);
          }
        }
      }
    }
  }
  if (signingCertIndex < 0) {
    return refusal("the request signature did not verify against Amazon's certificate", {
      certificatesInChain: pems.length,
      signatureCandidates: signatures.length,
      bodyCandidates: bodies.length,
      verifyError,
    });
  }

  if (input.timestamp) {
    const at = Date.parse(input.timestamp);
    if (!Number.isFinite(at)) {
      return refusal(`the request timestamp is not a date: ${input.timestamp}`);
    }
    if (Math.abs(now - at) > MAX_SKEW_MS) {
      return refusal('the request timestamp is outside the 150 second window');
    }
  }

  const expected = alexaSkillId();
  if (expected && input.skillId !== expected) {
    return refusal(`the request names skill ${input.skillId ?? '(none)'}, not the configured one`);
  }

  // Silent when the ordinary path was taken. When anything had to be repaired on
  // the way in - a re-encoded signature, a stripped trailing byte, or the older
  // SHA-1 digest - say which, because that is a fact about this deployment's own
  // network worth keeping rather than a detail to rediscover later.
  if (
    signingCertIndex === 0 &&
    signingBodyIndex === 0 &&
    signingSignatureIndex === 0 &&
    signingAlgorithm === SIGNATURE_ALGORITHMS[0]
  ) {
    return { ok: true };
  }
  return {
    ok: true,
    detail: {
      signingCertIndex,
      signingBodyIndex,
      signingSignatureIndex,
      signingAlgorithm,
      certificatesInChain: pems.length,
      bodyBytes: input.rawBody.length,
      signatureLength: signature.length,
    },
  };
}
