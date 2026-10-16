// The chat/vision model behind one interface: Amazon Bedrock Nova or DeepSeek.
//
// Four surfaces ask a model to read something and answer - the tool router
// (/route), the photo tool (describe_photo), the listwise rerank behind
// search_forest_knowledge, and the photo-moderation scan behind /contribute.
// Each needs the same three things: a system prompt, an optional photo, and -
// on the router only - a tool list. They differ only in which provider serves
// them, so the request/response shapes and the dispatch live here once.
//
// Two providers:
//
//   deepseek - an OpenAI-compatible /chat/completions endpoint on a
//              server-side key (DEEPSEEK_*). The default, and the path these
//              surfaces used before Nova existed.
//   nova     - Amazon Bedrock's Amazon Nova through the Converse API, reusing
//              the same lazy BedrockRuntimeClient and env credentials the Titan
//              embedding provider already uses (embed.ts). Model ids default
//              to amazon.nova-pro-v1:0 and are overridable with NOVA_MODEL.
//
// The provider is chosen two ways. On /route the *caller* names a model from
// ROUTER_MODELS and each id carries its own provider, so one request can route
// to DeepSeek and the next to Nova. Where a model id is not the caller's to
// name (describe_photo, rerank, /contribute) an env var picks the provider -
// VISION_PROVIDER for the two vision sites and RERANK_PROVIDER for the rerank -
// both defaulting to deepseek so an unset environment behaves exactly as it did
// before Nova existed.
//
// The credential stays server-side on both paths: the browser host names a
// model at most, and never holds a key.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type ImageFormat,
  type Tool,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime';

import { deepseekConfig } from './deepseek.js';

/** Which provider serves a call. */
export type LlmProvider = 'deepseek' | 'nova';

/** The vision model, the only DeepSeek entry on the allowlist that reads a photo. */
export const VISION_MODEL = 'deepseek-v4-flash-vision-exp';

/** The Nova model a Nova-targeted call uses unless NOVA_MODEL says otherwise. */
export const DEFAULT_NOVA_MODEL = 'amazon.nova-pro-v1:0';

/** One id the router offers, tagged with the provider that serves it. */
export interface RouterModel {
  /** The id the upstream endpoint expects. */
  id: string;
  /** Which provider this id is called on. */
  provider: LlmProvider;
  /** Whether the model accepts an image alongside the text. */
  vision: boolean;
}

/**
 * The models a caller may ask this server to use. `deepseek-flash` stays first
 * and stays the default (what DEEPSEEK_MODEL falls back to), so an utterance
 * with no model named behaves exactly as it did before the vision or Nova ids
 * existed. The Nova ids are on the same list so a caller can route a request to
 * either provider per call; each id knows which one it belongs to. A name off
 * this list is refused rather than forwarded: the allowlist is what keeps the
 * router route from being a relay to any model on the server's key.
 * infra/mcp-client/index.html mirrors these ids in its dropdown.
 */
export const ROUTER_MODELS: readonly RouterModel[] = [
  { id: 'deepseek-flash', provider: 'deepseek', vision: false },
  { id: VISION_MODEL, provider: 'deepseek', vision: true },
  { id: 'amazon.nova-lite-v1:0', provider: 'nova', vision: true },
  { id: DEFAULT_NOVA_MODEL, provider: 'nova', vision: true },
];

/** A data URL this long is a mistake, not a photo; the host downscales first. */
export const MAX_IMAGE_CHARS = 4_000_000;

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

// ------------------------------------------------------------------ config ---

/**
 * Bedrock is called with credentials from the container environment.
 *
 * Running off AWS (decision D2) means no instance role can be assumed, so the
 * SDK reads the credentials from env, exactly as the Titan embedding provider
 * documents, with the region from BEDROCK_REGION or AWS_REGION. Read per
 * request, like deepseekConfig(), so an env change needs no restart.
 */
export function novaConfig(): { model: string; region: string | undefined } {
  return {
    model: process.env.NOVA_MODEL?.trim() || DEFAULT_NOVA_MODEL,
    region: process.env.BEDROCK_REGION?.trim() || process.env.AWS_REGION?.trim() || undefined,
  };
}

/** Whether the DeepSeek path has its key, for an honest 503 rather than a dead call. */
export function deepseekConfigured(): boolean {
  return deepseekConfig().apiKey !== null;
}

/**
 * Whether the Bedrock path has credentials, read from env by the SDK itself.
 *
 * Two accepted forms, so an off-AWS container can be wired either way:
 *   - the SigV4 access-key pair (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY);
 *   - a Bedrock API key carried as AWS_BEARER_TOKEN_BEDROCK - the form the
 *     Bedrock console's "API keys" page mints.
 * When the SDK sees the bearer token it selects httpBearerAuth for the
 * `bedrock` signing name on its own, so nothing here is passed to the client.
 */
function bedrockCredentials(): boolean {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK?.trim()) return true;
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim(),
  );
}

/** Whether the Nova path has a region and credentials, for the same reason. */
export function novaConfigured(): boolean {
  return Boolean(novaConfig().region && bedrockCredentials());
}

/** Whether a named provider has what it needs, so a call site can fail with a clear 503. */
export function providerConfigured(provider: LlmProvider): boolean {
  return provider === 'nova' ? novaConfigured() : deepseekConfigured();
}

/** The provider a selector env var names, defaulting to deepseek. */
function providerFromEnv(name: string): LlmProvider {
  return (process.env[name] ?? 'deepseek').trim().toLowerCase() === 'nova' ? 'nova' : 'deepseek';
}

/**
 * The provider and model for the two vision sites (describe_photo and the
 * /contribute scan), from VISION_PROVIDER. DeepSeek always uses the one vision
 * model on the allowlist; Nova uses NOVA_MODEL.
 */
export function visionTarget(): { provider: LlmProvider; model: string } {
  const provider = providerFromEnv('VISION_PROVIDER');
  return { provider, model: provider === 'nova' ? novaConfig().model : VISION_MODEL };
}

/**
 * The provider and model for the rerank, from RERANK_PROVIDER. The DeepSeek
 * model keeps DEEPSEEK_RERANK_MODEL's override; Nova uses NOVA_MODEL.
 */
export function rerankTarget(): { provider: LlmProvider; model: string } {
  const provider = providerFromEnv('RERANK_PROVIDER');
  const model =
    provider === 'nova'
      ? novaConfig().model
      : process.env.DEEPSEEK_RERANK_MODEL?.trim() || deepseekConfig().model;
  return { provider, model };
}

// ------------------------------------------------------- the neutral request ---

/** One part of the user turn: a run of text, or an image to look at. */
export type LlmPart = { type: 'text'; text: string } | { type: 'image'; url: string };

/** One tool the model may call, in provider-neutral form. */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One model call, in the shape both providers can build from. */
export interface LlmRequest {
  system: string;
  /** The user turn: text and image parts, in the order they are read. */
  parts: LlmPart[];
  /** The tools the model may call. Omitted for a plain answer. */
  tools?: LlmTool[];
  /** Ask for a JSON-object answer (the DeepSeek path sets response_format). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/** A tool call the model asked for, its arguments already parsed. */
export interface LlmToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What the model answered, in the shape every call site reads. */
export interface LlmResult {
  /** The assistant's text ('' when it only called a tool). */
  text: string;
  /** The tool the model chose, when it chose one. */
  toolCall: LlmToolCall | null;
  /** True when the model named a tool but its arguments were not readable JSON. */
  toolArgumentsUnreadable: boolean;
  /** The model that answered, for the honest `model` field on a response. */
  model: string;
  provider: LlmProvider;
}

/** Why a call failed, so a call site can word its own 503 / null / tool error. */
export type LlmFailure = 'unconfigured' | 'timeout' | 'unreachable' | 'upstream' | 'empty';

/** A model call that failed. `status` and `detail` are set for `upstream`. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmFailure,
    readonly status?: number,
    readonly detail = '',
  ) {
    super(kind);
    this.name = 'LlmError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// -------------------------------------------------------------- dispatch ----

export interface ChatOptions {
  provider: LlmProvider;
  model: string;
  request: LlmRequest;
  /** How long the model may take before the call is aborted. */
  timeoutMs: number;
}

/**
 * Runs one model call, aborting it after `timeoutMs`. The abort signal is
 * passed to both providers - the fetch on the DeepSeek path and the SDK send on
 * the Nova path - so a slow upstream fails the same way on either.
 */
export async function chat({ provider, model, request, timeoutMs }: ChatOptions): Promise<LlmResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return provider === 'nova'
      ? await novaChat(model, request, controller.signal)
      : await deepseekChat(model, request, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- deepseek ---

/** The OpenAI `content` for a set of parts: a bare string for text only, else an array. */
function openAiContent(parts: LlmPart[]): unknown {
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: part.url } },
  );
}

/**
 * The largest photo this server will fetch and inline, in raw bytes.
 *
 * MAX_IMAGE_CHARS bounds the base64 the host sends, and base64 is four thirds
 * of the bytes it encodes, so this is that same ceiling in bytes.
 */
const MAX_FETCH_BYTES = Math.floor(MAX_IMAGE_CHARS / 4) * 3;

/**
 * Rewrites an http(s) image part as a data URL, by fetching it here.
 *
 * The OpenAI-compatible endpoint is handed the URL and expected to download it
 * itself, and against the live DeepSeek endpoint it does not: it answers 400
 * "Failed to download image from …". So the server fetches the photo and inlines
 * the bytes, which is the one form both providers accept. The URL is arbitrary
 * input, so it is guarded - it shares the call's abort signal, and only an
 * image response inside the size ceiling is inlined.
 */
async function inlineImage(url: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal, redirect: 'follow' });
  } catch {
    throw new LlmError(signal.aborted ? 'timeout' : 'unreachable');
  }
  if (!response.ok) {
    throw new LlmError('upstream', response.status, 'The photo URL could not be read');
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new LlmError(
      'upstream',
      response.status,
      `The photo URL served ${contentType || 'no content type'}, not an image`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FETCH_BYTES) {
    throw new LlmError(
      'upstream',
      response.status,
      `The photo URL is larger than the ${MAX_FETCH_BYTES} byte limit`,
    );
  }
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

/** The parts with every http(s) image fetched and inlined as a data URL. */
async function inlinedParts(parts: LlmPart[], signal: AbortSignal): Promise<LlmPart[]> {
  return Promise.all(
    parts.map(async (part) =>
      part.type === 'image' && !dataUrlMime(part.url)
        ? { type: 'image' as const, url: await inlineImage(part.url, signal) }
        : part,
    ),
  );
}

async function deepseekChat(model: string, request: LlmRequest, signal: AbortSignal): Promise<LlmResult> {
  const { baseUrl, apiKey } = deepseekConfig();
  if (!apiKey) throw new LlmError('unconfigured');

  // An http(s) photo is fetched here rather than handed to the endpoint, which
  // cannot download it (see inlineImage). Text-only requests pay nothing for it.
  const parts = await inlinedParts(request.parts, signal);

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: openAiContent(parts) },
        ],
        temperature: request.temperature ?? 0,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
              tool_choice: 'auto',
            }
          : {}),
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal,
    });
  } catch {
    throw new LlmError(signal.aborted ? 'timeout' : 'unreachable');
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw new LlmError('upstream', upstream.status, detail.slice(0, 300));
  }

  const payload = (await upstream.json().catch(() => null)) as { choices?: { message?: unknown }[] } | null;
  const message = payload?.choices?.[0]?.message;
  if (!isRecord(message)) throw new LlmError('empty');

  const text = typeof message.content === 'string' ? message.content.trim() : '';
  const { toolCall, unreadable } = firstOpenAiToolCall(message.tool_calls);
  if (!text && !toolCall) throw new LlmError('empty');

  return { text, toolCall, toolArgumentsUnreadable: unreadable, model, provider: 'deepseek' };
}

/** Reads the first OpenAI tool call out of a message, tolerating an object or JSON-string argument. */
function firstOpenAiToolCall(raw: unknown): { toolCall: LlmToolCall | null; unreadable: boolean } {
  const calls = Array.isArray(raw) ? raw : [];
  const first = calls[0] as { function?: { name?: unknown; arguments?: unknown } } | undefined;
  const name = first?.function?.name;
  if (typeof name !== 'string' || !name) return { toolCall: null, unreadable: false };

  const value = first?.function?.arguments;
  if (isRecord(value)) return { toolCall: { name, arguments: value }, unreadable: false };
  if (typeof value !== 'string' || !value.trim()) return { toolCall: { name, arguments: {} }, unreadable: false };
  try {
    const parsed: unknown = JSON.parse(value);
    return { toolCall: { name, arguments: isRecord(parsed) ? parsed : {} }, unreadable: false };
  } catch {
    return { toolCall: { name, arguments: {} }, unreadable: true };
  }
}

// -------------------------------------------------------------------- nova ---

/**
 * The Bedrock client, built lazily so a health check can name the provider
 * without the region being set - the failure belongs to the one call that needs
 * it. Mirrors the Titan embedding provider's client in embed.ts.
 */
let client: BedrockRuntimeClient | null = null;

function bedrockClient(): BedrockRuntimeClient {
  return (client ??= new BedrockRuntimeClient({ region: novaConfig().region }));
}

/** The Converse image format for a mime type; anything unlisted is read as JPEG. */
function imageFormat(mime: string): ImageFormat {
  const type = mime.toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpeg';
}

/** The bare mime a data URL carries, or '' when it is not a base64 image URL. */
function dataUrlMime(url: string): string {
  const match = /^data:([^;,]+);base64,/i.exec(url.trim());
  return match ? match[1].trim() : '';
}

/**
 * The image bytes and format Converse wants. A data URL is decoded in place; an
 * http(s) URL is fetched, because the Converse image source takes bytes or an
 * S3 location, never an arbitrary URL.
 */
async function imageBytes(url: string, signal: AbortSignal): Promise<{ format: ImageFormat; bytes: Uint8Array }> {
  const mime = dataUrlMime(url);
  if (mime) {
    const base64 = url.slice(url.indexOf(',') + 1);
    return { format: imageFormat(mime), bytes: new Uint8Array(Buffer.from(base64, 'base64')) };
  }
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch {
    throw new LlmError(signal.aborted ? 'timeout' : 'unreachable');
  }
  if (!response.ok) throw new LlmError('upstream', response.status, 'the photo URL could not be read');
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { format: imageFormat(response.headers.get('content-type') ?? ''), bytes };
}

/**
 * The SDK types a tool's JSON Schema as its own recursive DocumentType, which a
 * plain `Record<string, unknown>` is not assignable to. It is the same JSON at
 * runtime, so the schema is handed over with this one cast.
 */
function schemaJson(parameters: Record<string, unknown>): NonNullable<ToolInputSchema['json']> {
  return parameters as unknown as NonNullable<ToolInputSchema['json']>;
}

async function novaChat(model: string, request: LlmRequest, signal: AbortSignal): Promise<LlmResult> {
  const content: ContentBlock[] = [];
  for (const part of request.parts) {
    if (part.type === 'text') {
      if (part.text) content.push({ text: part.text });
    } else {
      const { format, bytes } = await imageBytes(part.url, signal);
      content.push({ image: { format, source: { bytes } } });
    }
  }

  const tools: Tool[] | undefined = request.tools?.length
    ? request.tools.map((tool) => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: schemaJson(tool.parameters) },
        },
      }))
    : undefined;

  let response: ConverseCommandOutput;
  try {
    response = await bedrockClient().send(
      new ConverseCommand({
        modelId: model,
        system: [{ text: request.system }],
        messages: [{ role: 'user', content }],
        inferenceConfig: {
          temperature: request.temperature ?? 0,
          ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        },
        ...(tools ? { toolConfig: { tools, toolChoice: { auto: {} } } } : {}),
      }),
      { abortSignal: signal },
    );
  } catch (error) {
    if (signal.aborted) throw new LlmError('timeout');
    throw new LlmError('unreachable', undefined, error instanceof Error ? error.message : String(error));
  }

  const output = response.output;
  const blocks: ContentBlock[] = output?.message ? output.message.content ?? [] : [];

  let text = '';
  let toolCall: LlmToolCall | null = null;
  for (const block of blocks) {
    if ('text' in block && typeof block.text === 'string') {
      text += block.text;
    } else if ('toolUse' in block && block.toolUse) {
      const name = block.toolUse.name;
      if (typeof name === 'string' && name) {
        toolCall = {
          name,
          arguments: isRecord(block.toolUse.input) ? block.toolUse.input : {},
        };
      }
    }
  }
  text = text.trim();
  if (!text && !toolCall) throw new LlmError('empty');

  return { text, toolCall, toolArgumentsUnreadable: false, model, provider: 'nova' };
}
