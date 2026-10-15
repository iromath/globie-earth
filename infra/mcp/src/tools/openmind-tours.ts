// Openmind.Travel tour tools: search, facets, single tour, volunteer projects,
// partners, and cross-catalog suggestions. Wraps the public REST API at
// bokunapi.9o9.io — the same endpoints the web app's WebMCP tools call.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openmindGet } from '../openmind/client.js';
import { errorResult, jsonResult } from './result.js';

const SORT_OPTIONS = ['price_asc', 'price_desc', 'rating'] as const;
const PROVIDERS = ['all', 'Viator', 'Bókun'] as const;

function tourPrice(t: { priceUsd?: number; price?: number }): string {
  if (t.priceUsd != null) return `$${Math.round(t.priceUsd)}`;
  if (t.price != null) return `$${t.price}`;
  return 'Price n/a';
}

export function registerOpenmindToursTools(server: McpServer): void {
  server.registerTool(
    'om_search_tours',
    {
      title: 'Search Openmind tours',
      description:
        'Search the Openmind.Travel tour catalog (Viator + Bókun responsible-travel ' +
        'experiences). Supports free-text search plus filters for price, rating, ' +
        'donation level, category, country, duration, family-friendly, private ' +
        'experiences, and provider. Use this to discover or shortlist experiences ' +
        'before showing the user options.',
      inputSchema: {
        search: z.string().optional().describe('Free-text keywords.'),
        maxPrice: z.number().optional().describe('Maximum price in USD.'),
        minRating: z.number().optional().describe('Minimum rating (0-5).'),
        minDonation: z.number().optional().describe('Minimum donation percentage (0-100).'),
        sortBy: z.enum(SORT_OPTIONS).optional().describe('Sort order.'),
        categories: z.string().optional().describe('Comma-separated category names.'),
        countries: z.string().optional().describe('Comma-separated ISO country codes (e.g. TH, VN).'),
        durations: z.string().optional().describe('Comma-separated duration filters.'),
        familyFriendly: z.boolean().optional().describe('Only family-friendly experiences.'),
        privateTour: z.boolean().optional().describe('Only private experiences.'),
        provider: z.enum(PROVIDERS).optional().describe('Filter by provider.'),
        page: z.number().int().optional().describe('Page number (1-based).'),
        limit: z.number().int().optional().describe('Results per page (1-50, default 10).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const page = Math.max(1, Math.floor(Number(input.page) || 1));
        const limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit) || 10)));

        const params: Record<string, unknown> = { page, limit };
        if (input.search) params.search = input.search.trim();
        if (typeof input.maxPrice === 'number' && input.maxPrice >= 0) params.maxPrice = input.maxPrice;
        if (typeof input.minRating === 'number') params.minRating = input.minRating;
        if (typeof input.minDonation === 'number') params.minDonation = input.minDonation;
        if (input.sortBy) params.sortBy = input.sortBy;
        if (input.categories) params.categories = input.categories;
        if (input.countries) params.countries = input.countries;
        if (input.durations) params.durations = input.durations;
        if (typeof input.familyFriendly === 'boolean') params.familyFriendly = input.familyFriendly;
        if (typeof input.privateTour === 'boolean') params.privateTour = input.privateTour;
        if (input.provider) params.provider = input.provider;

        const data = await openmindGet<{
          tours: Array<{
            id: string;
            title: string;
            location: string;
            rating?: number;
            reviews?: number;
            price?: number;
            priceUsd?: number;
            duration?: string;
            description?: string;
            agency?: string;
            category?: string;
            sourceProvider?: string;
            productUrl?: string;
          }>;
          total: number;
          hasMore: boolean;
        }>('/api/tours', params);

        const spoken = data.tours.length
          ? `Found ${data.total} tour${data.total === 1 ? '' : 's'}. Top result: ${data.tours[0].title} in ${data.tours[0].location}, ${tourPrice(data.tours[0])}.`
          : 'No tours match those filters.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_tour_facets',
    {
      title: 'List Openmind tour facets',
      description:
        'List the available tour facets (countries, categories, price stats) on ' +
        'Openmind.Travel. Use this to discover valid filter values before calling ' +
        'om_search_tours.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await openmindGet<{
          countries: Array<{ country_code?: string; count?: number }>;
          categories: Array<{ category?: string; count?: number }>;
          priceStats?: { min?: number; max?: number; median?: number; p90?: number };
        }>('/api/tours/facets');

        const countryCount = data.countries?.length ?? 0;
        const categoryCount = data.categories?.length ?? 0;
        const spoken = `${countryCount} countries and ${categoryCount} categories available.`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_tour',
    {
      title: 'Get an Openmind tour',
      description:
        'Fetch full details for a single tour by id, including description, ' +
        'itinerary, agency, images, and booking link. Use this when the user has ' +
        'selected a specific experience from a search result.',
      inputSchema: {
        id: z.string().min(1).describe('The tour id (from om_search_tours).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const data = await openmindGet<{
          id: string;
          title: string;
          location: string;
          rating?: number;
          reviews?: number;
          price?: number;
          priceUsd?: number;
          duration?: string;
          description?: string;
          agency?: string;
          productUrl?: string;
        }>(`/api/tours/${encodeURIComponent(id)}`);

        const spoken = `${data.title} in ${data.location}. ${data.duration ? `Duration ${data.duration}. ` : ''}${tourPrice(data)}.`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_list_volunteer_projects',
    {
      title: 'List Openmind volunteer projects',
      description:
        'List OpenmindProjects volunteer and social-impact projects (educational ' +
        'camps, learning centers) that travelers can support or join. Use this to ' +
        'surface responsible-travel / volunteering opportunities alongside tours.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await openmindGet<
          Array<{
            id: string;
            slug: string;
            name: string;
            locationName: string;
            country: string;
            themes: string[];
            shortDescription: string;
            stats: { participants: number; trainers: number; volunteers: number };
          }>
        >('/api/projects');

        const spoken = data.length
          ? `${data.length} volunteer project${data.length === 1 ? '' : 's'} available: ${data.slice(0, 3).map((p) => p.name).join(', ')}.`
          : 'No volunteer projects available.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_partner',
    {
      title: 'Get an Openmind partner',
      description:
        'Fetch a partner/agency profile by slug (e.g. "viator" or "bokun"), ' +
        'including its description and its tours. Use this to explain who provides ' +
        'a given set of experiences.',
      inputSchema: {
        slug: z.string().min(1).describe('Partner slug (e.g. viator, bokun).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ slug }) => {
      try {
        const data = await openmindGet<{
          slug: string;
          name: string;
          description: string;
          tours: Array<{ id: string; title: string; location: string; price?: number; priceUsd?: number }>;
        }>(`/api/partners/${encodeURIComponent(slug)}`);

        const spoken = `${data.name}: ${data.description.slice(0, 120)}. ${data.tours.length} tours available.`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_search_suggestions',
    {
      title: 'Search Openmind suggestions',
      description:
        'Run a single free-text query against destinations, tours, and categories ' +
        'at once (type-ahead style). Use this to quickly discover what matches a ' +
        'word or phrase across the whole catalog.',
      inputSchema: {
        q: z.string().min(2).describe('Query text (at least 2 characters).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ q }) => {
      try {
        const data = await openmindGet<{
          destinations: Array<{ name: string; details?: string }>;
          tours: Array<{ name: string; details?: string }>;
          categories: Array<{ name: string }>;
        }>('/api/search/suggestions', { q });

        const total = data.destinations.length + data.tours.length + data.categories.length;
        const spoken = `${total} suggestion${total === 1 ? '' : 's'} across destinations, tours, and categories.`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
