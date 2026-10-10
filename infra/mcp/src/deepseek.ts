// The DeepSeek endpoint this server talks to, shared by the tool router and the
// photo tool.
//
// Both features call the same OpenAI-compatible chat-completions API on the same
// server-side key, so the endpoint, the model allowlist and the image check live
// here once. The router decides *which* tool to call; describe_photo hands a
// photo to the vision model. Keeping the credential here is the point: the
// browser host names a model, and never holds a key.

/** The vision model, the only one on the allowlist that accepts a photo. */
export const VISION_MODEL = 'deepseek-v4-flash-vision-exp';

export interface RouterModel {
  /** The id the upstream endpoint expects. */
  id: string;
  /** Whether the model accepts an image alongside the text. */
  vision: boolean;
}

/**
 * The models a caller may ask this server to use. `deepseek-flash` stays first
 * and stays the default (what DEEPSEEK_MODEL falls back to), so an utterance
 * with no model named behaves exactly as it did before the vision one existed.
 * A name off this list is refused rather than forwarded: the allowlist is what
 * keeps the router route from being a relay to any model on the server's key.
 * infra/mcp-client/index.html mirrors these ids in its dropdown.
 */
export const ROUTER_MODELS: readonly RouterModel[] = [
  { id: 'deepseek-flash', vision: false },
  { id: VISION_MODEL, vision: true },
];

/** A data URL this long is a mistake, not a photo; the host downscales first. */
export const MAX_IMAGE_CHARS = 4_000_000;

/** The upstream credentials, read per request so an env change needs no restart. */
export function deepseekConfig(): { baseUrl: string; model: string; apiKey: string | null } {
  return {
    baseUrl: (process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || null,
  };
}

/** The model an offered id refers to, or null when it is not offered. */
export function modelSpec(id: string): RouterModel | null {
  return ROUTER_MODELS.find((model) => model.id === id) ?? null;
}

/** Accepts a base64 data URL or an http(s) URL, bounded to the body limit. */
export function isImageInput(value: string): boolean {
  if (value.length > MAX_IMAGE_CHARS) return false;
  if (value.startsWith('data:image/')) return value.includes(';base64,');
  return /^https?:\/\//i.test(value);
}
