// The live-web tool: Tavily search results for questions the site's own records
// cannot answer.
//
// The same keyless-external shape as registerWikiTools (tools/wiki.ts) - no
// caller, one public endpoint, a spoken line written for the ear - and it exists
// for the same reason that one does: the forest knowledge base, the cookbook and
// the site's own records cover the site and nothing else. A listener who asks
// about the news, another place, an event or any fact outside Globie needs the
// open web. What comes back is other people's pages, so every result keeps its
// own URL and the payload names the source as the open web - never as Globie's
// own verified record.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchWeb } from '../web.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult } from './result.js';

export function registerWebTools(server: McpServer): void {
  server.registerTool(
    'search_web',
    {
      title: 'Search the live web',
      description:
        'Live web search for what the Globie Earth records do not hold - current news, ' +
        'another place or organisation, an event, or any fact outside the site\'s own ' +
        'species, sites, guardian lore and Thai cookbook. Returns a short list of pages, ' +
        'each with its title, URL and snippet, plus a synthesised answer when one could ' +
        'be made. This is external web content via Tavily, not Globie\'s own verified ' +
        'record: name the open web as the source and never present a result as Globie ' +
        'data. For anything about the site itself use the site\'s own tools first ' +
        '(search_forest_knowledge, search_local_culture, get_sanctuary_conditions). ' +
        'Read-only.',
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(300)
          .describe('What to look up on the web, in plain words.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      // SEP-1865: name the MCP App that renders this tool.
      _meta: { ui: { resourceUri: uiUriForTool('search_web') } },
    },
    async ({ query }) => {
      try {
        const answer = await searchWeb(query);
        if (!answer) {
          return errorResult(
            `The web search for "${query}" came back empty or could not be run just now. ` +
              'Nothing is wrong with the Globie catalogue; try again shortly.',
          );
        }

        const top = answer.hits[0];
        // The synthesised answer is what a spoken turn leans on; when Tavily
        // made none, the first source's title still names what was found.
        const spoken = answer.answer
          ? `${answer.answer} That comes from the open web via Tavily, not from Globie's own records.`
          : `On the open web, the first result is "${top.title}", via Tavily - external content, not Globie's own records.`;

        return jsonResult(
          {
            query: answer.query,
            answer: answer.answer,
            results: answer.hits,
            // Stated in the payload as well as the description, so a machine
            // reader cannot mistake this for Globie's own verified data.
            source: 'Live web search via Tavily - external content, may be unverified',
          },
          spoken,
          {
            resourceUri: uiUriForTool('search_web'),
            invoking: 'Searching the web…',
            invoked: answer.query,
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
