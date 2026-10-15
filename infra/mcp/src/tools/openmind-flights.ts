// Openmind.Travel flight search and ground/sea transport tools.
//
// Flights use a two-step flow: POST to initiate (returns a search_id), then
// consume an SSE stream of result chunks. The stream can take up to ~90s.
// Transport returns booking/timetable deep links (the upstream timetable is
// HTML, not JSON).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openmindGet, openmindPost, openmindSse } from '../openmind/client.js';
import { errorResult, jsonResult } from './result.js';

const IATA_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface FlightLeg {
  departure: string;
  departure_time: string;
  departure_date: string;
  arrival: string;
  arrival_time: string;
  arrival_date: string;
  operating_carrier?: string;
  marketing_carrier?: string;
  number: string;
  duration: number;
}

interface FlightSegment {
  flight: FlightLeg[];
}

interface FlightProposal {
  sign: string;
  segment: FlightSegment[];
  total_duration: number;
  max_stops?: number;
  emissions_kg_per_pax?: number;
  typical_emissions_kg_per_pax?: number;
  terms: Record<string, { unified_price: number; url: string }>;
}

interface FlightChunk {
  proposals?: FlightProposal[];
  airlines?: Record<string, { name: string }>;
  airports?: Record<string, { city: string }>;
}

function cheapestPrice(p: FlightProposal): number | null {
  const prices = Object.values(p.terms ?? {})
    .map((t) => t?.unified_price)
    .filter((n): n is number => typeof n === 'number');
  return prices.length ? Math.min(...prices) : null;
}

function airlineName(p: FlightProposal, airlines: Record<string, { name: string }>): string {
  const leg = p.segment?.[0]?.flight?.[0];
  const iata = leg?.operating_carrier || leg?.marketing_carrier || '';
  return airlines[iata]?.name || iata || 'Unknown airline';
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const SUPPORTED_COUNTRIES = [
  'TH', 'VN', 'KH', 'LA', 'MM', 'MY', 'SG', 'ID', 'PH', 'IN', 'LK', 'NP', 'JP', 'CN',
] as const;

const TRANSPORT_CLASSES = ['train', 'bus', 'ferry', 'van', 'avia'] as const;

function slug(s: string): string {
  return s.trim().replace(/\s+/g, '-').toLowerCase();
}

export function registerOpenmindFlightsTools(server: McpServer): void {
  server.registerTool(
    'om_search_flights',
    {
      title: 'Search Openmind flights',
      description:
        'Search real flight options between two airports. Provide IATA codes, a ' +
        'departure date, and optional return date (for round-trips) plus passenger ' +
        'counts. Runs the full initiate-then-stream flow and returns the top ' +
        'options sorted by price. This can take up to ~90 seconds. Prices are ' +
        'returned in RUB as provided by the search provider.',
      inputSchema: {
        origin: z.string().length(3).describe('Departure airport IATA code (e.g. BKK).'),
        destination: z.string().length(3).describe('Arrival airport IATA code (e.g. CNX).'),
        departDate: z.string().describe('Departure date (YYYY-MM-DD).'),
        returnDate: z.string().optional().describe('Optional return date (YYYY-MM-DD) for round-trips.'),
        adults: z.number().int().optional().describe('Number of adults (default 1).'),
        children: z.number().int().optional().describe('Number of children (default 0).'),
        infants: z.number().int().optional().describe('Number of infants (default 0).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const originCode = input.origin.trim().toUpperCase();
      const destCode = input.destination.trim().toUpperCase();
      const departDate = input.departDate.trim();
      const returnDate = input.returnDate?.trim();

      if (!IATA_RE.test(originCode) || !IATA_RE.test(destCode)) {
        return errorResult('origin and destination must be 3-letter IATA codes (e.g. BKK).');
      }
      if (!DATE_RE.test(departDate)) {
        return errorResult('departDate must be YYYY-MM-DD.');
      }
      if (returnDate && !DATE_RE.test(returnDate)) {
        return errorResult('returnDate must be YYYY-MM-DD.');
      }

      const adults = Math.max(1, Math.floor(Number(input.adults) || 1));
      const children = Math.max(0, Math.floor(Number(input.children) || 0));
      const infants = Math.max(0, Math.floor(Number(input.infants) || 0));

      const segments = [{ origin: originCode, destination: destCode, date: departDate }];
      if (returnDate) {
        segments.push({ origin: destCode, destination: originCode, date: returnDate });
      }

      try {
        const initiated = await openmindPost<{ search_id?: string }>(
          '/api/flights/search/initiate',
          { segments, passengers: { adults, children, infants } },
        );
        if (!initiated.search_id) {
          return errorResult('No search_id returned from the flight search.');
        }

        const proposals = new Map<string, FlightProposal>();
        const airlines: Record<string, { name: string }> = {};
        const airports: Record<string, { city: string }> = {};

        await openmindSse<FlightChunk[]>(
          `/api/flights/search/stream-results?uuid=${encodeURIComponent(initiated.search_id)}`,
          (chunks) => {
            for (const chunk of Array.isArray(chunks) ? chunks : [chunks]) {
              Object.assign(airlines, chunk.airlines || {});
              Object.assign(airports, chunk.airports || {});
              for (const p of chunk.proposals || []) {
                if (p.sign) proposals.set(p.sign, p);
              }
            }
          },
        );

        const rows = Array.from(proposals.values())
          .map((p) => {
            const first = p.segment?.[0]?.flight?.[0];
            const lastSegment = p.segment?.[p.segment.length - 1];
            const last = lastSegment?.flight?.[lastSegment.flight.length - 1];
            const price = cheapestPrice(p);
            return {
              sign: p.sign,
              airline: airlineName(p, airlines),
              flightNumber: `${first?.marketing_carrier || ''} ${first?.number || ''}`.trim(),
              from: `${airports[first?.departure || '']?.city || first?.departure} (${first?.departure})`,
              to: `${airports[last?.arrival || '']?.city || last?.arrival} (${last?.arrival})`,
              departTime: first?.departure_time,
              arriveTime: last?.arrival_time,
              departDate: first?.departure_date,
              arriveDate: last?.arrival_date,
              duration: p.total_duration,
              stops: p.max_stops ?? 0,
              price,
              co2Emissions: p.emissions_kg_per_pax,
            };
          })
          .filter((r) => r.price != null)
          .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))
          .slice(0, 20);

        const spoken = rows.length
          ? `Found ${rows.length} flight option${rows.length === 1 ? '' : 's'}. Cheapest: ${rows[0].airline} ${rows[0].flightNumber}, ${rows[0].from} to ${rows[0].to}, ${formatDuration(rows[0].duration)}, ${rows[0].price} RUB.`
          : 'No flights found for this route and dates.';

        return jsonResult({ searchId: initiated.search_id, flights: rows }, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_flight_calendar',
    {
      title: 'Get Openmind flight price calendar',
      description:
        'Get a month of lowest daily flight prices (in USD) for a route. Use this ' +
        'to find the cheapest day to fly before running a full search. Returns a ' +
        'date → price map for the given month.',
      inputSchema: {
        origin: z.string().length(3).describe('Departure airport IATA code.'),
        destination: z.string().length(3).describe('Arrival airport IATA code.'),
        departMonth: z.string().describe('Month as YYYY-MM.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const originCode = input.origin.trim().toUpperCase();
      const destCode = input.destination.trim().toUpperCase();
      const month = input.departMonth.trim();

      if (!IATA_RE.test(originCode) || !IATA_RE.test(destCode)) {
        return errorResult('origin and destination must be 3-letter IATA codes.');
      }
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return errorResult('departMonth must be YYYY-MM.');
      }

      try {
        const data = await openmindGet<Record<string, { price: number }>>('/api/flights/calendar', {
          origin: originCode,
          destination: destCode,
          depart_date: month,
        });

        const entries = Object.entries(data)
          .map(([date, v]) => ({ date, price: v?.price }))
          .filter((e): e is { date: string; price: number } => typeof e.price === 'number')
          .sort((a, b) => a.price - b.price);

        const spoken = entries.length
          ? `Cheapest day: ${entries[0].date} at $${Math.round(entries[0].price)}.`
          : 'No calendar data available for this route and month.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_search_transport',
    {
      title: 'Search Openmind ground/sea transport',
      description:
        'Find ground/sea transport (train, bus, ferry, van, or flight) between two ' +
        'cities in supported Southeast/East Asia countries. Returns the ticket ' +
        'booking link and the timetable embed URL for the human to open. The ' +
        'timetable is HTML (not JSON), so this returns links rather than parsed ' +
        'routes. Supported country codes: TH, VN, KH, LA, MM, MY, SG, ID, PH, IN, ' +
        'LK, NP, JP, CN.',
      inputSchema: {
        country: z.string().length(2).describe('2-letter country code (e.g. TH for Thailand).'),
        from: z.string().min(1).describe('Origin city name (e.g. Bangkok).'),
        to: z.string().optional().describe('Optional destination city name (e.g. Chiang Mai).'),
        transportClass: z.enum(TRANSPORT_CLASSES).optional().describe('Optional transport type.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const country = input.country.trim().toUpperCase();
      const from = input.from.trim();
      const to = input.to?.trim() ?? '';
      const transportClass = input.transportClass?.toLowerCase() ?? '';

      if (!SUPPORTED_COUNTRIES.includes(country as (typeof SUPPORTED_COUNTRIES)[number])) {
        return errorResult(`country must be one of: ${SUPPORTED_COUNTRIES.join(', ')}.`);
      }
      if (!from) {
        return errorResult('from (origin city) is required.');
      }

      const bookingUrl = transportClass
        ? `https://ticket.openmind.travel/en/${transportClass}/${slug(from)}${to ? `/${slug(to)}` : ''}?z=266455`
        : `https://ticket.openmind.travel/en/travel/${slug(from)}${to ? `/${slug(to)}` : ''}?z=266455`;

      const timetableParams = new URLSearchParams({ country, from, lang: 'en', currency: 'USD' });
      if (to) timetableParams.set('to', to);
      if (transportClass) timetableParams.set('transportClass', transportClass);
      timetableParams.set('noreturn', '1');
      timetableParams.set('lesslinks', '0');
      const timetableUrl = `https://bokunapi.9o9.io/api/12go/timetable?${timetableParams.toString()}`;

      const spoken = `Transport search for ${from}${to ? ` to ${to}` : ''} (${country}). Open the booking link for live schedules and prices.`;

      return jsonResult(
        { country, from, to: to || undefined, transportClass: transportClass || undefined, bookingUrl, timetableUrl },
        spoken,
      );
    },
  );
}
