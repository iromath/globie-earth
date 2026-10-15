// Openmind.Travel guide tools: country guides, airline guides, and YouTube
// video search. Wraps the public REST API at bokunapi.9o9.io.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openmindGet, openmindPost } from '../openmind/client.js';
import { errorResult, jsonResult } from './result.js';

export function registerOpenmindGuidesTools(server: McpServer): void {
  server.registerTool(
    'om_list_country_guides',
    {
      title: 'List Openmind country guides',
      description:
        'List all available country travel guides on Openmind.Travel (name, code, ' +
        'continent, image). Use this to discover which countries have a full guide.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await openmindGet<
          Array<{ name: string; code: string; continent: string; image: string }>
        >('/api/guides');

        const spoken = data.length
          ? `${data.length} country guide${data.length === 1 ? '' : 's'} available.`
          : 'No country guides available.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_country_guide',
    {
      title: 'Get an Openmind country guide',
      description:
        'Fetch a full country travel guide by ISO country code (e.g. "TH", "VN"). ' +
        'Returns a summary, key facts, sections, places to visit, top tours, ' +
        'YouTube videos, hero images, and sources. Use this to answer "tell me ' +
        'about <country>" with grounded, citation-backed content.',
      inputSchema: {
        countryCode: z
          .string()
          .min(2)
          .max(3)
          .describe('ISO 2-letter country code (case-insensitive), e.g. TH.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ countryCode }) => {
      const code = countryCode.trim().toUpperCase();
      if (!/^[A-Z]{2,3}$/.test(code)) {
        return errorResult('countryCode must be a 2-letter ISO code (e.g. TH, VN).');
      }
      try {
        const data = await openmindGet<{
          countryName: string;
          countryCode: string;
          summary: string;
          keyFacts?: {
            capital?: string;
            language?: string;
            currency?: string;
            population?: string;
          };
          sections: Array<{ title: string; content: string }>;
          placesToVisit: Array<{ name: string; description: string }>;
          topTours: Array<{ id: string; title: string; location: string }>;
          youtubeVideos: Array<{ videoId: string; title: string }>;
          sources?: string[];
        }>(`/api/country-guide/${encodeURIComponent(code)}`);

        const facts = data.keyFacts ?? {};
        const spoken =
          `${data.countryName}. ${data.summary.slice(0, 200)} ` +
          [facts.capital && `Capital: ${facts.capital}`, facts.language && `Language: ${facts.language}`, facts.currency && `Currency: ${facts.currency}`]
            .filter(Boolean)
            .join('. ');

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_search_youtube_videos',
    {
      title: 'Search Openmind YouTube videos',
      description:
        'Search YouTube for travel videos related to a query. Returns videoId, ' +
        'title, thumbnail, and channel info for embeddable videos. Use this to ' +
        'suggest video content alongside a country guide or trip plan.',
      inputSchema: {
        query: z.string().min(2).describe('Video search query.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const data = await openmindPost<
          Array<{ videoId: string; title: string; thumbnail: string; channelTitle: string }>
        >('/api/youtube/search', { query: query.trim() });

        const spoken = data.length
          ? `Found ${data.length} video${data.length === 1 ? '' : 's'}. Top: ${data[0].title} by ${data[0].channelTitle}.`
          : 'No videos found.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_list_airline_guides',
    {
      title: 'List Openmind airline guides',
      description:
        'List available airline guides (IATA code, name, logo, summary). Use this ' +
        'to discover airlines with a dedicated guide.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await openmindGet<
          Array<{ iata: string; name: string; logoUrl?: string; summary?: string }>
        >('/api/airline-guides');

        const spoken = data.length
          ? `${data.length} airline guide${data.length === 1 ? '' : 's'} available.`
          : 'No airline guides available.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_airline_guide',
    {
      title: 'Get an Openmind airline guide',
      description:
        'Fetch a full airline guide by IATA code (e.g. "TG", "EK"), including ' +
        'summary, key facts, home country, and main airports. Use this to answer ' +
        'questions about a specific airline.',
      inputSchema: {
        iata: z.string().min(2).max(3).describe('Airline IATA code (2-3 chars).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iata }) => {
      const code = iata.trim().toUpperCase();
      if (!/^[A-Z0-9]{2,3}$/.test(code)) {
        return errorResult('iata must be a 2-3 character IATA code (e.g. TG).');
      }
      try {
        const data = await openmindGet<{
          iata: string;
          name: string;
          summary?: string;
          keyFacts?: {
            homeCountry?: string;
            airlineType?: string;
            mainAirports?: string[];
            fleetSize?: number;
            destinations?: number;
          };
        }>(`/api/airline-guides/${encodeURIComponent(code)}`);

        const facts = data.keyFacts ?? {};
        const spoken =
          `${data.name} (${data.iata}). ${data.summary?.slice(0, 150) ?? ''} ` +
          [facts.homeCountry && `Home country: ${facts.homeCountry}`, facts.airlineType && `Type: ${facts.airlineType}`]
            .filter(Boolean)
            .join('. ');

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
