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
// A caller may name a model from ROUTER_MODELS in deepseek.ts - the host's
// dropdown offers the same ids - and, with the vision model, attach an image the
// model reads alongside the utterance. Only ids on that list are ever forwarded,
// and the key stays here: the page still holds no credential, only a model name.

import type { FastifyInstance } from 'fastify';

import { isImageInput, modelSpec, ROUTER_MODELS, VISION_MODEL, deepseekConfig, type RouterModel } from './deepseek.js';
import { resolveCaller } from './identity.js';

/** One tool as tools/list advertises it, trimmed to what the router needs. */
interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** The host's answer: the tool to call, its arguments, and why. */
interface RouteDecision {
  tool: string | null;
  arguments: Record<string, unknown>;
  rationale: string;
}

/** How long the upstream model may take before the route gives up. */
const TIMEOUT_MS = 20_000;

/** Whether the route can serve, and which models it offers - for /health. */
export function routerHealth(): { configured: boolean; model: string; models: RouterModel[] } {
  const { model, apiKey } = deepseekConfig();
  return { configured: apiKey !== null, model, models: [...ROUTER_MODELS] };
}

const SYSTEM_PROMPT = [
  "You route a listener's request to exactly one tool on the Globie Earth MCP server,",
  'a reforestation sanctuary in Isaan, Thailand.',
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
  // The DNP entity_type values are otherwise opaque to a spoken question, so a
  // listener asking for "the plant checklist" or "the wildlife checklist" gets
  // no signal that those datasets have a name. Spelling the mapping out here is
  // safe because it stays inside the same rule: the filter is named from the
  // listener's words, never guessed from a species-like name (see the "Yang na"
  // note above) - and the default search already spans every source, so the
  // common case still needs no filter at all.
  'DNP reference datasets have their own entity_type values and are reached by default,' +
    ' so do not filter to them unless the listener names the dataset: "the plant ' +
    'checklist" means entity_type "dnp_plant", "the biodiversity survey" means ' +
    '"dnp_species", "the wildlife checklist" or "the protected species checklist" means ' +
    '"dnp_wildlife", and "animals seen in a park" or "park animals" means "dnp_fauna".',
  'Never invent a tool name, and never pick a tool the listener did not ask for.',
  // The attached photo is the whole point of the vision model here. Only the
  // describe_photo tool can look at an image, and it reads *any* photo - a
  // plant, a room, a document - so a photo must never be declined for want of
  // a tool. The image itself is not an argument the model reproduces; the host
  // fills it into the call from the file the listener attached.
  'A photo is attached to this request: route it to "describe_photo", passing the',
  'listener\'s question as its question argument. describe_photo reads any photo, not only',
  'trees, so never answer that no tool can see an image.',
  'If no offered tool can serve the request, answer without calling a tool and say why in one sentence.',
].join(' ');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `tools` array an OpenAI-compatible endpoint expects, from what the host sent. */
function asFunctionTools(tools: AdvertisedTool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description?.trim() || tool.name,
      // A tool with no schema is still routable; an empty object schema is valid.
      parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    },
  }));
}

/** Reads the first tool call out of an OpenAI-compatible message. */
function decisionFrom(message: { tool_calls?: unknown; content?: unknown }): RouteDecision {
  const rationale = typeof message.content === 'string' ? message.content.trim() : '';
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = calls[0] as { function?: { name?: unknown; arguments?: unknown } } | undefined;
  const name = first?.function?.name;
  if (typeof name !== 'string' || !name) {
    return { tool: null, arguments: {}, rationale: rationale || 'No tool matched that request.' };
  }

  let args: Record<string, unknown> = {};
  const raw = first?.function?.arguments;
  if (typeof raw === 'string' && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        tool: null,
        arguments: {},
        rationale: `The router returned arguments for ${name} that are not JSON.`,
      };
    }
    if (isRecord(parsed)) args = parsed;
  } else if (isRecord(raw)) {
    args = raw;
  }

  return { tool: name, arguments: args, rationale };
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
    const tools = Array.isArray(body.tools) ? (body.tools as AdvertisedTool[]) : [];
    if (!tools.length || !tools.every((tool) => isRecord(tool) && typeof tool.name === 'string' && tool.name)) {
      return reply.code(400).send({ error: 'The router body must list at least one tool with a name.' });
    }

    const { baseUrl, model: defaultModel, apiKey } = deepseekConfig();
    if (!apiKey) {
      return reply.code(503).send({
        error:
          'The tool router is not configured. Set DEEPSEEK_API_KEY (and optionally ' +
          'DEEPSEEK_BASE_URL / DEEPSEEK_MODEL) in the MCP server environment.',
      });
    }

    // A caller may name a model, but only one this router offers. An unknown
    // name is refused rather than forwarded, so the allowlist cannot be walked
    // past to bill some other model to this server's key.
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    const spec = requestedModel ? modelSpec(requestedModel) : modelSpec(defaultModel);
    if (requestedModel && !spec) {
      return reply.code(400).send({
        error:
          `This router does not offer the model "${requestedModel}". It offers: ` +
          `${ROUTER_MODELS.map((model) => model.id).join(', ')}.`,
      });
    }
    const model = spec?.id ?? defaultModel;

    // An image turns the user message into multimodal content, which only a
    // vision model takes. Refusing here is the honest answer: the text-only
    // model would otherwise silently ignore the photo.
    const image = typeof body.image === 'string' ? body.image.trim() : '';
    if (image && !isImageInput(image)) {
      return reply.code(400).send({
        error: 'The router image must be a data:image/…;base64,… URL or an http(s) URL.',
      });
    }
    if (image && !spec?.vision) {
      return reply.code(400).send({
        error: `The model "${model}" does not take an image. Choose "${VISION_MODEL}" to route a photo.`,
      });
    }

    const utterance = body.utterance.trim().slice(0, 2000);
    const userContent = image
      ? [
          { type: 'text', text: utterance },
          { type: 'image_url', image_url: { url: image } },
        ]
      : utterance;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          tools: asFunctionTools(tools),
          tool_choice: 'auto',
          temperature: 0,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      request.log.error({ err: error }, 'router: upstream fetch failed');
      const message = controller.signal.aborted
        ? `The router timed out after ${TIMEOUT_MS} ms.`
        : `The router could not reach ${baseUrl}.`;
      return reply.code(502).send({ error: message });
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      request.log.error({ status: upstream.status }, 'router: upstream returned an error');
      return reply.code(502).send({
        error: `The router's model endpoint returned ${upstream.status}. ${detail.slice(0, 300)}`.trim(),
      });
    }

    const payload = (await upstream.json().catch(() => null)) as { choices?: { message?: unknown }[] } | null;
    const message = payload?.choices?.[0]?.message;
    if (!isRecord(message)) {
      return reply.code(502).send({ error: 'The router response had no message.' });
    }
    // The model is echoed back so the host can say honestly which one answered.
    return reply.send({ ...decisionFrom(message as { tool_calls?: unknown; content?: unknown }), model });
  });
}
