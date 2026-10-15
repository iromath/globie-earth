// Openmind.Travel destination discovery tools: destination search, categories,
// countries, popular destinations, and airport autocomplete. Wraps the public
// REST API at bokunapi.9o9.io.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openmindGet } from '../openmind/client.js';
import { errorResult, jsonResult } from './result.js';

export function registerOpenmindDestinationsTools(server: McpServer): void {
  server.registerTool(
    'om_search_destinations',
    {
      title: 'Search Openmind destinations',
      description:
        'Resolve a free-text place name (e.g. "Bangkok", "Thai", "Paris") into ' +
        'structured destinations with a stable destinationId, name, type ' +
        '(COUNTRY/CITY/REGION), and details. Use this before searching tours or ' +
        'planning a trip so the agent works with a real destination id.',
      inputSchema: {
        query: z.string().min(2).describe('Free-text place name. Must be at least 2 characters.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const data = await openmindGet<
          Array<{ destinationId: number; name: string; details: string; type: string }>
        >('/api/destinations/search', { q: query.trim() });

        const spoken = data.length
          ? `Found ${data.length} destination${data.length === 1 ? '' : 's'}. Top: ${data[0].name} (${data[0].type}).`
          : 'No destinations found.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_list_categories',
    {
      title: 'List Openmind tour categories',
      description:
        'List the available tour categories on Openmind.Travel. Use this to ' +
        'discover valid `categories` filter values for om_search_tours.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await openmindGet<string[]>('/api/categories');

        const spoken = data.length
          ? `${data.length} categor${data.length === 1 ? 'y' : 'ies'} available.`
          : 'No categories available.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_list_countries',
    {
      title: 'List Openmind countries',
      description:
        'List supported countries (ISO code -> name) on Openmind.Travel. Use this ' +
        'to map a country name to its code for country filters and guides.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await openmindGet<Record<string, string>>('/api/countries');

        const entries = Object.entries(data);
        const spoken = entries.length
          ? `${entries.length} countr${entries.length === 1 ? 'y' : 'ies'} supported.`
          : 'No countries available.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_popular_destinations',
    {
      title: 'Get Openmind popular destinations',
      description:
        'List curated popular travel destinations with images. Use this to ' +
        'suggest well-known places to a user who has no specific destination in mind.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await openmindGet<
          Array<{ name: string; country: string; countryCode: string; destinationId: number; image: string }>
        >('/api/popular-destinations');

        const spoken = data.length
          ? `${data.length} popular destination${data.length === 1 ? '' : 's'}.`
          : 'No popular destinations available.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_autocomplete_airport',
    {
      title: 'Autocomplete Openmind airports',
      description:
        'Resolve a partial airport/city name into IATA airport codes. Use this ' +
        'to find the correct origin/destination codes before a flight search.',
      inputSchema: {
        query: z.string().min(2).describe('Partial city, airport, or country name.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const data = await openmindGet<
          Array<{ name: string; code: string; type: string; country: string; country_code: string }>
        >('/api/autocomplete/cities', { q: query.trim() });

        const spoken = data.length
          ? `Found ${data.length} airport${data.length === 1 ? '' : 's'}. Top: ${data[0].name} (${data[0].code}).`
          : 'No airports found.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
