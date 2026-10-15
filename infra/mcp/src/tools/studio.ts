// The soundscape tools: queuing a generated piece through the studio proxy, and
// checking on one that is already rendering.
//
// The proxy holds the Gemini key and enforces the daily render quota; this server
// sees neither. A track renders asynchronously - one synchronous provider call
// that can take minutes - so queuing returns the track id and its status rather
// than blocking a voice turn on the render. `get_soundscape` then polls that
// track: the client shows the playable audio the moment the render turns ready.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Caller } from '../identity.js';
import { callProxy, publicUrl } from '../proxy.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult } from './result.js';

type TrackStatus = 'queued' | 'generating' | 'ready' | 'failed';

/** What POST /v1/studio/tracks answers with (infra/studio/src/server.ts). */
interface QueuedTrack {
  id: string;
  status: TrackStatus;
}

/** What GET /v1/studio/tracks/:id answers with (infra/studio/src/server.ts). */
interface StudioTrack {
  id: string;
  status: TrackStatus;
  title: string;
  durationSec: number | null;
  /** Relative to the studio origin, and only set once the render is ready. */
  audioUrl: string | null;
  error: string | null;
}

/** A sentence for the ear, written from the track's actual state. */
function spokenStatus(track: StudioTrack): string {
  const name = track.title ? `"${track.title}"` : 'Your soundscape';
  switch (track.status) {
    case 'ready':
      return `${name} is ready. Play it in the client to hear it.`;
    case 'failed':
      return `${name} could not be rendered.`;
    default:
      return `${name} is still rendering. It is not ready yet.`;
  }
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
      _meta: { ui: { resourceUri: uiUriForTool('generate_soundscape') } },
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
          {
            resourceUri: uiUriForTool('generate_soundscape'),
            invoking: 'Queuing the soundscape…',
            invoked: title ?? prompt.slice(0, 80),
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_soundscape',
    {
      title: 'Check a soundscape',
      description:
        'Checks a soundscape that generate_soundscape queued, by the track id it returned. ' +
        'Reports the current status and, once the render has finished, the audio URL to play. ' +
        'Read-only: it spends no quota and changes nothing, so it is safe to call repeatedly ' +
        'while a render is still running. Say a soundscape is ready only when this says ' +
        '"ready"; while it says "queued" or "generating" the audio does not exist yet.',
      inputSchema: {
        trackId: z.string().min(1).describe('The trackId that generate_soundscape returned.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: uiUriForTool('get_soundscape') } },
    },
    async ({ trackId }) => {
      try {
        const track = await callProxy<StudioTrack>(
          'studio',
          `/v1/studio/tracks/${encodeURIComponent(trackId)}`,
          caller,
        );
        return jsonResult(
          {
            trackId: track.id,
            status: track.status,
            title: track.title,
            durationSec: track.durationSec,
            // The studio answers with a path relative to itself; hand back the
            // full URL so the player needs no mapping of its own.
            audioUrl: publicUrl('studio', track.audioUrl),
            error: track.error,
          },
          spokenStatus(track),
          {
            resourceUri: uiUriForTool('get_soundscape'),
            invoking: 'Checking the soundscape…',
            invoked: track.title || 'Soundscape',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
