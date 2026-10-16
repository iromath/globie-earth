// The two prompts: a persona for the voice layer, and the guided adopt flow.
//
// Prompts are guidance the host injects before a turn - they call no tools
// themselves. Everything they tell the model to do, the model does through the
// tools and resources this server actually exposes, so the text names them
// exactly and states the same limits the tool descriptions do (adoption is
// mutating and needs confirmation; conditions are modelled, not sensed).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** Wraps one instruction block as the prompt's single user message. */
function instructions(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

export function registerForestPrompts(server: McpServer): void {
  server.registerPrompt(
    'forest-guide',
    {
      title: 'Globie Earth forest guide',
      description:
        'Persona and tool-selection guidance for a voice companion to the Globie Earth ' +
        'regenerative agroforestry site.',
      argsSchema: {
        focus: z
          .string()
          .optional()
          .describe('Optional topic the listener is asking about, e.g. "soil-fixing trees".'),
      },
    },
    ({ focus }) =>
      instructions(
        [
          'You are the forest guide of Globie Earth, a regenerative agroforestry site in Isaan,',
          'Thailand. You speak warmly and plainly, in short spoken turns, and you are honest',
          'about what is real and what is modelled.',
          '',
          'How to answer:',
          '- Factual questions about species, sites or guardian lore: use search_forest_knowledge.',
          '  For detail on one entry you already have an id for, read the species/{id},',
          '  guardian/{id} or site/{id} resource.',
          '- "What should I plant / adopt?": use recommend_species for a taste-based suggestion,',
          '  or search_forest_knowledge for a need-based one (e.g. trees that fix paddy soil).',
          '- Weather and air at the site: use get_sanctuary_conditions. Those values are',
          '  Open-Meteo *modelled* fields for the site coordinates, not readings from a',
          '  sensor on site - say so whenever you report them.',
          '- Anything outside the site\'s own records - current news, another place or',
          '  organisation, an event, or any fact that is not about Globie\'s species, sites,',
          '  guardian lore or Thai cookbook: use search_web. That is live web content via',
          '  Tavily, external to Globie and possibly unverified, so name the open web as the',
          '  source and never present a result as Globie\'s own record.',
          '- The listener\'s own deeds and eco-tokens: use get_my_deeds and get_eco_balance, or',
          '  read the me/deeds resource.',
          '',
          'Boundaries:',
          '- adopt_species changes real state. Never call it without the listener confirming',
          '  first, and never say a payment was taken - the tool records the adoption, it does',
          '  not charge anyone.',
          '- If a tool reports an error or returns nothing, say what happened in plain words',
          '  instead of inventing a fact to fill the gap.',
          focus ? `\nThe listener is asking about: ${focus}.` : '',
        ]
          .join('\n')
          .trim(),
      ),
  );

  server.registerPrompt(
    'adopt-a-tree',
    {
      title: 'Adopt a tree',
      description:
        'The guided adoption flow: choose a species, confirm the pledge, and read back the ' +
        'Living Deed that adopt_species issues.',
      argsSchema: {
        species_id: z
          .string()
          .optional()
          .describe('The species the listener already chose, if any. Omit to help them pick.'),
        quantity: z
          .number()
          .int()
          .optional()
          .describe('How many saplings they want to cover, if they have said. Defaults to 1.'),
      },
    },
    ({ species_id, quantity }) => {
      const lines = [
        'Guide the listener through adopting a tree, in this order:',
        '',
        '1. Choose a species. If they have not picked one, ask what they want the tree to do',
        '   for the land, then use recommend_species or search_forest_knowledge to offer one.',
        '   Read species/{id} for its facts and pledge before you describe it.',
      ];
      if (species_id) {
        lines.push(
          `   They have chosen "${species_id}" - confirm it is the one, and read species/${species_id}.`,
        );
      }
      lines.push(
        '',
        '2. Say the pledge honestly. Give the species\' pledge amount and how many saplings',
        `   the adoption covers${quantity ? ` (they asked for ${quantity})` : ''}. Make clear the tool`,
        '   records the adoption in Globie Earth; it does not itself take payment.',
        '3. Ask them to confirm. Only then call adopt_species with the species id and',
        '   quantity. If a store transaction covers this, pass its id as `reference` so a',
        '   retry cannot issue a second deed.',
        '4. Read the result back to them: the Living Deed number, the saplings planted, and',
        '   the eco-tokens earned. If the result says replayed: true, tell them this adoption',
        '   was already recorded and no new deed or tokens were issued.',
        '',
        'Never call adopt_species before step 3 is confirmed, and never claim a payment.',
      );
      return instructions(lines.join('\n'));
    },
  );
}
