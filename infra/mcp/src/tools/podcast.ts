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
import { callProxy, publicUrl } from '../proxy.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult } from './result.js';

/** One feed as the podcast proxy emits it (infra/podcast/src/server.ts). */
export interface PodcastFeed {
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
export interface FeedList {
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

/** One episode as /v1/podcast/feeds/:id/episodes emits it. */
interface PodcastEpisode {
  id: number;
  title: string;
  /** The publisher's direct audio file URL (what a podcast app streams). */
  enclosureUrl: string;
  datePublished: string | null;
  durationSec: number | null;
  /** Per-episode cover art; falls back to the show's image. */
  image: string | null;
  feedId: number;
  feedTitle: string | null;
}

interface EpisodeList {
  episodes: PodcastEpisode[];
}

/** The /v1/podcast/audio response: a signed stream path relative to the proxy. */
interface StreamUrl {
  url: string;
}

export function registerPodcastTools(server: McpServer, caller: Caller): void {
  server.registerTool(
    'search_podcasts',
    {
      title: 'Search podcasts',
      description:
        'Searches the Globie Earth podcast library by show title and author, each result ' +
        'carrying its cover art, episode count and freshest episode. Every word in the ' +
        'query must match, so keep it to one or two words. Read-only.',
      inputSchema: {
        query: z.string().min(2).max(120).describe('What to search for, e.g. "forest" or "climate change".'),
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
        'Themes are the shelf\'s own curated words - meditation, forest, sustainability ' +
        'and the like - which are full-text topics, not the index\'s publisher categories. ' +
        'Read-only.',
      inputSchema: {
        theme: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A theme to list shows for, e.g. "forest" or "Forest". ' +
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

  server.registerTool(
    'get_podcast_episodes',
    {
      title: 'Get podcast episodes',
      description:
        'Lists the episodes of one podcast show, newest first. Each episode carries ' +
        'its title, the direct audio file URL (enclosureUrl), its per-episode cover ' +
        'image, publish date and duration. This needs the upstream podcast index; ' +
        'when it is not configured the tool says so instead of returning an empty ' +
        'list. Read-only.',
      inputSchema: {
        feedId: z
          .number()
          .int()
          .positive()
          .describe('The numeric Podcast Index feed id, from search_podcasts or get_trending_podcasts.'),
        max: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many episodes to return, newest first. Defaults to 20.'),
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only return episodes newer than this Unix timestamp. Omit for all.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: uiUriForTool('get_podcast_episodes') } },
    },
    async ({ feedId, max, since }) => {
      try {
        const params = new URLSearchParams();
        params.set('max', String(max ?? 20));
        if (since !== undefined) params.set('since', String(since));
        const { episodes } = await callProxy<EpisodeList>(
          'podcast',
          `/v1/podcast/feeds/${feedId}/episodes?${params.toString()}`,
          caller,
        );
        const top = episodes[0];
        const spoken = episodes.length
          ? `${episodes.length} ${episodes.length === 1 ? 'episode' : 'episodes'} for this show. The newest is "${top.title}"${
              top.durationSec !== null ? `, ${Math.round(top.durationSec / 60)} minutes` : ''
            }.`
          : 'This show has no episodes.';
        return jsonResult(
          {
            count: episodes.length,
            feedId,
            episodes,
            note: episodes.length ? null : 'This show has no episodes.',
          },
          spoken,
          {
            resourceUri: uiUriForTool('get_podcast_episodes'),
            invoking: 'Fetching episodes…',
            invoked: 'Podcast episodes',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_podcast_stream_url',
    {
      title: 'Get podcast stream URL',
      description:
        'Mints a signed, time-limited proxy-stream URL for one episode audio file. ' +
        'Use this when the publisher blocks direct playback of the enclosureUrl ' +
        '(hotlink protection, Cloudflare challenge, etc.): our server fetches the ' +
        'audio the way a podcast app would and streams it through. The URL expires ' +
        'after two hours. Read-only.',
      inputSchema: {
        enclosureUrl: z
          .string()
          .min(8)
          .max(2048)
          .describe('The episode audio file URL (enclosureUrl from get_podcast_episodes).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: uiUriForTool('get_podcast_stream_url') } },
    },
    async ({ enclosureUrl }) => {
      try {
        const { url } = await callProxy<StreamUrl>(
          'podcast',
          `/v1/podcast/audio?url=${encodeURIComponent(enclosureUrl)}`,
          caller,
        );
        // The proxy returns a path relative to itself; make it absolute against
        // the podcast public origin so any host can fetch it without knowing the
        // mapping. Falls back to the relative path if no public origin is set.
        const streamUrl = publicUrl('podcast', url) ?? url;
        return jsonResult(
          {
            enclosureUrl,
            streamUrl,
            expiresInSec: 7200,
          },
          `Here is a stream link for that episode, good for two hours.`,
          {
            resourceUri: uiUriForTool('get_podcast_stream_url'),
            invoking: 'Minting stream link…',
            invoked: 'Podcast stream URL',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
