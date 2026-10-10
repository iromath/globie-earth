// The podcast tools: search and trending through the podcast proxy.
//
// Both are read-only. The proxy owns the Podcast Index credentials and the
// local FTS mirror, so this server holds neither key. Search reads the mirror
// and works without keys; trending needs the upstream index and says so when
// its keys are unset rather than returning an empty list as if it were an
// answer.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Caller } from '../identity.js';
import { callProxy } from '../proxy.js';
import { errorResult, jsonResult } from './result.js';

/** One feed as the podcast proxy emits it (infra/podcast/src/server.ts). */
interface PodcastFeed {
  id: number;
  url: string;
  title: string;
  author: string | null;
  link: string | null;
  image: string | null;
  language: string | null;
  categories: string[];
  episodeCount: number;
  popularityScore: number | null;
  newestItemAt: string | null;
  newestEnclosureUrl: string | null;
  newestEnclosureDurationSec: number | null;
  podcastGuid: string | null;
  itunesId: number | null;
  description: string | null;
}

/** Both read routes answer with the same envelope. */
interface FeedList {
  feeds: PodcastFeed[];
}

export function registerPodcastTools(server: McpServer, caller: Caller): void {
  server.registerTool(
    'search_podcasts',
    {
      title: 'Search podcasts',
      description:
        'Searches the Globie Earth podcast library for shows about reforestation, ' +
        'conservation and the living world, each with its episode count and freshest ' +
        'episode. Read-only.',
      inputSchema: {
        query: z.string().min(2).max(120).describe('What to search for, e.g. "soil carbon".'),
        max: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many shows to return. Defaults to 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, max }) => {
      try {
        const { feeds } = await callProxy<FeedList>(
          'podcast',
          `/v1/podcast/search?q=${encodeURIComponent(query)}&max=${max ?? 20}`,
          caller,
        );
        const top = feeds[0];
        const spoken = feeds.length
          ? `I found ${feeds.length} ${feeds.length === 1 ? 'show' : 'shows'} for "${query}". The top one is ${top.title}${top.author ? ` by ${top.author}` : ''}, with ${top.episodeCount} ${top.episodeCount === 1 ? 'episode' : 'episodes'}.`
          : `No shows matched "${query}".`;
        return jsonResult(
          {
            count: feeds.length,
            feeds,
            // An empty list is a real state, not a failure - say which one it is.
            note: feeds.length ? null : 'No shows matched that search.',
          },
          spoken,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_trending_podcasts',
    {
      title: 'Get trending podcasts',
      description:
        'Lists shows trending in the Globie Earth podcast library, optionally within one ' +
        'category. This needs the upstream podcast index; when it is not configured the tool ' +
        'says so instead of returning an empty list. Read-only.',
      inputSchema: {
        category: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('A category name to narrow to, e.g. "Science".'),
        max: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many shows to return. Defaults to 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ category, max }) => {
      try {
        const suffix = category ? `&cat=${encodeURIComponent(category)}` : '';
        const { feeds } = await callProxy<FeedList>(
          'podcast',
          `/v1/podcast/trending?max=${max ?? 20}${suffix}`,
          caller,
        );
        const top = feeds[0];
        const spoken = feeds.length
          ? `${feeds.length} ${feeds.length === 1 ? 'show is' : 'shows are'} trending${category ? ` in ${category}` : ''}. The top one is ${top.title}${top.author ? ` by ${top.author}` : ''}, with ${top.episodeCount} ${top.episodeCount === 1 ? 'episode' : 'episodes'}.`
          : `Nothing is trending${category ? ` in ${category}` : ''} right now.`;
        return jsonResult(
          {
            count: feeds.length,
            feeds,
            note: feeds.length ? null : 'Nothing is trending right now.',
          },
          spoken,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
