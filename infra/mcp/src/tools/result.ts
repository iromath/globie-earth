// How a tool answers. Shared by every tool file so the shape cannot drift.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
 */
export function jsonResult(value: unknown, spoken?: string): CallToolResult {
  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ];
  const line = spoken?.replace(/\s+/g, ' ').trim();
  if (line) {
    content.push({ type: 'text', text: line, annotations: { audience: ['user'] } });
  }
  return { content };
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
