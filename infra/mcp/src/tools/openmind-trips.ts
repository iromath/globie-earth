// Openmind.Travel trip planning tools: AI trip planner, trip ideas, and saved
// itineraries. Wraps the public REST API at bokunapi.9o9.io. The write tools
// (save_trip_idea, save_itinerary) persist to the upstream database; read tools
// are readOnlyHint.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openmindGet, openmindPost } from '../openmind/client.js';
import { errorResult, jsonResult } from './result.js';

export function registerOpenmindTripsTools(server: McpServer): void {
  server.registerTool(
    'om_plan_trip',
    {
      title: 'Plan a trip with Openmind',
      description:
        'Generate a full multi-day travel plan using Openmind.Travel tours and ' +
        'volunteer programs. Provide destination names, travel dates, a traveler ' +
        'type, and optional interests/budget/pace. Returns a headline, weather and ' +
        'currency info, advice, a day-by-day itinerary of real tours, recommended ' +
        'flights, and YouTube videos. This call can take a while. Use it when the ' +
        'user asks to plan a trip; then present the result and offer to save it.',
      inputSchema: {
        destinations: z
          .array(z.string())
          .min(1)
          .describe('Destination city/country names, e.g. ["Bangkok", "Chiang Mai"].'),
        dates: z
          .array(z.string())
          .min(1)
          .describe('ISO travel dates (YYYY-MM-DD); length determines trip days.'),
        tripType: z.string().min(1).describe('Traveler type, e.g. Solo traveler, Couple, Family, Backpacker.'),
        interests: z.array(z.string()).optional().describe('Optional interests, e.g. ["food", "temples", "nature"].'),
        description: z.string().optional().describe('Optional free-text trip description.'),
        budget: z.number().optional().describe('Optional total budget.'),
        currency: z.string().optional().describe('Optional budget currency code (e.g. USD).'),
        partySize: z.number().optional().describe('Optional number of travelers.'),
        accessibility: z.string().optional().describe('Optional accessibility needs.'),
        pace: z.string().optional().describe('Optional travel pace (e.g. relaxed, fast).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const destinations = input.destinations.filter((d) => d.trim());
      const dates = input.dates.filter((d) => d.trim());
      const tripType = input.tripType.trim();

      if (destinations.length === 0) return errorResult('destinations must be a non-empty array of names.');
      if (dates.length === 0) return errorResult('dates must be a non-empty array of ISO date strings.');
      if (!tripType) return errorResult('tripType is required.');

      const body: Record<string, unknown> = {
        destinations: destinations.map((name) => ({ name })),
        dates,
        tripType: { type: tripType },
      };
      if (input.interests) body.interests = input.interests.filter((i) => i.trim());
      if (input.description?.trim()) body.description = input.description.trim();
      if (typeof input.budget === 'number') body.budget = input.budget;
      if (input.currency?.trim()) body.currency = input.currency.trim();
      if (typeof input.partySize === 'number') body.partySize = input.partySize;
      if (input.accessibility?.trim()) body.accessibility = input.accessibility.trim();
      if (input.pace?.trim()) body.pace = input.pace.trim();

      try {
        const data = await openmindPost<{
          headline: string;
          info?: { weather?: string; currency?: string };
          advice?: string;
          itinerary: Array<{
            day: number;
            theme?: string;
            morning: Array<{ title: string }>;
            afternoon: Array<{ title: string }>;
            evening: Array<{ title: string }>;
          }>;
        }>('/api/ai/plan-trip', body);

        const spoken =
          `${data.headline}. ` +
          (data.info?.weather ? `Weather: ${data.info.weather}. ` : '') +
          (data.info?.currency ? `Currency: ${data.info.currency}. ` : '') +
          `${data.itinerary.length} day${data.itinerary.length === 1 ? '' : 's'} planned.`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_list_trip_ideas',
    {
      title: 'List Openmind trip ideas',
      description:
        'List saved trip ideas (community-created travel plans). Use this to browse ' +
        'pre-made plans before planning a custom trip.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await openmindGet<
          Array<{ id: string; headline: string; plan?: { destination?: string } }>
        >('/api/trip-ideas');

        const spoken = data.length
          ? `${data.length} trip idea${data.length === 1 ? '' : 's'} available.`
          : 'No trip ideas yet.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_trip_idea',
    {
      title: 'Get an Openmind trip idea',
      description: 'Fetch a single saved trip idea by id, including its itinerary and advice.',
      inputSchema: {
        id: z.string().min(1).describe('Trip idea id (from om_list_trip_ideas).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const data = await openmindGet<{
          id: string;
          headline: string;
          advice?: string;
          itinerary?: Array<{ day: number }>;
        }>(`/api/trip-ideas/${encodeURIComponent(id)}`);

        const spoken = `${data.headline}. ${(data.itinerary ?? []).length} day(s) in the itinerary.`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_save_trip_idea',
    {
      title: 'Save an Openmind trip idea',
      description:
        'Persist a trip idea (e.g. the result of om_plan_trip) to the community trip ' +
        'ideas feed. Use this after the user approves a generated plan and wants to ' +
        'keep it. This writes to the database.',
      inputSchema: {
        headline: z.string().min(1).describe('Trip idea title.'),
        plan: z
          .object({ destination: z.string().optional(), countryCode: z.string().optional() })
          .describe('Plan summary, at least { destination: string }.'),
        advice: z.string().optional().describe('Optional travel advice markdown.'),
        itinerary: z.array(z.any()).optional().describe('Optional day-by-day itinerary.'),
        info: z.any().optional().describe('Optional weather/currency info.'),
        recommendedFlights: z.array(z.any()).optional().describe('Optional recommended flights.'),
        youtubeVideos: z.array(z.any()).optional().describe('Optional related videos.'),
      },
      annotations: { openWorldHint: true },
    },
    async (input) => {
      try {
        const data = await openmindPost<{ id: string; headline: string }>('/api/trip-ideas', {
          headline: input.headline,
          plan: input.plan,
          advice: input.advice,
          itinerary: input.itinerary,
          info: input.info,
          recommendedFlights: input.recommendedFlights,
          youtubeVideos: input.youtubeVideos,
        });

        const spoken = `Saved trip idea "${data.headline}" (${data.id}).`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_itinerary',
    {
      title: 'Get an Openmind itinerary',
      description:
        'Fetch a saved detailed itinerary by id (tripId), including its plan, ' +
        'headline, and items.',
      inputSchema: {
        id: z.string().min(1).describe('Itinerary id (tripId).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const data = await openmindGet<{
          tripId?: string;
          plan?: { destination?: string };
          headline?: string;
          items?: unknown[];
        }>(`/api/itineraries/${encodeURIComponent(id)}`);

        const spoken = `${data.headline ?? 'Itinerary'}. ${(data.items ?? []).length} item(s).`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_save_itinerary',
    {
      title: 'Save an Openmind itinerary',
      description:
        'Persist a detailed itinerary (plan + headline + items). Use this after the ' +
        'user finalizes their day-by-day plan. This writes to the database.',
      inputSchema: {
        headline: z.string().min(1).describe('Itinerary title.'),
        plan: z
          .object({ destination: z.string().optional() })
          .describe('Plan summary, at least { destination: string }.'),
        items: z.array(z.any()).min(1).describe('Itinerary items (days/activities).'),
      },
      annotations: { openWorldHint: true },
    },
    async (input) => {
      try {
        const data = await openmindPost<{ tripId?: string; headline?: string }>('/api/itineraries', {
          headline: input.headline,
          plan: input.plan,
          items: input.items,
        });

        const spoken = `Saved itinerary "${data.headline}" (${data.tripId ?? 'saved'}).`;

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
