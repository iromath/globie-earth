// The tool router: one natural-language utterance in, one tool call out.
//
// The browser host is a static bundle, so an LLM key can never live in the page
// (Vite inlines every VITE_ variable at build time). This route is the
// server-side brain instead: the host posts the utterance plus the tool list it
// just read from tools/list, and gets back the single tool call to make - which
// the host then makes itself, over MCP, so the runtime proof stays on the MCP
// surface rather than on this helper.
//
// The model is an OpenAI-compatible chat-completions endpoint with function
// calling. The defaults match the "Model router" block in infra/.env
// (DEEPSEEK_BASE_URL / DEEPSEEK_MODEL / DEEPSEEK_API_KEY); reading them per
// request keeps a missing key a clear 503 rather than a boot failure, exactly
// as EMBEDDING_PROVIDER=none keeps semantic search a valid configuration.
//
// A caller may name a model from ROUTER_MODELS in llm.ts - the host's dropdown
// offers the same ids - and, with a vision model, attach an image it reads
// alongside the utterance. Each id carries its own provider (DeepSeek or Amazon
// Bedrock Nova), so one call can go to either. Only ids on that list are ever
// forwarded, and the keys stay here: the page still holds no credential, only a
// model name.

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { deepseekConfig } from './deepseek.js';
import { resolveCaller } from './identity.js';
import {
  chat,
  isImageInput,
  LlmError,
  modelSpec,
  providerConfigured,
  ROUTER_MODELS,
  VISION_MODEL,
  type LlmPart,
  type LlmProvider,
  type LlmResult,
  type LlmTool,
  type RouterModel,
} from './llm.js';

/** One tool as tools/list advertises it, trimmed to what the router needs. */
export interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** The host's answer: the tool to call, its arguments, and why. */
export interface RouteDecision {
  tool: string | null;
  arguments: Record<string, unknown>;
  rationale: string;
}

/**
 * What the router decided, or why it could not. A refusal carries the HTTP
 * status its own front door would have used, so neither front door has to
 * invent one - and so a second door cannot quietly widen what is allowed.
 */
export type RouteOutcome =
  | { ok: true; decision: RouteDecision; model: string }
  | { ok: false; status: number; error: string };

/** One routing request: the listener's words and the tools they may reach. */
export interface RouteInput {
  utterance: string;
  tools: AdvertisedTool[];
  /** A model id from ROUTER_MODELS. Omitted means the configured default. */
  model?: string;
  /** A data: or http(s) image URL, for the vision model only. */
  image?: string;
  /**
   * Whether the listener has already agreed to this request.
   *
   * The state-changing tools say to ask first (tools/studio.ts), so the router
   * answers the opening request with a question rather than a tool call. A voice
   * turn cannot carry that question to the next utterance - the Skill webhook
   * keeps no session of its own (alexa.ts) - so the confirmation is held in the
   * Skill's session attributes and the same sentence is routed a second time
   * with this set, which is what turns the question into the call.
   */
  confirmed?: boolean;
}

/** How long the upstream model may take before the route gives up. */
const TIMEOUT_MS = 20_000;

/**
 * Whether the route can serve, and which models it offers - for /health. The
 * route can serve when *either* provider is configured: each offered id names
 * the provider it goes to, so a DeepSeek-key-only or a Nova-only environment
 * still answers for the ids on its side.
 */
export function routerHealth(): { configured: boolean; model: string; models: RouterModel[] } {
  const { model } = deepseekConfig();
  return {
    configured: providerConfigured('deepseek') || providerConfigured('nova'),
    model,
    models: [...ROUTER_MODELS],
  };
}

const SYSTEM_PROMPT_BASE = [
  "You route a listener's request to exactly one tool on the Globie Earth MCP server.",
  'Globie Earth is a regenerative agroforestry site in Isaan, Thailand, and also offers a travel ' +
    'catalogue (the om_* tools: tours, destinations, flights, guides, trip planning).',
  'Call exactly one tool, using its exact name, and fill its arguments from the request.',
  "When the request is a free-text question, pass the question through as the tool's query argument.",
  // A search takes an optional entity_type filter, and a model reaches for it
  // far too eagerly: asked for "Yang na" it set entity_type=dnp_species, which
  // hid the Globie catalogue row actually named "Yang Na" and answered with
  // butterfly survey rows instead. A filter the listener never asked for is a
  // wrong answer dressed up as precision, so it is only ever set on an explicit
  // instruction - the same discipline for every optional filter argument.
  'Set an optional filter argument (such as entity_type) only when the listener\'s own ' +
    'words name that kind of entry - e.g. "only butterflies", "just the plant ' +
    'checklist", "show me the sites". Otherwise leave every optional argument out.',
  // The forest-dataset entity_type values are otherwise opaque to a spoken
  // question, so a listener asking for "the plant checklist" or "the wildlife
  // checklist" gets no signal that those datasets have a name. Spelling the
  // mapping out here is safe because it stays inside the same rule: the filter
  // is named from the listener's words, never guessed from a species-like name
  // (see the "Yang na" note above) - and the default search already spans every
  // dataset, so the common case still needs no filter at all.
  'Globie Earth\'s forest datasets have their own entity_type values and are reached by ' +
    'default, so do not filter to them unless the listener names the dataset: "the plant ' +
    'checklist" means entity_type "dnp_plant", "the biodiversity survey" means ' +
    '"dnp_species", "the wildlife checklist" or "the protected species checklist" means ' +
    '"dnp_wildlife", and "animals seen in a park" or "park animals" means "dnp_fauna".',
  'Never invent a tool name, and never pick a tool the listener did not ask for.',
];

// The attached photo is the whole point of the vision model here. Only the
// describe_photo tool can look at an image, and it reads *any* photo - a
// plant, a room, a document - so a photo must never be declined for want of
// a tool. The image itself is not an argument the model reproduces; the host
// fills it into the call from the file the listener attached.
const PHOTO_ATTACHED = [
  'A photo is attached to this request: route it to "describe_photo", passing the',
  'listener\'s question as its question argument. describe_photo reads any photo, not only',
  'trees, so never answer that no tool can see an image.',
];

// Stated only when no image is attached. The clause above used to be part of the
// fixed prompt, so a plain text request ("how is the site doing?") was told
// a photo *was* attached and got routed to describe_photo, which then had no
// image to read. Telling the model the truth - no photo here - keeps it off that
// tool and leaves the decision to the words alone.
const NO_PHOTO = [
  'No photo is attached to this request, so never route to "describe_photo": it needs an',
  'image the listener has not sent. Route the request to the tool that fits the words alone.',
];

const NO_TOOL_CLAUSE =
  'If no offered tool can serve the request, answer without calling a tool and say why in one sentence.';

// Stated only on a re-route the listener has already agreed to (RouteInput.
// confirmed). Without it the state-changing tools' "ask before calling it" reads
// the same sentence as a fresh request and asks the same question a second time,
// which is exactly the loop this exists to break.
const CONFIRMED_CLAUSE =
  'The listener has already given their go-ahead for this request in the previous turn, so ' +
  'call the tool now instead of asking for confirmation again.';

/** The router prompt for this request, with the photo clause stated only when one is attached. */
function systemPrompt(hasImage: boolean, confirmed: boolean): string {
  return [
    ...SYSTEM_PROMPT_BASE,
    ...(hasImage ? PHOTO_ATTACHED : NO_PHOTO),
    ...(confirmed ? [CONFIRMED_CLAUSE] : []),
    NO_TOOL_CLAUSE,
  ].join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The tool list the model may call, in the provider-neutral shape llm.ts takes. */
function asLlmTools(tools: AdvertisedTool[]): LlmTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description?.trim() || tool.name,
    // A tool with no schema is still routable; an empty object schema is valid.
    parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
  }));
}

/**
 * Routes one utterance to one tool call.
 *
 * Lifted out of the /route handler so a second front door can use it: the Alexa
 * Skill adapter (alexa.ts) is handed exactly the same thing - a listener's
 * sentence and the tool list - and has no reason to reach this over HTTP. Every
 * decision that costs money, and every refusal, stays here either way, so the
 * two doors cannot drift apart on what is allowed or which model is billed.
 */
export async function routeToTool(input: RouteInput, log: FastifyBaseLogger): Promise<RouteOutcome> {
  const tools = input.tools;
  if (!tools.length || !tools.every((tool) => isRecord(tool) && typeof tool.name === 'string' && tool.name)) {
    return { ok: false, status: 400, error: 'The router body must list at least one tool with a name.' };
  }

  // A caller may name a model, but only one this router offers. An unknown
  // name is refused rather than forwarded, so the allowlist cannot be walked
  // past to bill some other model to this server's key. Each offered id
  // carries the provider that serves it, so this one choice also picks
  // whether the call goes to DeepSeek or to Amazon Bedrock Nova.
  const { model: defaultModel } = deepseekConfig();
  const requestedModel = input.model?.trim() ?? '';
  const spec = requestedModel ? modelSpec(requestedModel) : modelSpec(defaultModel);
  if (requestedModel && !spec) {
    return {
      ok: false,
      status: 400,
      error:
        `This router does not offer the model "${requestedModel}". It offers: ` +
        `${ROUTER_MODELS.map((model) => model.id).join(', ')}.`,
    };
  }
  const model = spec?.id ?? defaultModel;
  // An unlisted default (DEEPSEEK_MODEL set to something off the list) still
  // goes to DeepSeek, which is the provider that name belongs to.
  const provider: LlmProvider = spec?.provider ?? 'deepseek';
  if (!providerConfigured(provider)) {
    return {
      ok: false,
      status: 503,
      error:
        provider === 'nova'
          ? 'The tool router is not configured for Nova. Set the Bedrock credentials ' +
            '(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or an AWS_BEARER_TOKEN_BEDROCK ' +
            'API key, and BEDROCK_REGION or AWS_REGION) in the MCP server environment.'
          : 'The tool router is not configured. Set DEEPSEEK_API_KEY (and optionally ' +
            'DEEPSEEK_BASE_URL / DEEPSEEK_MODEL) in the MCP server environment.',
    };
  }

  // An image turns the user message into multimodal content, which only a
  // vision model takes. Refusing here is the honest answer: the text-only
  // model would otherwise silently ignore the photo.
  const image = input.image?.trim() ?? '';
  if (image && !isImageInput(image)) {
    return {
      ok: false,
      status: 400,
      error: 'The router image must be a data:image/…;base64,… URL or an http(s) URL.',
    };
  }
  if (image && !spec?.vision) {
    return {
      ok: false,
      status: 400,
      error: `The model "${model}" does not take an image. Choose "${VISION_MODEL}" to route a photo.`,
    };
  }

  const utterance = input.utterance.trim().slice(0, 2000);
  const parts: LlmPart[] = [{ type: 'text', text: utterance }];
  if (image) parts.push({ type: 'image', url: image });

  let result: LlmResult;
  try {
    result = await chat({
      provider,
      model,
      request: {
        system: systemPrompt(Boolean(image), input.confirmed === true),
        parts,
        tools: asLlmTools(tools),
        temperature: 0,
      },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    log.error({ err: error, kind: error.kind }, 'router: model call failed');
    if (error.kind === 'timeout') {
      return { ok: false, status: 502, error: `The router timed out after ${TIMEOUT_MS} ms.` };
    }
    if (error.kind === 'upstream') {
      return {
        ok: false,
        status: 502,
        error: `The router's model endpoint returned ${error.status}. ${error.detail}`.trim(),
      };
    }
    return { ok: false, status: 502, error: 'The router could not reach its model endpoint.' };
  }

  // The model's text is the rationale; a tool call is the decision. Arguments
  // that were not readable JSON are reported rather than passed on unparsed,
  // exactly as the OpenAI-compatible path did before.
  let decision: RouteDecision;
  if (result.toolCall && result.toolArgumentsUnreadable) {
    decision = {
      tool: null,
      arguments: {},
      rationale: `The router returned arguments for ${result.toolCall.name} that are not JSON.`,
    };
  } else if (result.toolCall) {
    decision = { tool: result.toolCall.name, arguments: result.toolCall.arguments, rationale: result.text };
  } else {
    decision = { tool: null, arguments: {}, rationale: result.text || 'No tool matched that request.' };
  }

  return { ok: true, decision, model: result.model };
}

export function registerRouterRoute(app: FastifyInstance): void {
  app.post('/route', async (request, reply) => {
    // The same identity /mcp requires. Without it this route is an open relay
    // to a paid model billed to this server's key: any anonymous poster could
    // spend it. The browser host already holds a device id - it cannot connect
    // to /mcp without one - so gating here costs the host nothing.
    if (!resolveCaller(request.headers)) {
      return reply.code(401).send({
        error:
          'The tool router needs a caller identity: the same X-Device-Id (or demo ' +
          'Authorization bearer) that /mcp accepts. See infra/mcp/README.md.',
      });
    }

    const body: unknown = request.body;
    if (!isRecord(body) || typeof body.utterance !== 'string' || !body.utterance.trim()) {
      return reply.code(400).send({ error: 'The router body must be { utterance: string, tools: [...] }.' });
    }

    const outcome = await routeToTool(
      {
        utterance: body.utterance,
        tools: Array.isArray(body.tools) ? (body.tools as AdvertisedTool[]) : [],
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(typeof body.image === 'string' ? { image: body.image } : {}),
      },
      request.log,
    );

    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });

    // The model is echoed back so the host can say honestly which one answered.
    return reply.send({ ...outcome.decision, model: outcome.model });
  });
}
