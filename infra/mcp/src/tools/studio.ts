// The soundscape tool: queuing a generated piece through the studio proxy.
//
// The proxy holds the Gemini key and enforces the daily render quota; this server
// sees neither. A track renders asynchronously - one synchronous provider call
// that can take minutes - so the tool returns the track id and its status rather
// than blocking a voice turn on the render.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Caller } from '../identity.js';
import { callProxy } from '../proxy.js';
import { errorResult, jsonResult } from './result.js';

/** What POST /v1/studio/tracks answers with (infra/studio/src/server.ts). */
interface QueuedTrack {
  id: string;
  status: 'queued' | 'generating' | 'ready' | 'failed';
}

export function registerStudioTools(server: McpServer, caller: Caller): void {
  server.registerTool(
    'generate_soundscape',
    {
      title: 'Generate a soundscape',
      description:
        'Queues a generated piece of music for the sanctuary - for example an ambient ' +
        'soundscape for a species or a site. This CHANGES STATE and spends the shared daily ' +
        'render quota, so ask before calling it. Rendering is asynchronous: the tool returns ' +
        'a track id and a status of "queued", and the audio becomes available later. It does ' +
        'not return a finished recording, so never report that the soundscape is ready.',
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(600)
          .describe('What the piece should evoke, e.g. "a slow dawn chorus over a wetland".'),
        style: z
          .string()
          .min(1)
          .max(200)
          .describe('The musical style, e.g. "ambient field recording with bamboo flute".'),
        title: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe('A title for the track. Defaults to the opening of the prompt.'),
        durationSec: z
          .number()
          .int()
          .min(1)
          .max(480)
          .optional()
          .describe('Target length in seconds.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, style, title, durationSec }) => {
      try {
        const queued = await callProxy<QueuedTrack>('studio', '/v1/studio/tracks', caller, {
          method: 'POST',
          body: {
            // The proxy requires a title within 80 characters; the opening of
            // the prompt is the honest fallback when the host has none.
            title: title ?? prompt.slice(0, 80),
            prompt,
            style,
            instrumental: true,
            durationSec: durationSec ?? null,
          },
        });

        const spoken = `Your soundscape "${title ?? prompt.slice(0, 80)}" is queued and rendering in the background. It is not ready yet.`;
        return jsonResult(
          {
            trackId: queued.id,
            status: queued.status,
            note:
              'The soundscape is queued and renders asynchronously. It is not ready yet - ' +
              'say it has been queued, not that it has been produced.',
          },
          spoken,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
