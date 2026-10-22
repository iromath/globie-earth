// Eco tokens: the reward the games pay, and the balance they show.
//
// The games run on the television, so the cheapest wallet would be a number in
// AsyncStorage. That number is per-device, though, and the same viewer plays on
// the Echo and on a second TV - each screen would report a different total. So
// the wallet is the ledger in api.eco_ledger (infra/schema/256_eco_tokens.sql),
// keyed by the caller's X-Device-Id, which is the identity every route here
// already resolves in identity.ts.
//
// Four routes, all device-scoped and all able to say "unknown":
//
//   GET  /v1/tv/wallet        the total, for the badge on screen
//   POST /v1/tv/wallet/award  credit one award, returning the new total
//   POST /v1/tv/wallet/spend  debit one wardrobe item, server-priced
//   GET  /v1/tv/wardrobe      the catalogue with prices and what this device owns
//
// The award route is idempotent on the key the game derives from what happened
// ("memory:<session>:<pair>"). A retried request credits once and answers
// awarded: 0, because the popup must not claim a second payment the balance
// does not show.
//
// The spend route is the same contract in the other direction: the client names
// the item and never the price (api.eco_items holds it), and the ledger's
// (device_id, award_key) makes a retried purchase debit once. That is why this
// module has no catalogue of its own - the wardrobe read comes from the same
// function that prices the write.
//
// `available: false` is a first-class answer, not an error: a television whose
// API is unreachable should still finish its match and show "+2", it just
// cannot print a running total. Refusing the match instead would trade a
// reward for a broken game. A purchase has no such fallback - it simply does
// not happen, and the panel says so.

import type { FastifyInstance } from 'fastify';

import { resolveCaller } from './identity.js';
import type { Caller } from './identity.js';
import { PostgrestError, rpc } from './postgrest.js';

/** The schema's own limits, so a bad award is refused before it reaches Postgres. */
const KEY_MAX = 120;
const AMOUNT_MAX = 500;

interface BalanceRow {
  balance: number;
  awarded: number;
}

/**
 * Whether the wallet is reachable at all.
 *
 * A PostgrestError is the API being down or the migration unapplied, which is
 * a degraded wallet; anything else is a bug and is left for the route to
 * answer, matching the pairing relay's rule in tvCommands.ts.
 */
function storeUnavailable(error: unknown): boolean {
  return error instanceof PostgrestError;
}

/** The viewer's total, or null when the API cannot answer. */
async function balanceOf(caller: Caller): Promise<number | null> {
  try {
    return await rpc<number>('eco_balance', {}, caller);
  } catch (error) {
    if (storeUnavailable(error)) return null;
    throw error;
  }
}

/**
 * Credits one award.
 *
 * `awarded` is what this call actually added: 0 when the key was already in
 * the ledger, which is the replay case. `balance` is null when the API could
 * not be reached, and both are null together - a credited award with no total
 * would be a worse lie than no number at all.
 *
 * Exported so a challenge room pays through the same ledger call and the same
 * degrade rules as the games, instead of growing a second award path.
 */
export async function awardEcoTokens(
  caller: Caller,
  key: string,
  amount: number,
): Promise<{ balance: number | null; awarded: number }> {
  try {
    const rows = await rpc<BalanceRow[]>('eco_award', { p_key: key, p_amount: amount }, caller);
    const row = rows[0];
    if (!row) return { balance: null, awarded: 0 };
    return { balance: Number(row.balance) || 0, awarded: Number(row.awarded) || 0 };
  } catch (error) {
    if (storeUnavailable(error)) return { balance: null, awarded: 0 };
    throw error;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The schema's own limit on an item key (api.eco_items). */
const ITEM_MAX = 40;

interface SpendRow {
  balance: number;
  spent: number;
  owned: boolean;
}

export interface WardrobeItem {
  itemKey: string;
  price: number;
  owned: boolean;
}

export interface EcoWardrobe {
  balance: number | null;
  items: WardrobeItem[];
  available: boolean;
}

export interface EcoSpend {
  balance: number | null;
  spent: number;
  owned: boolean;
  available: boolean;
  /** Set when the wardrobe answered but refused to charge; absent on success. */
  refusal?: 'insufficient' | 'unknown_item';
}

/**
 * Debits one item.
 *
 * `spent` is what this call actually charged: 0 for a replay and for an item
 * the viewer already starts with, so a double tap cannot charge twice. A
 * refusal is not an outage - the wallet answered - so `available` stays true
 * and the route can say which refusal it was.
 */
export async function spendEcoTokens(caller: Caller, item: string): Promise<EcoSpend> {
  try {
    const rows = await rpc<SpendRow[]>('eco_spend', { p_item: item }, caller);
    const row = rows[0];
    if (!row) return { balance: null, spent: 0, owned: false, available: false };
    return {
      balance: Number(row.balance) || 0,
      spent: Number(row.spent) || 0,
      owned: Boolean(row.owned),
      available: true,
    };
  } catch (error) {
    if (!(error instanceof PostgrestError)) throw error;
    // 23514 is the overdraft private.credit_eco_tokens already raises; P0002
    // is the "not there" the challenge routes answer with.
    if (error.code === '23514') {
      return { balance: null, spent: 0, owned: false, available: true, refusal: 'insufficient' };
    }
    if (error.code === 'P0002') {
      return { balance: null, spent: 0, owned: false, available: true, refusal: 'unknown_item' };
    }
    return { balance: null, spent: 0, owned: false, available: false };
  }
}

/** The catalogue as this device sees it, or an empty one when the API is down. */
export async function loadEcoWardrobe(caller: Caller): Promise<EcoWardrobe> {
  try {
    const payload = await rpc<{ balance: number; items: WardrobeItem[] }>(
      'eco_wardrobe',
      {},
      caller,
    );
    return {
      balance: Number(payload?.balance) || 0,
      items: (payload?.items ?? []).map(item => ({
        itemKey: String(item.itemKey),
        price: Number(item.price) || 0,
        owned: Boolean(item.owned),
      })),
      available: true,
    };
  } catch (error) {
    if (!(error instanceof PostgrestError)) throw error;
    return { balance: null, items: [], available: false };
  }
}

export function registerTvWalletRoutes(app: FastifyInstance): void {
  // --- The badge reads the total ------------------------------------------
  app.get('/v1/tv/wallet', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Reading the eco wallet needs a caller identity.' });
    }

    const balance = await balanceOf(caller);
    return reply.send({ balance, available: balance !== null });
  });

  // --- A match pays out ---------------------------------------------------
  // The key is the game's record of what was rewarded, so the same match can
  // be reported twice (a retry, a remount) without paying twice.
  app.post('/v1/tv/wallet/award', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Awarding eco tokens needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { key?: unknown; amount?: unknown };
    const key = readString(body.key);
    if (!key || key.length > KEY_MAX) {
      return reply.code(400).send({ error: `An award needs a key of 1 to ${KEY_MAX} characters.` });
    }

    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > AMOUNT_MAX) {
      return reply.code(400).send({ error: `An award needs a whole amount from 1 to ${AMOUNT_MAX}.` });
    }

    const result = await awardEcoTokens(caller, key, amount);
    return reply.send({ ...result, available: result.balance !== null });
  });

  // --- The wardrobe: what one token can buy -------------------------------
  // The panel asks one question ("what is there, what do I own, what can I
  // spend") and gets one answer, so the price shown and the price charged
  // cannot come from two different places.
  app.get('/v1/tv/wardrobe', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Reading the wardrobe needs a caller identity.' });
    }

    return reply.send(await loadEcoWardrobe(caller));
  });

  // --- A purchase debits --------------------------------------------------
  // The body names the item only. If it carried a price, a modified client
  // could buy Mother Tree for one token; api.eco_spend reads the price from
  // api.eco_items instead.
  app.post('/v1/tv/wallet/spend', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({ error: 'Spending eco tokens needs a caller identity.' });
    }

    const body = (request.body ?? {}) as { item?: unknown };
    const item = readString(body.item);
    if (!item || item.length > ITEM_MAX) {
      return reply
        .code(400)
        .send({ error: `A purchase needs an item key of 1 to ${ITEM_MAX} characters.` });
    }

    const result = await spendEcoTokens(caller, item);
    if (result.refusal === 'insufficient') {
      return reply
        .code(409)
        .send({ error: 'Not enough eco-tokens for that yet.', code: 'insufficient_tokens' });
    }
    if (result.refusal === 'unknown_item') {
      return reply
        .code(404)
        .send({ error: 'That item is not in the wardrobe.', code: 'unknown_item' });
    }

    return reply.send(result);
  });
}
