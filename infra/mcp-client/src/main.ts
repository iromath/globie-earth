// The DOM wiring: turns the scaffold into a working MCP host.
//
// Everything on this page is driven by what the server advertises. The connect
// form opens a session, the handshake panel is filled from initialize, and the
// tool forms are built from the JSON Schema returned by tools/list — there is no
// hard-coded tool list here to drift out of step with the server.

import './style.css';

import type {
  CallToolResult,
  ContentBlock,
  Prompt,
  ResourceTemplate,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { GlobieMcpClient, isMutating, toolFields, type Handshake, type ToolField } from './mcp';
import {
  recorderSupport,
  speak,
  speechSupport,
  startListening,
  startRecording,
  stopSpeaking,
  type Recorder,
} from './voice';

const client = new GlobieMcpClient();
let lastHandshake: Handshake | null = null;

// The last tools/list result, kept so the router can be handed the live surface
// without a second round trip. Filled by loadTools() at connect time.
let advertisedTools: Tool[] = [];

/* ── Element lookup ─────────────────────────────────────────────────────── */

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const form = requireElement<HTMLFormElement>('connect-form');
const urlField = requireElement<HTMLInputElement>('field-url');
const deviceField = requireElement<HTMLInputElement>('field-device');
const tokenField = requireElement<HTMLInputElement>('field-token');
const connectButton = requireElement<HTMLButtonElement>('connect-button');
const disconnectButton = requireElement<HTMLButtonElement>('disconnect-button');
const connectStatus = requireElement<HTMLParagraphElement>('connect-status');

const handshakePanel = requireElement('handshake-panel');
const handshakeFacts = requireElement<HTMLDListElement>('handshake-facts');
const instructionsWrap = requireElement<HTMLDetailsElement>('instructions-wrap');
const instructionsPre = requireElement<HTMLPreElement>('instructions');

const voicePanel = requireElement('voice-panel');
const voiceSupportEl = requireElement<HTMLParagraphElement>('voice-support');
const micButton = requireElement<HTMLButtonElement>('mic-button');
const voiceQuery = requireElement<HTMLInputElement>('voice-query');
const askButton = requireElement<HTMLButtonElement>('ask-button');
const stopButton = requireElement<HTMLButtonElement>('stop-speaking');
const voiceModel = requireElement<HTMLSelectElement>('voice-model');
const voiceImage = requireElement<HTMLInputElement>('voice-image');
const voiceImageNote = requireElement<HTMLParagraphElement>('voice-image-note');
const voiceSource = requireElement<HTMLSelectElement>('voice-source');
const voiceStatus = requireElement<HTMLParagraphElement>('voice-status');
const voiceResult = requireElement('voice-result');

const surfacePanel = requireElement('surface-panel');
const panels: Record<'tools' | 'resources' | 'prompts' | 'transcript', HTMLElement> = {
  tools: requireElement('tab-tools'),
  resources: requireElement('tab-resources'),
  prompts: requireElement('tab-prompts'),
  transcript: requireElement('tab-transcript'),
};
const transcriptList = requireElement<HTMLOListElement>('transcript');
const copyButton = requireElement<HTMLButtonElement>('copy-transcript');
const downloadButton = requireElement<HTMLButtonElement>('download-transcript');

/* ── Small render helpers ───────────────────────────────────────────────── */

function note(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}

function errorBlock(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'status err';
  p.textContent = text;
  return p;
}

function badge(text: string, kind: 'read' | 'mutating'): HTMLElement {
  const span = document.createElement('span');
  span.className = `badge ${kind}`;
  span.textContent = text;
  return span;
}

function heading(text: string): HTMLElement {
  const h3 = document.createElement('h3');
  h3.textContent = text;
  return h3;
}

function setStatus(element: HTMLElement, text: string, kind?: 'ok' | 'err'): void {
  element.textContent = text;
  element.classList.toggle('ok', kind === 'ok');
  element.classList.toggle('err', kind === 'err');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flash(button: HTMLButtonElement, text: string): void {
  if (!button.dataset.label) button.dataset.label = button.textContent ?? '';
  button.textContent = text;
  window.setTimeout(() => {
    if (button.dataset.label) button.textContent = button.dataset.label;
  }, 1500);
}

/* ── Defaults ───────────────────────────────────────────────────────────── */

function defaultEndpoint(): string {
  const host = window.location.hostname;
  if (host === '' || host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:8092/mcp';
  }
  return 'https://mcp.globie.earth/mcp';
}

/* ── Device registration ────────────────────────────────────────────────── */

/**
 * The backend API base, derived from the endpoint the user connected to.
 *
 * Like defaultEndpoint(), there is no build-time configuration (see the
 * Dockerfile): the host resolves its endpoints from where it is served.
 * mcp.globie.earth -> api.globie.earth, and a local server -> the local
 * PostgREST port. Null when the endpoint is not one we can map.
 */
function apiBase(): string | null {
  let endpoint: URL;
  try {
    endpoint = new URL(urlField.value.trim());
  } catch {
    return null;
  }
  const host = endpoint.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:3001';
  if (host.startsWith('mcp.')) return `${endpoint.protocol}//api.${host.slice(4)}`;
  return null;
}

/**
 * Creates this device's row before any device-gated route is used.
 *
 * The podcast and studio proxies answer 401 "That device has not been
 * registered by this app." for a uuid that is not in api.devices, and unlike
 * the app's own RPCs they never create it. PostgREST's devices_insert policy
 * lets a caller register its own id (the RLS policies), so the host
 * upserts it here exactly as src/lib/api.ts ensureDevice() does for the app.
 * Failure is not fatal: the session still opens, and a device-gated tool then
 * returns its own explaining error.
 */
async function registerDevice(deviceId: string): Promise<void> {
  const base = apiBase();
  if (!base) return;
  try {
    await fetch(`${base}/devices?on_conflict=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ id: deviceId }),
    });
  } catch {
    // Offline, or the API refused: leave the device unregistered rather than
    // blocking a session that is otherwise perfectly usable.
  }
}

// The device id is the RevenueCat appUserID; persisting it means deeds and the
// eco balance accumulate across reloads instead of resetting each visit.
function persistentDeviceId(): string {
  const key = 'globie-mcp-device-id';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  window.localStorage.setItem(key, fresh);
  return fresh;
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));

function selectTab(name: string): void {
  for (const tab of tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  for (const [key, panel] of Object.entries(panels)) {
    panel.hidden = key !== name;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab ?? 'tools'));
}

/* ── Connect ────────────────────────────────────────────────────────────── */

function setConnectedState(connected: boolean): void {
  connectButton.disabled = connected;
  disconnectButton.disabled = !connected;
  handshakePanel.hidden = !connected;
  voicePanel.hidden = !connected;
  surfacePanel.hidden = !connected;
}

function renderHandshake(handshake: Handshake): void {
  handshakeFacts.replaceChildren();
  const rows: Array<[string, string]> = [
    ['Server', `${handshake.name}@${handshake.version}`],
    ['Protocol', handshake.protocolVersion ?? 'unstated'],
    ['Session', handshake.sessionId ?? 'stateless'],
    ['Capabilities', handshake.capabilities.join(', ') || 'none'],
  ];
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    handshakeFacts.append(dt, dd);
  }

  if (handshake.instructions) {
    instructionsWrap.hidden = false;
    instructionsPre.textContent = handshake.instructions;
  } else {
    instructionsWrap.hidden = true;
    instructionsPre.textContent = '';
  }
}

function describeConnectError(error: unknown): string {
  const text = errorMessage(error);
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return `Could not reach the endpoint — is the MCP server running, and does its MCP_CORS_ORIGINS include ${window.location.origin}? (${text})`;
  }
  return text;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (client.connected) return;

  const url = urlField.value.trim();
  const deviceId = deviceField.value.trim();
  if (!url) {
    setStatus(connectStatus, 'An MCP endpoint is required.', 'err');
    return;
  }
  if (!deviceId) {
    setStatus(connectStatus, 'A device id is required — the server scopes your deeds by it.', 'err');
    return;
  }

  connectButton.disabled = true;
  setStatus(connectStatus, `Opening ${url} and negotiating initialize…`);
  try {
    const handshake = await client.connect({ url, deviceId, bearerToken: tokenField.value });
    // Register before the first tool call, so a device-gated route such as
    // search_podcasts does not answer "That device has not been registered".
    await registerDevice(deviceId);
    lastHandshake = handshake;
    renderHandshake(handshake);
    setConnectedState(true);
    setStatus(
      connectStatus,
      `Connected to ${handshake.name}@${handshake.version} over ${handshake.protocolVersion ?? 'the negotiated protocol'}.`,
      'ok',
    );
    await loadSurface();
    // Learn whether this server has the self-hosted speech cascade, so the
    // voice panel can say honestly which ears and mouth it will use.
    await probeSpeech();
    renderVoiceSupport();
  } catch (error) {
    setConnectedState(false);
    setStatus(connectStatus, describeConnectError(error), 'err');
    renderTranscript();
  }
});

disconnectButton.addEventListener('click', async () => {
  await client.disconnect();
  lastHandshake = null;
  setConnectedState(false);
  handshakeFacts.replaceChildren();
  instructionsPre.textContent = '';
  panels.tools.replaceChildren();
  panels.resources.replaceChildren();
  panels.prompts.replaceChildren();
  setStatus(connectStatus, 'Disconnected.', 'ok');
  renderTranscript();
});

/* ── The surface: tools, resources, prompts ─────────────────────────────── */

async function loadSurface(): Promise<void> {
  await Promise.all([loadTools(), loadResources(), loadPrompts()]);
  renderTranscript();
}

async function loadTools(): Promise<void> {
  const container = panels.tools;
  container.replaceChildren(note('Loading tools/list…'));
  try {
    const tools = await client.listTools();
    advertisedTools = tools;
    container.replaceChildren(
      note(`${tools.length} tool(s) advertised. Each form below is built from that tool's input schema.`),
    );
    for (const tool of tools) container.append(renderTool(tool));
  } catch (error) {
    container.replaceChildren(errorBlock(errorMessage(error)));
  }
  renderTranscript();
}

function renderTool(tool: Tool): HTMLElement {
  const mutating = isMutating(tool);

  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = heading('');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = tool.name;
  title.append(name);
  const badges = document.createElement('div');
  badges.className = 'badges';
  badges.append(badge(mutating ? 'changes state' : 'read-only', mutating ? 'mutating' : 'read'));
  head.append(title, badges);
  card.append(head);

  if (tool.description) card.append(note(tool.description));

  const fields = toolFields(tool);
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const grid = document.createElement('div');
  grid.className = 'arg-grid';
  for (const field of fields) grid.append(renderField(field, inputs));

  let confirmInput: HTMLInputElement | null = null;
  if (mutating) {
    const confirm = document.createElement('label');
    confirm.className = 'confirm';
    confirmInput = document.createElement('input');
    confirmInput.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = `I understand ${tool.name} changes state.`;
    confirm.append(confirmInput, text);
    grid.append(confirm);
  }

  const actions = document.createElement('div');
  actions.className = 'actions span-2';
  const callButton = document.createElement('button');
  callButton.type = 'button';
  callButton.textContent = `Call ${tool.name}`;
  actions.append(callButton);
  grid.append(actions);

  const result = document.createElement('div');
  result.className = 'result';

  card.append(grid, result);

  callButton.addEventListener('click', () => {
    void callTool(tool, fields, inputs, confirmInput, callButton, result);
  });

  return card;
}

function renderField(
  field: ToolField,
  inputs: Map<string, HTMLInputElement | HTMLSelectElement>,
): HTMLElement {
  const label = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = field.name + (field.required ? ' *' : '');
  label.append(caption);

  let control: HTMLInputElement | HTMLSelectElement;
  if (field.kind === 'enum' && field.options) {
    const select = document.createElement('select');
    for (const option of field.options) {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = option;
      select.append(item);
    }
    control = select;
  } else if (field.kind === 'boolean') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    control = input;
  } else {
    const input = document.createElement('input');
    input.type = field.kind === 'string' ? 'text' : 'number';
    if (field.kind === 'integer') input.step = '1';
    if (field.kind === 'number') input.step = 'any';
    control = input;
  }

  if (field.defaultValue !== undefined) {
    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      control.checked = Boolean(field.defaultValue);
    } else {
      control.value = String(field.defaultValue);
    }
  }

  label.append(control);

  const notes: string[] = [];
  if (field.description) notes.push(field.description);
  if (!field.required) notes.push('optional');
  if (notes.length) {
    const noteEl = document.createElement('span');
    noteEl.className = 'arg-note';
    noteEl.textContent = notes.join(' · ');
    label.append(noteEl);
  }

  inputs.set(field.name, control);
  return label;
}

function collectArgs(
  fields: ToolField[],
  inputs: Map<string, HTMLInputElement | HTMLSelectElement>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const control = inputs.get(field.name);
    if (!control) continue;

    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      if (field.kind === 'boolean' && (control.checked || field.required)) {
        args[field.name] = control.checked;
      }
      continue;
    }

    const raw = control.value.trim();
    if (!raw) continue;
    if (field.kind === 'integer') {
      const value = Number.parseInt(raw, 10);
      if (!Number.isNaN(value)) args[field.name] = value;
    } else if (field.kind === 'number') {
      const value = Number(raw);
      if (!Number.isNaN(value)) args[field.name] = value;
    } else {
      args[field.name] = raw;
    }
  }
  return args;
}

async function callTool(
  tool: Tool,
  fields: ToolField[],
  inputs: Map<string, HTMLInputElement | HTMLSelectElement>,
  confirmInput: HTMLInputElement | null,
  button: HTMLButtonElement,
  result: HTMLElement,
): Promise<void> {
  if (confirmInput && !confirmInput.checked) {
    result.classList.add('error');
    result.replaceChildren(errorBlock(`Tick the confirmation box first — ${tool.name} changes state.`));
    return;
  }

  button.disabled = true;
  result.classList.remove('error');
  result.replaceChildren(note('Calling…'));
  try {
    const response = await client.callTool(tool.name, collectArgs(fields, inputs));
    renderToolResult(result, tool.name, response);
    // The Tools tab is where a tool is called by hand, and its result is spoken
    // too - every MCP result is read aloud, not only the voice panel's.
    await speakResult(response, voiceStatus, `Called ${tool.name}`);
  } catch (error) {
    result.classList.add('error');
    result.replaceChildren(errorBlock(errorMessage(error)));
  } finally {
    button.disabled = false;
    renderTranscript();
  }
}

function textsOf(response: CallToolResult): string[] {
  const texts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') texts.push(block.text);
  }
  return texts;
}

/**
 * The plain-language lines a tool wrote for the listener's ear.
 *
 * A tool returns the JSON the screens read first, then (when it has one) a
 * text block tagged `audience: ["user"]` holding a sentence meant to be spoken.
 * Speaking that instead of the JSON is the whole point: otherwise the mouth
 * reads braces, quotes and blank lines aloud.
 */
function spokenTextsOf(response: CallToolResult): string[] {
  const spoken: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text' && block.annotations?.audience?.includes('user')) {
      spoken.push(block.text);
    }
  }
  return spoken;
}

function renderToolResult(result: HTMLElement, name: string, response: CallToolResult): void {
  result.classList.toggle('error', Boolean(response.isError));
  result.replaceChildren();

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const left = document.createElement('span');
  left.textContent = response.isError ? `${name} → error` : `${name} → ok`;
  const right = document.createElement('span');
  right.textContent = `${response.content.length} content block(s)`;
  meta.append(left, right);
  result.append(meta);

  const texts = textsOf(response);
  if (texts.length) {
    const pre = document.createElement('pre');
    pre.className = 'mono';
    pre.textContent = texts.join('\n\n');
    result.append(pre);
  } else {
    result.append(note('No text content. Raw result:'));
    const pre = document.createElement('pre');
    pre.className = 'mono';
    pre.textContent = JSON.stringify(response, null, 2);
    result.append(pre);
  }

  const others = response.content
    .filter((block) => block.type !== 'text')
    .map((block) => block.type);
  if (others.length) {
    result.append(note(`Also returned: ${others.join(', ')}.`));
  }
}

/* ── Resources ──────────────────────────────────────────────────────────── */

async function loadResources(): Promise<void> {
  const container = panels.resources;
  container.replaceChildren(note('Loading resources/list…'));
  try {
    const { resources, templates } = await client.listResources();
    container.replaceChildren(
      note(`${resources.length} resource(s) and ${templates.length} template(s).`),
    );

    if (resources.length) {
      container.append(heading('Resources'));
      const list = document.createElement('div');
      list.className = 'list';
      for (const resource of resources) {
        list.append(renderReadable(resource.uri, resource.name, resource.description ?? ''));
      }
      container.append(list);
    }

    if (templates.length) {
      container.append(heading('Templates'));
      for (const template of templates) container.append(renderTemplate(template));
    }
  } catch (error) {
    container.replaceChildren(errorBlock(errorMessage(error)));
  }
  renderTranscript();
}

function renderReadable(uri: string, title: string, description: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';
  const name = heading('');
  const code = document.createElement('span');
  code.className = 'name';
  code.textContent = title;
  name.append(code);
  const readButton = document.createElement('button');
  readButton.type = 'button';
  readButton.textContent = 'Read';
  head.append(name, readButton);
  card.append(head);

  if (description) card.append(note(description));

  const result = document.createElement('div');
  result.className = 'result';
  card.append(result);

  readButton.addEventListener('click', () => {
    void readResource(uri, readButton, result);
  });

  return card;
}

function renderTemplate(template: ResourceTemplate): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';
  const name = heading('');
  const code = document.createElement('span');
  code.className = 'name';
  code.textContent = template.name;
  name.append(code);
  head.append(name);
  card.append(head);

  card.append(note(`${template.uriTemplate}${template.description ? ` — ${template.description}` : ''}`));

  const placeholder = /\{([^}]+)\}/.exec(template.uriTemplate);
  const grid = document.createElement('div');
  grid.className = 'arg-grid';

  const label = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = placeholder ? placeholder[1] : 'value';
  const input = document.createElement('input');
  input.type = 'text';
  label.append(caption, input);
  grid.append(label);

  const actions = document.createElement('div');
  actions.className = 'actions span-2';
  const readButton = document.createElement('button');
  readButton.type = 'button';
  readButton.textContent = 'Read';
  actions.append(readButton);
  grid.append(actions);
  card.append(grid);

  const result = document.createElement('div');
  result.className = 'result';
  card.append(result);

  readButton.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) {
      result.classList.add('error');
      result.replaceChildren(errorBlock(`Fill in ${placeholder ? placeholder[1] : 'the placeholder'} first.`));
      return;
    }
    const uri = placeholder
      ? template.uriTemplate.replace(placeholder[0], encodeURIComponent(value))
      : template.uriTemplate;
    void readResource(uri, readButton, result);
  });

  return card;
}

async function readResource(
  uri: string,
  button: HTMLButtonElement,
  result: HTMLElement,
): Promise<void> {
  button.disabled = true;
  result.classList.remove('error');
  result.replaceChildren(note('Reading…'));
  try {
    const response = await client.readResource(uri);
    result.replaceChildren();

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    const left = document.createElement('span');
    left.className = 'mono';
    left.textContent = uri;
    const right = document.createElement('span');
    right.textContent = `${response.contents.length} content(s)`;
    meta.append(left, right);
    result.append(meta);

    const spoken: string[] = [];
    for (const content of response.contents) {
      const pre = document.createElement('pre');
      pre.className = 'mono';
      pre.textContent =
        'text' in content
          ? content.text
          : `[binary ${content.mimeType ?? 'resource'}, ${content.blob.length} base64 char(s)]`;
      result.append(pre);
      if ('text' in content) spoken.push(content.text);
    }
    // Every MCP result is read aloud, resources included; a binary resource has
    // nothing speakable, so it is shown but left silent.
    await readAloud(spoken.join('\n\n'), voiceStatus, `Read ${uri}`);
  } catch (error) {
    result.classList.add('error');
    result.replaceChildren(errorBlock(errorMessage(error)));
  } finally {
    button.disabled = false;
    renderTranscript();
  }
}

/* ── Prompts ────────────────────────────────────────────────────────────── */

async function loadPrompts(): Promise<void> {
  const container = panels.prompts;
  container.replaceChildren(note('Loading prompts/list…'));
  try {
    const prompts = await client.listPrompts();
    container.replaceChildren(note(`${prompts.length} prompt(s) advertised.`));
    for (const prompt of prompts) container.append(renderPrompt(prompt));
  } catch (error) {
    container.replaceChildren(errorBlock(errorMessage(error)));
  }
  renderTranscript();
}

function renderPrompt(prompt: Prompt): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = heading('');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = prompt.name;
  title.append(name);
  head.append(title);
  card.append(head);

  if (prompt.description) card.append(note(prompt.description));

  const inputs = new Map<string, HTMLInputElement>();
  const grid = document.createElement('div');
  grid.className = 'arg-grid';
  for (const arg of prompt.arguments ?? []) {
    const label = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = arg.name + (arg.required ? ' *' : '');
    const input = document.createElement('input');
    input.type = 'text';
    label.append(caption, input);
    if (arg.description) {
      const noteEl = document.createElement('span');
      noteEl.className = 'arg-note';
      noteEl.textContent = arg.description;
      label.append(noteEl);
    }
    inputs.set(arg.name, input);
    grid.append(label);
  }

  const actions = document.createElement('div');
  actions.className = 'actions span-2';
  const renderButton = document.createElement('button');
  renderButton.type = 'button';
  renderButton.textContent = 'Render prompt';
  actions.append(renderButton);
  grid.append(actions);
  card.append(grid);

  const result = document.createElement('div');
  result.className = 'result';
  card.append(result);

  renderButton.addEventListener('click', () => {
    void getPrompt(prompt, inputs, renderButton, result);
  });

  return card;
}

async function getPrompt(
  prompt: Prompt,
  inputs: Map<string, HTMLInputElement>,
  button: HTMLButtonElement,
  result: HTMLElement,
): Promise<void> {
  button.disabled = true;
  result.classList.remove('error');
  result.replaceChildren(note('Rendering…'));
  try {
    const args: Record<string, string> = {};
    for (const [key, input] of inputs) {
      const value = input.value.trim();
      if (value) args[key] = value;
    }
    const response = await client.getPrompt(prompt.name, args);
    result.replaceChildren();

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    const left = document.createElement('span');
    left.textContent = response.description ?? prompt.name;
    const right = document.createElement('span');
    right.textContent = `${response.messages.length} message(s)`;
    meta.append(left, right);
    result.append(meta);

    const spoken: string[] = [];
    for (const message of response.messages) {
      const pre = document.createElement('pre');
      pre.className = 'mono';
      const text = textOfContent(message.content);
      pre.textContent = `[${message.role}] ${text}`;
      result.append(pre);
      spoken.push(text);
    }
    // Every MCP result is read aloud, prompts included.
    await readAloud(spoken.join('\n\n'), voiceStatus, `Rendered ${prompt.name}`);
  } catch (error) {
    result.classList.add('error');
    result.replaceChildren(errorBlock(errorMessage(error)));
  } finally {
    button.disabled = false;
    renderTranscript();
  }
}

function textOfContent(content: ContentBlock): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'resource':
      return 'text' in content.resource
        ? content.resource.text
        : `[binary resource ${content.resource.mimeType ?? ''}]`.trim();
    case 'resource_link':
      return `[resource_link ${content.uri}]`;
    case 'image':
      return `[image ${content.mimeType}]`;
    case 'audio':
      return `[audio ${content.mimeType}]`;
    default:
      return '[non-text content]';
  }
}

/* ── Transcript ─────────────────────────────────────────────────────────── */

function renderTranscript(): void {
  transcriptList.replaceChildren();
  const entries = client.transcript;
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = 'No operations yet.';
    transcriptList.append(li);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = entry.direction;
    const arrow = entry.direction === 'out' ? '→' : entry.direction === 'in' ? '←' : '•';
    li.textContent = `${entry.at.slice(11, 19)}  ${arrow} ${entry.method}  ${entry.summary}`;
    transcriptList.append(li);
  }
}

function transcriptJson(): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      endpoint: urlField.value.trim(),
      deviceId: deviceField.value.trim(),
      server: lastHandshake
        ? {
            name: lastHandshake.name,
            version: lastHandshake.version,
            protocolVersion: lastHandshake.protocolVersion,
            sessionId: lastHandshake.sessionId,
            capabilities: lastHandshake.capabilities,
          }
        : null,
      operations: client.transcript,
    },
    null,
    2,
  );
}

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(transcriptJson());
    flash(copyButton, 'Copied');
  } catch {
    flash(copyButton, 'Copy failed');
  }
});

downloadButton.addEventListener('click', () => {
  const blob = new Blob([transcriptJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `globie-mcp-transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

/* ── Voice ──────────────────────────────────────────────────────────────── */

let stopListening: (() => void) | null = null;

/**
 * The live server-cascade recording, when the microphone is using the server's
 * ears instead of Web Speech. Exactly one of this and `stopListening` is set.
 */
let activeRecorder: Recorder | null = null;

/**
 * The attached photo as a data URL, or null. Kept between asks so a follow-up
 * about the same photo does not need it re-attached; the server refuses it
 * unless the selected model is the vision one.
 */
let attachedImage: string | null = null;

/**
 * A phone photo is several MB, and base64 adds a third on top - far over the
 * server's request body limit. Downscaling the largest edge to this keeps the
 * data URL small while staying legible to the model.
 */
const MAX_IMAGE_EDGE = 1024;

/** Reads and downscales a chosen file into a JPEG data URL. */
function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The photo could not be read.'));
    reader.onload = () => {
      const source = typeof reader.result === 'string' ? reader.result : '';
      if (!source) {
        reject(new Error('The photo could not be read.'));
        return;
      }
      const image = new Image();
      image.onerror = () => reject(new Error('That file is not an image this browser can decode.'));
      image.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('The photo could not be processed here.'));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      image.src = source;
    };
    reader.readAsDataURL(file);
  });
}

voiceImage.addEventListener('change', () => {
  const file = voiceImage.files?.[0];
  if (!file) {
    attachedImage = null;
    voiceImageNote.hidden = true;
    return;
  }
  setStatus(voiceStatus, 'Preparing the photo…');
  readImageFile(file)
    .then((dataUrl) => {
      attachedImage = dataUrl;
      voiceImageNote.hidden = false;
      voiceImageNote.textContent = `${file.name} attached — it goes with your next question, and only to the vision model.`;
      setStatus(voiceStatus, 'Photo ready. Pick the vision model, then ask.');
    })
    .catch((error: unknown) => {
      attachedImage = null;
      voiceImage.value = '';
      voiceImageNote.hidden = true;
      setStatus(voiceStatus, errorMessage(error), 'err');
    });
});

/* ── The server's self-hosted speech cascade ────────────────────────────── */

/**
 * What the server's /health said about its own ears and mouth. `null` means we
 * have not asked yet; `configured: false` means we asked and the server has no
 * cascade, so the browser's Web Speech API is the input path instead.
 */
let speechCascade: { configured: boolean; sttModel: string; ttsModel: string } | null = null;

/** Asks the server's /health whether it has a speech cascade, and with what. */
async function probeSpeech(): Promise<void> {
  try {
    const response = await fetch(new URL('/health', urlField.value.trim()).toString());
    if (!response.ok) {
      speechCascade = null;
      return;
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !isRecord(payload.speech)) {
      speechCascade = null;
      return;
    }
    const { configured, sttModel, ttsModel } = payload.speech;
    speechCascade = {
      configured: configured === true,
      sttModel: typeof sttModel === 'string' ? sttModel : '',
      ttsModel: typeof ttsModel === 'string' ? ttsModel : '',
    };
  } catch {
    // Best-effort: an unreachable /health is not an error, it just means the
    // panel reports the fallback path instead of the cascade.
    speechCascade = null;
  }
}

/** Which half of the browser does the listening, given what the server offers. */
function inputPath(): 'server' | 'browser' | 'none' {
  if (speechCascade?.configured && recorderSupport()) return 'server';
  if (speechSupport().input) return 'browser';
  return 'none';
}

/**
 * Says, honestly, which ears and mouth this session will use. Written from what
 * was actually probed, so it never credits the cascade with work the browser
 * is really doing.
 */
function renderVoiceSupport(): void {
  const path = inputPath();
  const support = speechSupport();
  const lines: string[] = [];

  if (path === 'server') {
    const stt = speechCascade?.sttModel ? ` (${speechCascade.sttModel})` : '';
    const tts = speechCascade?.ttsModel ? ` (${speechCascade.ttsModel})` : '';
    lines.push(`Your question is recorded here and transcribed by this server's own Whisper${stt}, so the audio never leaves it.`);
    lines.push(`Replies are read aloud by the server's own voice${tts}.`);
  } else if (path === 'browser') {
    lines.push(
      speechCascade
        ? 'This server has a speech cascade, but this browser cannot record audio, so recognition falls back to the Web Speech API.'
        : 'This server has no speech cascade, so recognition uses the Web Speech API.',
    );
    lines.push(support.output ? 'Replies are read aloud by the browser.' : 'This browser cannot read replies aloud; they are shown as text.');
  } else {
    lines.push('No speech input is available here — type your question instead.');
    if (speechCascade?.configured || support.output) lines.push('Replies are still read aloud.');
  }

  lines.push('This is not an Alexa wake word.');
  voiceSupportEl.textContent = lines.join(' ');
  micButton.disabled = path === 'none';
}

/* ── Talking to the server's ears and mouth ─────────────────────────────── */

/** The voice routes sit beside /mcp and /route, on the origin the user connected to. */
function voiceUrl(path: string): string {
  return new URL(path, urlField.value.trim()).toString();
}

/** The identity headers /mcp, /route and the /voice routes all accept. */
function voiceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Id': deviceField.value.trim(),
  };
  const bearer = tokenField.value.trim();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

/** Sends a recording to the server's ears and returns what it heard. */
async function transcribe(audio: string): Promise<string> {
  const response = await fetch(voiceUrl('/voice/transcribe'), {
    method: 'POST',
    headers: voiceHeaders(),
    body: JSON.stringify({ audio }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!isRecord(payload) || typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('The server heard no words in that recording.');
  }
  return payload.text.trim();
}

/** The audio element currently playing a server-synthesised reply, if any. */
let releaseRemote: (() => void) | null = null;

/** Stops a server-synthesised reply, if one is playing. */
function stopRemoteAudio(): void {
  releaseRemote?.();
  releaseRemote = null;
}

/** Asks the server's mouth for audio and plays it. */
async function speakRemote(text: string): Promise<boolean> {
  const response = await fetch(voiceUrl('/voice/speak'), {
    method: 'POST',
    headers: voiceHeaders(),
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const detail = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('The server synthesised no audio.');

  stopRemoteAudio();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const release = (): void => {
    audio.pause();
    audio.removeAttribute('src');
    URL.revokeObjectURL(url);
    stopButton.hidden = true;
    if (releaseRemote === release) releaseRemote = null;
  };
  releaseRemote = release;
  audio.onended = release;
  audio.onerror = release;

  stopButton.hidden = false;
  // play() rejects when the browser blocks autoplay; the caller reports that
  // rather than pretending the reply was read.
  await audio.play();
  return true;
}

/**
 * Reads a reply aloud with whichever mouth exists: the server's own voice when
 * the cascade is configured, the browser's synthesis otherwise.
 */
async function say(text: string): Promise<boolean> {
  if (!text.trim()) return false;
  if (speechCascade?.configured) {
    stopSpeaking();
    return speakRemote(text);
  }
  return speak(text, {
    onStart: () => {
      stopButton.hidden = false;
    },
    onEnd: () => {
      stopButton.hidden = true;
    },
  });
}

/**
 * Reads a freshly returned MCP result aloud, from whichever surface called it.
 *
 * Prefers the tool's own plain-language line (tagged `audience: ["user"]`) and
 * falls back to the text blocks, so a result that carries no spoken line is
 * still read rather than skipped. Reading is best-effort: a failure here is
 * reported on the status line, never on the result, because the tool call itself
 * already succeeded or failed on its own terms.
 */
async function speakResult(
  response: CallToolResult,
  status: HTMLElement,
  prefix: string,
): Promise<void> {
  const spoken = spokenTextsOf(response);
  const text = (spoken.length ? spoken : textsOf(response)).join('\n\n');
  await readAloud(text, status, prefix);
}

/**
 * Reads arbitrary result text aloud, from whichever surface produced it.
 *
 * Reading is best-effort: a mouth failure is reported on the status line, never
 * on the result, because the read itself already succeeded on its own terms.
 */
async function readAloud(text: string, status: HTMLElement, prefix: string): Promise<void> {
  if (!text.trim()) return;
  try {
    if (!(await say(text))) stopButton.hidden = true;
  } catch (error) {
    stopButton.hidden = true;
    setStatus(status, `${prefix}, but reading it aloud failed: ${errorMessage(error)}`, 'err');
  }
}

/**
 * The router's answer: which tool to call, with what, and in one line why.
 * `tool === null` means no offered tool can serve the request.
 */
interface RouteDecision {
  tool: string | null;
  arguments: Record<string, unknown>;
  rationale: string;
  /** The model the server actually routed with, echoed back for honesty. */
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a tool declares an `image` argument, i.e. it can read a photo. Read
 * from the schema the server advertises, so nothing here names describe_photo
 * directly - if the server offers any other photo-reading tool, it just works.
 */
function takesImageArgument(tool: Tool): boolean {
  const schema = tool.inputSchema;
  if (!isRecord(schema)) return false;
  const properties = schema.properties;
  return isRecord(properties) && 'image' in properties;
}

/**
 * Whether a tool declares an `entity_type` argument, i.e. it is a catalogue
 * search that can be narrowed to one source. Read from the advertised schema for
 * the same reason as takesImageArgument: the Source selector is only ever
 * filled into a call that actually accepts it (plan §17.5).
 */
function takesEntityTypeArgument(tool: Tool): boolean {
  const schema = tool.inputSchema;
  if (!isRecord(schema)) return false;
  const properties = schema.properties;
  return isRecord(properties) && 'entity_type' in properties;
}

/**
 * The router lives beside the MCP endpoint on the same origin: the server it is
 * self-hosted with answers `POST /route` exactly where it answers `/mcp`. The
 * page holds no model credential, so this is the only way it can decide.
 */
function routerUrl(): string {
  return new URL('/route', urlField.value.trim()).toString();
}

/** Asks the server's router which tool the utterance means. */
async function route(
  utterance: string,
  options: { model: string; image: string | null },
): Promise<RouteDecision> {
  const tools = advertisedTools.length ? advertisedTools : await client.listTools();
  advertisedTools = tools;

  // /route is gated by the same identity /mcp requires, so the host presents the
  // device id it connected with - and its demo bearer token, when it used one.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Id': deviceField.value.trim(),
  };
  const bearer = tokenField.value.trim();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const response = await fetch(routerUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      utterance,
      // The host names a model and, for the vision one, attaches a photo. It
      // never holds a key: the server owns the credential and the allowlist.
      model: options.model || undefined,
      image: options.image ?? undefined,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }),
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!isRecord(payload)) throw new Error('The router returned an unreadable decision.');

  return {
    tool: typeof payload.tool === 'string' ? payload.tool : null,
    arguments: isRecord(payload.arguments) ? payload.arguments : {},
    rationale: typeof payload.rationale === 'string' ? payload.rationale : '',
    model: typeof payload.model === 'string' ? payload.model : undefined,
  };
}

async function ask(): Promise<void> {
  if (!client.connected) {
    setStatus(voiceStatus, 'Connect first.', 'err');
    return;
  }
  const query = voiceQuery.value.trim();
  if (!query) {
    setStatus(voiceStatus, 'Type or speak a question first.', 'err');
    return;
  }

  askButton.disabled = true;
  voiceResult.classList.remove('error');
  voiceResult.replaceChildren();
  setStatus(voiceStatus, 'Choosing a tool…');
  try {
    const decision = await route(query, { model: voiceModel.value, image: attachedImage });
    if (!decision.tool) {
      const why = decision.rationale || 'No tool on this server matched that request.';
      // The rationale is the result; the status line only points at it, so the
      // same sentence is not printed twice.
      voiceResult.replaceChildren(note(why));
      setStatus(voiceStatus, 'No tool matched — see the note below.', 'err');
      return;
    }

    // The router only picks; it does not get to change state. A mutating tool
    // must still go through the confirmation checkbox on the Tools tab, so a
    // free-text request is sent there rather than acted on by voice.
    const chosen = advertisedTools.find((tool) => tool.name === decision.tool);
    if (chosen && isMutating(chosen)) {
      const noteText = `${decision.tool} changes state, so it needs the confirmation box on the Tools tab rather than a spoken command.`;
      voiceResult.replaceChildren(note(noteText));
      setStatus(voiceStatus, 'That tool changes state — see the note below.', 'err');
      return;
    }

    // A photo-reading tool needs the photo itself, and the router cannot put a
    // data URL in its answer - so the host fills the attached photo into any
    // chosen tool that declares an image argument. Without this the call would
    // fail the tool's own schema, which is the "no image was attached" answer
    // this flow exists to avoid.
    const args = { ...decision.arguments };
    if (chosen && attachedImage && takesImageArgument(chosen)) args.image = attachedImage;

    // The Source selector narrows a search to one DNP reference dataset. Filled
    // in the same guarded way as the photo - only into a tool that declares an
    // entity_type argument - and only when the listener picked a source, so an
    // unrelated call is never given a filter it cannot use (plan §17.5).
    const source = voiceSource.value.trim();
    if (chosen && source && takesEntityTypeArgument(chosen)) args.entity_type = source;

    setStatus(voiceStatus, `Calling ${decision.tool}…`);
    const response = await client.callTool(decision.tool, args);
    renderToolResult(voiceResult, decision.tool, response);
    const via = decision.model ? ` via ${decision.model}` : '';
    if (response.isError) {
      setStatus(voiceStatus, 'The tool returned an error; see the result below.', 'err');
      await speakResult(response, voiceStatus, `${decision.tool} returned an error`);
    } else {
      setStatus(voiceStatus, `Answered by ${decision.tool}${via}.`, 'ok');
      await speakResult(response, voiceStatus, `Answered by ${decision.tool}${via}`);
    }
  } catch (error) {
    voiceResult.classList.add('error');
    voiceResult.replaceChildren(errorBlock(errorMessage(error)));
    setStatus(voiceStatus, 'The router call failed — see below.', 'err');
  } finally {
    askButton.disabled = false;
    renderTranscript();
  }
}

/**
 * The microphone button, which is a toggle over two different sessions. With
 * the server's cascade it records until the listener says stop, then uploads;
 * with the Web Speech fallback it listens until the browser ends the session.
 * Exactly one of the two is ever live.
 */
micButton.addEventListener('click', () => {
  void toggleListening();
});

async function toggleListening(): Promise<void> {
  // A recording in progress: this click means "I have finished asking".
  if (activeRecorder) {
    const recorder = activeRecorder;
    activeRecorder = null;
    micButton.textContent = 'Speak';
    micButton.disabled = true;
    setStatus(voiceStatus, 'Transcribing on the server…');
    try {
      readyForSpeech();
      const text = await transcribe(await recorder.stop());
      voiceQuery.value = text;
      setStatus(voiceStatus, `Heard: “${text}”`);
      await ask();
    } catch (error) {
      setStatus(voiceStatus, errorMessage(error), 'err');
    } finally {
      micButton.disabled = inputPath() === 'none';
    }
    return;
  }

  // A Web Speech session in progress: stop it, as before.
  if (stopListening) {
    stopListening();
    stopListening = null;
    micButton.textContent = 'Speak';
    setStatus(voiceStatus, 'Stopped listening.');
    return;
  }

  // Preferred: the server's own ears, so the audio never leaves this machine.
  if (inputPath() === 'server') {
    try {
      activeRecorder = await startRecording();
      micButton.textContent = 'Stop';
      setStatus(voiceStatus, 'Recording… press Stop when you have finished your question.');
    } catch (error) {
      activeRecorder = null;
      micButton.disabled = true;
      setStatus(voiceStatus, errorMessage(error), 'err');
      micButton.disabled = inputPath() === 'none';
    }
    return;
  }

  // Fallback: the browser's own recognition.
  setStatus(voiceStatus, 'Listening… speak now.');
  const stop = startListening({
    onTranscript: (text, isFinal) => {
      voiceQuery.value = text;
      if (isFinal) setStatus(voiceStatus, 'Heard a question.');
    },
    onError: (text) => setStatus(voiceStatus, text, 'err'),
    onEnd: () => {
      stopListening = null;
      micButton.textContent = 'Speak';
      if (voiceQuery.value.trim()) void ask();
    },
  });

  if (!stop) {
    setStatus(voiceStatus, 'Speech recognition is unavailable here.', 'err');
    return;
  }
  stopListening = stop;
  micButton.textContent = 'Stop listening';
}

/** Silences any reply already playing, so a new question is not talked over. */
function readyForSpeech(): void {
  stopSpeaking();
  stopRemoteAudio();
  stopButton.hidden = true;
}

askButton.addEventListener('click', () => {
  void ask();
});

stopButton.addEventListener('click', () => {
  stopSpeaking();
  stopRemoteAudio();
  stopButton.hidden = true;
  setStatus(voiceStatus, 'Stopped reading.');
});

/* ── Boot ───────────────────────────────────────────────────────────────── */

urlField.value = defaultEndpoint();
deviceField.value = persistentDeviceId();
setConnectedState(false);
renderVoiceSupport();
selectTab('tools');
renderTranscript();
