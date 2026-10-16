// The photo tool: any photo in, a plain description out.
//
// The router can only ever pick a tool that exists, so before this one a photo
// of something that was not a tree had nothing to match - every other tool
// answers from the site's own catalogue. This is the one tool that can
// look at an arbitrary image: it hands the photo to the vision model and
// returns what the model sees. It makes no claim about the site - the
// description is the model's reading of the image, and the result says so.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { chat, isImageInput, LlmError, providerConfigured, visionTarget } from '../llm.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult } from './result.js';

/** How long the vision model may take before the tool gives up. */
const TIMEOUT_MS = 30_000;

/** What to ask the model when the listener named no particular question. */
const DEFAULT_QUESTION = 'Describe this photo in detail.';

/** The instruction the vision model answers under. */
const SYSTEM_PROMPT = [
  'You are the eyes of the Globie Earth MCP server, a regenerative agroforestry site in Isaan, Thailand.',
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
        'Looks at a photo the listener attached and describes what is in it, using the vision ' +
        'model. Use this for any photo, not only trees: a plant, a landscape, an object, a room, ' +
        'a document - whatever the listener asks about. Read-only.',
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
      _meta: { ui: { resourceUri: uiUriForTool('describe_photo') } },
    },
    async ({ image, question }) => {
      try {
        const { provider, model } = visionTarget();
        if (!providerConfigured(provider)) {
          return errorResult(
            provider === 'nova'
              ? 'The photo tool is not configured for Nova. Set the Bedrock credentials ' +
                '(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or an AWS_BEARER_TOKEN_BEDROCK ' +
                'API key, and BEDROCK_REGION or AWS_REGION) in the MCP server environment.'
              : 'The photo tool is not configured. Set DEEPSEEK_API_KEY (and optionally ' +
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
        let result;
        try {
          result = await chat({
            provider,
            model,
            request: {
              system: SYSTEM_PROMPT,
              parts: [
                { type: 'text', text: asked },
                { type: 'image', url: image },
              ],
              temperature: 0,
            },
            timeoutMs: TIMEOUT_MS,
          });
        } catch (error) {
          if (!(error instanceof LlmError)) throw error;
          // Nothing was read; the message says which of the ways it failed.
          if (error.kind === 'timeout') {
            return errorResult(`The photo tool timed out after ${TIMEOUT_MS} ms.`);
          }
          if (error.kind === 'upstream') {
            // Covers both a refused model call and a photo URL the server could
            // not fetch: each says which, in `detail`.
            return errorResult(
              `The vision model call failed with ${error.status}. ${error.detail}`.trim(),
            );
          }
          return errorResult('The photo tool could not reach its vision model endpoint.');
        }

        const description = result.text.trim();
        const spoken = `Looking at the photo: ${description} That is the vision model's reading of the image, not the site catalogue.`;
        return jsonResult(
          {
            question: asked,
            description,
            model: result.model,
            // Said plainly: this is the model's reading of the image, not a fact
            // from the site's own catalogue.
            source: `${result.model} reading the attached photo (not the site catalogue)`,
          },
          spoken,
          {
            resourceUri: uiUriForTool('describe_photo'),
            invoking: 'Looking at the photo…',
            invoked: 'Photo description',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
