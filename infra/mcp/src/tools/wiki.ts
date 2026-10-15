// The species encyclopaedia tool: Wikipedia context for one species, by name.
//
// It is the keyless-external shape of registerConditionsTools - no caller, one
// public endpoint, a spoken line written for the ear - and it exists because the
// forest knowledge base holds catalogue records, not prose: a listener who asks
// what a tree is *for* gets the encyclopaedia's lead paragraph here, with the
// attribution the CC BY-SA licence requires.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchWikiSummary } from '../wiki.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult } from './result.js';

export function registerWikiTools(server: McpServer): void {
  server.registerTool(
    'describe_species',
    {
      title: 'Describe a species from Wikipedia',
      description:
        'Encyclopaedic context for one plant or animal, read from the English Wikipedia lead ' +
        "section by its scientific or common name. Use it to say what a species is, where it " +
        'grows or lives and what it is used for, when the forest knowledge base holds only a ' +
        "catalogue record. This is external reference text, not Globie's own verified record: " +
        'it is licensed CC BY-SA 4.0 and may be incomplete or unverified, so always name ' +
        'Wikipedia as the source and never present it as Globie data. Returns nothing when ' +
        'Wikipedia has no article under that name. Read-only.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'The species to look up - its scientific name (e.g. "Dipterocarpus alatus") or ' +
              'an English common name (e.g. "Siamese rosewood").',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: uiUriForTool('describe_species') } },
    },
    async ({ name }) => {
      try {
        // `hostImage` stays off: a spoken turn has no need for the image bytes,
        // so the tool reports the freely-licensed lead image's metadata and its
        // Wikimedia URL without copying or downloading anything.
        const summary = await fetchWikiSummary(name);
        if (!summary) {
          return errorResult(
            `Wikipedia has no article for "${name}", or it could not be read just now. ` +
              'Nothing is wrong with the Globie catalogue; try a scientific name or a ' +
              'plainer common name.',
          );
        }

        const spoken =
          `${summary.extract} That summary is from Wikipedia under a Creative Commons ` +
          'licence, and may be incomplete or unverified.';

        return jsonResult(
          {
            query: name,
            title: summary.title,
            extract: summary.extract,
            url: summary.url,
            license: summary.license,
            // The freely-licensed lead image, when the article has one: its own
            // licence and full attribution travel with it, so a reader can show
            // it only with the credit the licence requires. Null when there is
            // no provably free image - the text stands alone.
            image: summary.image,
            // Stated in the payload as well as the description, so a machine
            // reader cannot mistake this for Globie's own verified data.
            source: 'Wikipedia (CC BY-SA 4.0) - external reference, may be unverified',
          },
          spoken,
          {
            resourceUri: uiUriForTool('describe_species'),
            invoking: 'Looking up the species…',
            invoked: summary.title,
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
