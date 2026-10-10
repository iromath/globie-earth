// The MCP client at the centre of this page.
//
// It is a genuine MCP host: the official SDK client and the Streamable HTTP
// transport, the same code path an Alexa+ host uses. The wrapper exists to do
// three things the UI needs and the raw SDK does not give for free:
//
//   1. Hold one session (connect / disconnect) bound to one caller identity.
//   2. Keep an operation log, so the page can export proof that tools were
//      called at runtime rather than named in a README.
//   3. Turn tools/list's JSON Schema into form fields, so the UI is built from
//      what the server advertises and not from a hard-coded tool list.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  CallToolResult,
  CompatibilityCallToolResult,
  GetPromptResult,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListToolsResult,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

// The SDK's per-request timeout defaults to 60 s. A photo question is the one
// call that can run long - the server hands the image to the vision model and
// waits for it - and hitting that default shows the listener "MCP error -32001:
// Request timed out" while the server is in fact still working. Give the tool
// calls their own, larger ceiling so the answer arrives instead of the error.
const TOOL_CALL_TIMEOUT_MS = 120_000;

/** What the server answered initialize with, flattened for display. */
export interface Handshake {
  name: string;
  version: string;
  protocolVersion: string | undefined;
  sessionId: string | undefined;
  capabilities: string[];
  instructions: string | undefined;
}

/** One line in the operation log. `summary` is prose, not a payload dump. */
export interface TranscriptEntry {
  at: string;
  direction: 'out' | 'in' | 'note';
  method: string;
  summary: string;
}

export interface ConnectOptions {
  url: string;
  deviceId: string;
  bearerToken?: string;
}

/** A form field derived from one property of a tool's input schema. */
export interface ToolField {
  name: string;
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
  required: boolean;
  description: string;
  options?: string[];
  defaultValue?: string | number | boolean;
}

/** The subset of JSON Schema tools/list returns that this page renders. */
interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
}

/**
 * Flattens a tool's input schema into the fields the UI draws. Unknown shapes
 * fall back to a plain string input rather than being dropped, so a schema this
 * page has not seen still gets a chance to be called.
 */
export function toolFields(tool: Tool): ToolField[] {
  const schema = (tool.inputSchema ?? {}) as JsonSchemaObject;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  return Object.entries(properties).map(([name, property]) => {
    const options = Array.isArray(property.enum) ? property.enum.map(String) : undefined;
    const kinds = Array.isArray(property.type) ? property.type : [property.type];
    let kind: ToolField['kind'];
    if (options && options.length) kind = 'enum';
    else if (kinds.includes('integer')) kind = 'integer';
    else if (kinds.includes('number')) kind = 'number';
    else if (kinds.includes('boolean')) kind = 'boolean';
    else kind = 'string';

    const declaredDefault = property.default;
    const defaultValue =
      typeof declaredDefault === 'string' ||
      typeof declaredDefault === 'number' ||
      typeof declaredDefault === 'boolean'
        ? declaredDefault
        : undefined;

    return {
      name,
      kind,
      required: required.has(name),
      description: property.description ?? '',
      options,
      defaultValue,
    };
  });
}

/** True when a tool's annotations say it changes state. */
export function isMutating(tool: Tool): boolean {
  return tool.annotations?.readOnlyHint === false;
}

export class GlobieMcpClient {
  private client: Client | null = null;
  private log: TranscriptEntry[] = [];

  get connected(): boolean {
    return this.client !== null;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.log;
  }

  private record(direction: TranscriptEntry['direction'], method: string, summary: string): void {
    this.log.push({ at: new Date().toISOString(), direction, method, summary });
  }

  /** Opens the session and completes the initialize handshake. */
  async connect(options: ConnectOptions): Promise<Handshake> {
    if (this.client) throw new Error('Already connected. Disconnect first.');

    const headers: Record<string, string> = { 'X-Device-Id': options.deviceId.trim() };
    if (options.bearerToken?.trim()) {
      headers.Authorization = `Bearer ${options.bearerToken.trim()}`;
    }

    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers },
    });
    const client = new Client({ name: 'globie-earth-web-client', version: '1.0.0' });

    this.record(
      'note',
      'connect',
      `Opening ${options.url} as device ${headers['X-Device-Id']}${
        headers.Authorization ? ' with a demo bearer token' : ''
      }.`,
    );

    try {
      await client.connect(transport);
    } catch (error) {
      // Nothing was handed out on failure, so leave no half-open state behind.
      await client.close().catch(() => undefined);
      this.record('note', 'connect', `Failed: ${message(error)}`);
      throw error;
    }

    this.client = client;

    const version = client.getServerVersion();
    const capabilities = Object.keys(client.getServerCapabilities() ?? {});
    const handshake: Handshake = {
      name: version?.name ?? 'unknown',
      version: version?.version ?? 'unknown',
      protocolVersion: transport.protocolVersion,
      sessionId: transport.sessionId,
      capabilities,
      instructions: client.getInstructions(),
    };

    this.record(
      'in',
      'initialize',
      `${handshake.name}@${handshake.version}, protocol ${handshake.protocolVersion ?? 'unstated'}, capabilities: ${
        capabilities.join(', ') || 'none'
      }.`,
    );
    return handshake;
  }

  /** Ends the session. Safe to call when not connected. */
  async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      await client.close();
      this.record('note', 'disconnect', 'Session closed.');
    } catch (error) {
      this.record('note', 'disconnect', `Closed with an error: ${message(error)}`);
    }
  }

  private require(): Client {
    if (!this.client) throw new Error('Not connected. Connect first.');
    return this.client;
  }

  async listTools(): Promise<Tool[]> {
    const result: ListToolsResult = await this.require().listTools();
    this.record('in', 'tools/list', `${result.tools.length} tool(s): ${result.tools.map((t) => t.name).join(', ')}`);
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const shown = Object.keys(args).length ? JSON.stringify(args) : '{}';
    this.record('out', 'tools/call', `${name} ${shown}`);
    const raw = await this.require().callTool({ name, arguments: args }, undefined, {
      timeout: TOOL_CALL_TIMEOUT_MS,
    });
    const result: CallToolResult = normalizeToolResult(raw);
    this.record(
      result.isError ? 'note' : 'in',
      'tools/call',
      `${name} → ${result.isError ? 'error: ' : 'ok: '}${preview(firstText(result))}`,
    );
    return result;
  }

  async listResources(): Promise<{ resources: Resource[]; templates: ResourceTemplate[] }> {
    const resources: ListResourcesResult = await this.require().listResources();
    const templates: ListResourceTemplatesResult = await this.require().listResourceTemplates();
    this.record(
      'in',
      'resources/list',
      `${resources.resources.length} resource(s) and ${templates.resourceTemplates.length} template(s).`,
    );
    return { resources: resources.resources, templates: templates.resourceTemplates };
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    this.record('out', 'resources/read', uri);
    const result: ReadResourceResult = await this.require().readResource({ uri });
    const first = result.contents[0];
    this.record('in', 'resources/read', `${uri} → ${preview('text' in first ? first.text : first.uri)}`);
    return result;
  }

  async listPrompts(): Promise<Prompt[]> {
    const result: ListPromptsResult = await this.require().listPrompts();
    this.record('in', 'prompts/list', `${result.prompts.length} prompt(s): ${result.prompts.map((p) => p.name).join(', ')}`);
    return result.prompts;
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<GetPromptResult> {
    const shown = Object.keys(args).length ? JSON.stringify(args) : '{}';
    this.record('out', 'prompts/get', `${name} ${shown}`);
    const result: GetPromptResult = await this.require().getPrompt({ name, arguments: args });
    this.record('in', 'prompts/get', `${name} → ${result.messages.length} message(s).`);
    return result;
  }
}

// The SDK types callTool's return as the modern result or the legacy
// `{ toolResult }` shape. Our server speaks the modern shape; this keeps a
// non-conforming legacy result from crashing the UI.
function normalizeToolResult(
  raw: CallToolResult | CompatibilityCallToolResult,
): CallToolResult {
  // Both union members carry an index signature, so `'content' in raw` cannot
  // narrow. Read the fields structurally instead.
  const { content, isError, structuredContent } = raw as Partial<CallToolResult>;
  if (Array.isArray(content)) return { content, isError, structuredContent };
  const legacy = (raw as { toolResult?: unknown }).toolResult;
  const text = typeof legacy === 'string' ? legacy : JSON.stringify(legacy ?? null);
  return { content: [{ type: 'text', text }] };
}

/** The text of the first text block of a tool result, or ''. */
export function firstText(result: CallToolResult): string {
  const block = result.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}

/** A one-line, length-capped version of a string, for the log. */
export function preview(text: string, limit = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
