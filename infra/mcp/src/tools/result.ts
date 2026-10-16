// How a tool answers. Shared by every tool file so the shape cannot drift.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Names the MCP App that should render this result, per SEP-1865.
 *
 * `resourceUri` is a `ui://` resource (see src/ui/conditions.ts). A host that
 * understands the extension mounts that document in a sandboxed iframe; a host
 * that does not simply ignores `_meta.ui` and falls back to the JSON text
 * block, so the result degrades to data-only.
 */
export interface UiHint {
  resourceUri: string;
  /** Shown while the tool is still running. */
  invoking?: string;
  /** Shown once the result has landed. */
  invoked?: string;
}

/**
 * A JSON payload as the result, plus an optional plain-language line to read
 * aloud.
 *
 * The first text block is the JSON the app already produces, serialised rather
 * than re-worded: a host reads the same fields the screens do. When `spoken` is
 * given, a second text block carries a sentence written for the ear, tagged
 * `audience: ["user"]` so a speaking host reads *that* instead of the JSON -
 * which a voice would otherwise read out as braces, quotes and newlines. The
 * line has its whitespace collapsed so no line break ever reaches the mouth.
 *
 * When `ui` is given the result is *rich*: it also carries `structuredContent`
 * (the same fields, machine-readable) and `_meta.ui` naming the App to render.
 * That is the three-part shape the plan calls for - structured data, a text
 * block for the model, and a UI pointer - so one call serves both a widget-
 * capable host and a plain one.
 */
export function jsonResult(value: unknown, spoken?: string, ui?: UiHint): CallToolResult {
  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ];
  const line = spoken?.replace(/\s+/g, ' ').trim();
  if (line) {
    content.push({ type: 'text', text: line, annotations: { audience: ['user'] } });
  }
  const result: CallToolResult = { content };
  if (ui) {
    result.structuredContent = value as Record<string, unknown>;
    result._meta = { ui };
  }
  return result;
}

/**
 * A tool-level failure, as opposed to a protocol error.
 *
 * Returning `isError` lets the caller read *why* nothing came back, which a
 * JSON-RPC error would hide. A model can then tell "no matches" apart from
 * "the embedding provider is off".
 */
export function errorResult(error: unknown): CallToolResult {
  // A caller may hand over a ready-made explanation (a string) or a thrown
  // value. Both reach the model: an explanation the tool wrote on purpose is
  // more useful than any generic fallback, so a string is used verbatim.
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : 'The tool failed for an unknown reason.';
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * "Title: body" for the ear, with the name said once.
 *
 * A search hit's `title` and its `content` are two different strings and both
 * are spoken after a "the closest is", which reads well when the body is a
 * plain description - a keyword hit's content, say, which never names the dish.
 * A semantic hit is the other case: the passage the database stores opens with
 * the entity's own name (backfill-embeddings.mjs), so prefixing the title says
 * the name twice - "Green Curry with Chicken (Gaeng Keow Wan Gai): Green Curry
 * with Chicken (Gaeng Keow Wan Gai) ...". When the body already opens with the
 * title, the title is folded away and any bracket the passage repeats straight
 * after it (a romanised or Thai name the title already carries) is dropped too,
 * leaving the name once and the rest of the passage intact.
 */
export function closestLine(title: string, content: string): string {
  const name = title.trim();
  const body = content.trim();
  if (!name) return body;
  if (!body.toLowerCase().startsWith(name.toLowerCase())) {
    return `${name}: ${body}`;
  }
  let rest = body.slice(name.length);
  for (;;) {
    const bracket = rest.match(/^\s*\(([^)]*)\)/);
    if (!bracket || !name.toLowerCase().includes(bracket[1].toLowerCase())) break;
    rest = rest.slice(bracket[0].length);
  }
  rest = rest.replace(/^\s*[—–:,-]+\s*/, '').trim();
  return rest ? `${name}: ${rest}` : name;
}
