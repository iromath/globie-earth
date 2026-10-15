// Adoption and eco-token tools: the stateful half of the server.
//
// These wrap the same RPCs the app calls (src/lib/api.ts recordPurchase) and the
// same device-scoped tables that the RLS policies already pin to the caller.
// Nothing here invents state: an adoption is the row api.create_adoption writes,
// a deed is the row it issues, and a balance is the sum of api.eco_token_balance.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listDeeds, toDeed } from '../deeds.js';
import type { Caller } from '../identity.js';
import { get, rpc } from '../postgrest.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult } from './result.js';

/**
 * Eco-tokens credited per sapling adopted. Mirrors TOKENS_PER_SAPLING in
 * src/lib/api.ts. The MCP server is a separate service, so the constant is
 * restated rather than imported; change both together.
 */
const TOKENS_PER_SAPLING = 100;

/** What api.create_adoption returns (the create_adoption RPC). */
interface AdoptionResult {
  adoption: { id: string; species_id: string; pledge_thb: number; pledge_usd: number };
  deed: {
    deed_no: string;
    trees_planted: number;
    stage_index: number;
    stages: string[];
    progress_pct: number;
    co2_offset_kg: number | string;
    issued_at: string;
  };
  replayed: boolean;
}

interface BalanceRow {
  balance: number;
}

/** The caller's balance, summed across its devices. Zero when it has none. */
async function readBalance(caller: Caller): Promise<number> {
  const rows = await get<BalanceRow[]>('eco_token_balance?select=balance', caller);
  return rows.reduce((total, row) => total + row.balance, 0);
}

export function registerAdoptionTools(server: McpServer, caller: Caller): void {
  server.registerTool(
    'adopt_species',
    {
      title: 'Adopt a species',
      description:
        'Records an adoption of a species, issues its Living Deed and credits eco-tokens ' +
        'for the saplings it covers. This CHANGES STATE, so ask the person to confirm before ' +
        'calling it. It wraps the same idempotent RPC the app calls after a store purchase: ' +
        'pass that purchase\'s transaction id as `reference` and a retry returns the original ' +
        'deed instead of a second one. Without a reference the call is not idempotent, so do ' +
        'not retry it blindly. The tool records the adoption in Globie Earth; it does not ' +
        'itself take payment.',
      inputSchema: {
        species_id: z
          .string()
          .min(1)
          .max(100)
          .describe(
            'The species to adopt, e.g. "kae-na". Use search_forest_knowledge or recommend_species to find one.',
          ),
        quantity: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('How many saplings this adoption covers. Defaults to 1.'),
        reference: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'The store transaction this adoption settles, if any. Supplying it makes a repeat call a no-op.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: uiUriForTool('adopt_species') } },
    },
    async ({ species_id, quantity, reference }) => {
      try {
        const adoption = await rpc<AdoptionResult>(
          'create_adoption',
          {
            p_species_id: species_id,
            p_rc_product_id: null,
            p_rc_transaction_id: reference ?? null,
            p_quantity: quantity ?? 1,
          },
          caller,
        );

        const fresh = !adoption.replayed;
        const tokensAwarded = fresh ? adoption.deed.trees_planted * TOKENS_PER_SAPLING : 0;

        // Mirrors recordPurchase: only a fresh adoption is credited, and a
        // replay reads the balance back rather than appending a duplicate
        // ledger row through award_eco_tokens.
        const balance =
          tokensAwarded > 0
            ? (
                await rpc<BalanceRow>(
                  'award_eco_tokens',
                  {
                    p_delta: tokensAwarded,
                    p_reason: 'adoption',
                    p_source_type: 'adoption',
                    p_source_id: adoption.adoption.id,
                  },
                  caller,
                )
              ).balance
            : await readBalance(caller);

        const stage = adoption.deed.stages[adoption.deed.stage_index];
        const spoken = adoption.replayed
          ? `That adoption had already been recorded, so no new deed or eco-tokens were issued. Your balance is ${balance}.`
          : `You have adopted ${adoption.deed.trees_planted} ${adoption.adoption.species_id} ${adoption.deed.trees_planted === 1 ? 'sapling' : 'saplings'}. Living Deed ${adoption.deed.deed_no} is issued${stage ? `, now at the ${stage} stage` : ''} - ${adoption.deed.progress_pct} percent grown and offsetting ${adoption.deed.co2_offset_kg} kilograms of carbon dioxide. You earned ${tokensAwarded} eco-tokens, and your balance is ${balance}.`;

        return jsonResult(
          {
            deed: {
              deedNo: adoption.deed.deed_no,
              speciesId: adoption.adoption.species_id,
              treesPlanted: adoption.deed.trees_planted,
              stageIndex: adoption.deed.stage_index,
              stages: adoption.deed.stages,
              progressPct: adoption.deed.progress_pct,
              co2OffsetKg: Number(adoption.deed.co2_offset_kg),
              issuedAt: adoption.deed.issued_at,
            },
            replayed: adoption.replayed,
            tokensAwarded,
            balance,
            note: adoption.replayed
              ? 'This adoption was already recorded against that reference, so no new deed or eco-tokens were issued.'
              : null,
          },
          spoken,
          {
            resourceUri: uiUriForTool('adopt_species'),
            invoking: 'Recording the adoption…',
            invoked: `Living Deed ${adoption.deed.deed_no}`,
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_my_deeds',
    {
      title: 'List my living deeds',
      description:
        'Lists the Living Deeds issued for adoptions made by this caller, newest first, ' +
        'each with its deed number, species, saplings planted, growth stage and progress. ' +
        'Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uiUriForTool('get_my_deeds') } },
    },
    async () => {
      try {
        const rows = await listDeeds(caller);
        const deeds = rows.map(toDeed);
        const newest = deeds[0];
        const spoken = deeds.length
          ? `You have ${deeds.length} living ${deeds.length === 1 ? 'deed' : 'deeds'}. The newest is ${newest.treesPlanted} ${newest.speciesId || 'trees'}, ${newest.progressPct} percent grown.${
              deeds.length > 1 ? ` There ${deeds.length === 2 ? 'is one more' : `are ${deeds.length - 1} more`}.` : ''
            }`
          : 'You have not adopted anything on this device yet.';
        return jsonResult(
          {
            count: rows.length,
            deeds,
            // An empty list is a real state, not a failure - say which one it is.
            note: rows.length ? null : 'This device has not adopted anything yet.',
          },
          spoken,
          {
            resourceUri: uiUriForTool('get_my_deeds'),
            invoking: 'Reading your living deeds…',
            invoked: 'Living deeds',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_eco_balance',
    {
      title: 'Get my eco-token balance',
      description:
        'The caller\'s current eco-token balance, summed across their devices. Eco-tokens ' +
        'are earned by adopting trees. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uiUriForTool('get_eco_balance') } },
    },
    async () => {
      try {
        const rows = await get<BalanceRow[]>('eco_token_balance?select=balance', caller);
        const balance = rows.reduce((total, row) => total + row.balance, 0);
        const spoken = rows.length
          ? `Your eco-token balance is ${balance}. Eco-tokens are earned by adopting trees, at ${TOKENS_PER_SAPLING} per sapling.`
          : `You have no eco-tokens on this device yet. They are earned by adopting trees, at ${TOKENS_PER_SAPLING} per sapling.`;
        return jsonResult(
          {
            balance,
            tokensPerSapling: TOKENS_PER_SAPLING,
            note: rows.length ? null : 'This device has never held eco-tokens.',
          },
          spoken,
          {
            resourceUri: uiUriForTool('get_eco_balance'),
            invoking: 'Counting your eco-tokens…',
            invoked: 'Eco-token balance',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
