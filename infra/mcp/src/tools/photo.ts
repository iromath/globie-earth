// The photo tool: any photo in, a plain description out.
//
// The router can only ever pick a tool that exists, so before this one a photo
// of something that was not a tree had nothing to match - every other tool
// answers from the sanctuary's own catalogue. This is the one tool that can
// look at an arbitrary image: it hands the photo to the vision model and
// returns what the model sees. It makes no claim about the sanctuary - the
// description is the model's reading of the image, and the result says so.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deepseekConfig, isImageInput, VISION_MODEL } from '../deepseek.js';
import { errorResult, jsonResult } from './result.js';

/** How long the vision model may take before the tool gives up. */
const TIMEOUT_MS = 30_000;

/** What to ask the model when the listener named no particular question. */
const DEFAULT_QUESTION = 'Describe this photo in detail.';

/** The instruction the vision model answers under. */
const SYSTEM_PROMPT = [
  'You are the eyes of the Globie Earth MCP server, a reforestation sanctuary in Isaan, Thailand.',
  'Describe the attached photo plainly and concretely: what is in it, and anything a listener',
  'would want pointed out. If it shows a tree, plant or landscape, name what you can; if it shows',
  'anything else - a room, an object, a document, a person - describe that instead. You read any',
  'photo, not only forest ones. Say when you are unsure rather than guessing, and keep it short.',
].join(' ');

export function registerPhotoTools(server: McpServer): void {
  server.registerTool(
    'describe_photo',
    {
      title: 'Describe a photo',
      description:
        'Looks at a photo the listener attached and describes what is in it. Use this for any ' +
        'photo, not only trees: a plant, a landscape, an object, a room, a document - whatever ' +
        'the listener asks about. The description comes from the vision model reading the image, ' +
        'not from the sanctuary catalogue, so say that when you report it. Read-only.',
      inputSchema: {
        image: z
          .string()
          .min(1)
          .describe(
            'The photo to look at, as a data:image/…;base64,… URL or an http(s) URL. The host ' +
              'fills this in from the file the listener attached.',
          ),
        question: z
          .string()
          .max(500)
          .optional()
          .describe('What to ask about the photo. Defaults to a full description.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ image, question }) => {
      try {
        const { baseUrl, apiKey } = deepseekConfig();
        if (!apiKey) {
          return errorResult(
            'The photo tool is not configured. Set DEEPSEEK_API_KEY (and optionally ' +
              'DEEPSEEK_BASE_URL) in the MCP server environment.',
          );
        }
        if (!isImageInput(image)) {
          return errorResult(
            'That is not a photo this tool can read. It needs a data:image/…;base64,… URL or ' +
              'an http(s) URL to an image.',
          );
        }

        const asked = question?.trim() || DEFAULT_QUESTION;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let upstream: Response;
        try {
          upstream = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: VISION_MODEL,
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: asked },
                    { type: 'image_url', image_url: { url: image } },
                  ],
                },
              ],
              temperature: 0,
            }),
            signal: controller.signal,
          });
        } catch {
          // The fetch rejected because the controller fired or the host was
          // unreachable; either way nothing was read, and the message says so.
          return errorResult(
            controller.signal.aborted
              ? `The photo tool timed out after ${TIMEOUT_MS} ms.`
              : `The photo tool could not reach ${baseUrl}.`,
          );
        } finally {
          clearTimeout(timer);
        }

        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => '');
          return errorResult(
            `The vision model endpoint returned ${upstream.status}. ${detail.slice(0, 300)}`.trim(),
          );
        }

        const payload = (await upstream.json().catch(() => null)) as
          | { choices?: { message?: { content?: unknown } }[] }
          | null;
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          return errorResult('The vision model returned no description.');
        }

        const description = content.trim();
        const spoken = `Looking at the photo: ${description} That is the vision model's reading of the image, not the sanctuary catalogue.`;
        return jsonResult(
          {
            question: asked,
            description,
            model: VISION_MODEL,
            // Said plainly: this is the model's reading of the image, not a fact
            // from the sanctuary's own catalogue.
            source: `${VISION_MODEL} reading the attached photo (not the sanctuary catalogue)`,
          },
          spoken,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
