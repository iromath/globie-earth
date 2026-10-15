// The podcast tools: search, trending and themes through the podcast proxy.
//
// All are read-only. The proxy owns the Podcast Index credentials and the local
// FTS mirror, so this server holds neither key. Search and themes read the
// mirror and work without keys; trending needs the upstream index and says so
// when its keys are unset rather than returning an empty list as if it were an
// answer.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Caller } from '../identity.js';
import { callProxy } from '../proxy.js';
import { uiUriForTool } from '../ui/apps.js';
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
  /** Null from the upstream index, which does not always report a count. */
  episodeCount: number | null;
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

/** One listening theme as /v1/podcast/themes emits it (infra/podcast/src/themes.ts). */
interface PodcastTheme {
  theme: string;
  label: string;
}

interface ThemeList {
  themes: PodcastTheme[];
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
      _meta: { ui: { resourceUri: uiUriForTool('search_podcasts') } },
    },
    async ({ query, max }) => {
      try {
        const { feeds } = await callProxy<FeedList>(
          'podcast',
          `/v1/podcast/search?q=${encodeURIComponent(query)}&max=${max ?? 20}`,
          caller,
        );
        const top = feeds[0];
        // A count only when the source actually has one: the upstream index does
        // not always report episodeCount, and "with null episodes" is not English.
        const episodes =
          top && top.episodeCount !== null
            ? `, with ${top.episodeCount} ${top.episodeCount === 1 ? 'episode' : 'episodes'}`
            : '';
        const spoken = feeds.length
          ? `I found ${feeds.length} ${feeds.length === 1 ? 'show' : 'shows'} for "${query}". The top one is ${top.title}${top.author ? ` by ${top.author}` : ''}${episodes}.`
          : `No shows matched "${query}".`;
        return jsonResult(
          {
            count: feeds.length,
            feeds,
            // An empty list is a real state, not a failure - say which one it is.
            note: feeds.length ? null : 'No shows matched that search.',
          },
          spoken,
          {
            resourceUri: uiUriForTool('search_podcasts'),
            invoking: 'Searching the podcast library…',
            invoked: 'Podcast search',
          },
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
      _meta: { ui: { resourceUri: uiUriForTool('get_trending_podcasts') } },
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
        // Trending's feed objects carry no episodeCount, so the clause is dropped
        // rather than spoken as "with null episodes".
        const episodes =
          top && top.episodeCount !== null
            ? `, with ${top.episodeCount} ${top.episodeCount === 1 ? 'episode' : 'episodes'}`
            : '';
        const spoken = feeds.length
          ? `${feeds.length} ${feeds.length === 1 ? 'show is' : 'shows are'} trending${category ? ` in ${category}` : ''}. The top one is ${top.title}${top.author ? ` by ${top.author}` : ''}${episodes}.`
          : `Nothing is trending${category ? ` in ${category}` : ''} right now.`;
        return jsonResult(
          {
            count: feeds.length,
            feeds,
            note: feeds.length ? null : 'Nothing is trending right now.',
          },
          spoken,
          {
            resourceUri: uiUriForTool('get_trending_podcasts'),
            invoking: 'Fetching trending shows…',
            invoked: 'Trending shows',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_podcasts_by_theme',
    {
      title: 'Get podcasts by theme',
      description:
        'Explores the Globie Earth podcast library by listening theme. Called with no theme it ' +
        'lists the themes that exist; called with one it returns the shows matching that theme. ' +
        'Themes are the shelf\'s own curated words - meditation, eco-meditation, sustainability ' +
        'and the like - which are full-text topics, not the index\'s publisher categories. ' +
        'Read-only.',
      inputSchema: {
        theme: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A theme to list shows for, e.g. "eco-meditation" or "Eco-meditation". ' +
              'Omit it to list the available themes.',
          ),
        max: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many shows to return when a theme is given. Defaults to 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: uiUriForTool('get_podcasts_by_theme') } },
    },
    async ({ theme, max }) => {
      try {
        // No theme is a request for the list, not an error: it is how a voice
        // turn discovers what it could ask for next.
        if (!theme) {
          const { themes } = await callProxy<ThemeList>('podcast', '/v1/podcast/themes', caller);
          const labels = themes.map((entry) => entry.label);
          const spoken = labels.length
            ? `The listening themes are ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}.`
            : 'There are no listening themes right now.';
          return jsonResult({ count: themes.length, themes, note: null }, spoken, {
            resourceUri: uiUriForTool('get_podcasts_by_theme'),
            invoking: 'Listing listening themes…',
            invoked: 'Listening themes',
          });
        }

        const { feeds } = await callProxy<FeedList>(
          'podcast',
          `/v1/podcast/bytheme?theme=${encodeURIComponent(theme)}&max=${max ?? 20}`,
          caller,
        );
        const top = feeds[0];
        const episodes =
          top && top.episodeCount !== null
            ? `, with ${top.episodeCount} ${top.episodeCount === 1 ? 'episode' : 'episodes'}`
            : '';
        const spoken = feeds.length
          ? `I found ${feeds.length} ${feeds.length === 1 ? 'show' : 'shows'} for the ${theme} theme. The top one is ${top.title}${top.author ? ` by ${top.author}` : ''}${episodes}.`
          : `No shows matched the ${theme} theme.`;
        return jsonResult(
          {
            count: feeds.length,
            theme,
            feeds,
            note: feeds.length ? null : 'No shows matched that theme.',
          },
          spoken,
          {
            resourceUri: uiUriForTool('get_podcasts_by_theme'),
            invoking: 'Searching by theme…',
            invoked: `Theme: ${theme}`,
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
