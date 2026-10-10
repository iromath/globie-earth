// The moderation route: the second half of the photo-contribution feature.
//
// /contribute ends by storing a visitor's photograph as a `pending` row
// (infra/schema/220_species_contributions.sql) and saying that accepting it is
// "a separate human act". This route is that act. It lets a moderator read the
// queue and move a row pending -> approved | rejected, and an `approved` row is
// the one the species page can show (infra/schema/230_species_contributions_approval.sql).
//
// Two things are deliberately NOT decided here:
//
//   - Who may moderate. That is api.moderators, tested by RLS through
//     private.is_moderator(). This route checks the same thing before doing any
//     work only so the caller gets a clear 403 instead of an empty list; but the
//     database is the authority, and the PATCH below is refused by policy even
//     if this check were wrong. The check is a courtesy, not the guard.
//   - What an update may change. The anon role holds UPDATE on three columns
//     only - status, reviewed_by, reviewed_at - so this route could not rewrite
//     a contribution's photo or its scanner verdict even if it tried.
//
// The identity is the same device credential /contribute, /route and /mcp use,
// and it is forwarded to PostgREST untouched. A moderator is an ordinary device
// that happens to have a row in api.moderators; no service key is involved.

import type { FastifyInstance } from 'fastify';

import { resolveCaller, type Caller } from './identity.js';
import { get, PostgrestError, update } from './postgrest.js';

/** How many pending rows one queue read returns. */
const QUEUE_LIMIT = 100;

/** The verdicts a moderator may hand down; 'pending' is not a decision. */
const DECISIONS = ['approve', 'reject'] as const;
type Decision = (typeof DECISIONS)[number];

/**
 * What a queue read returns. The scanner's own verdict (ai_*) travels with the
 * row so a reviewer can see what Globie made of the photo beside the photo
 * itself - the queue is a decision, and a decision wants its evidence.
 */
const QUEUE_SELECT = [
  'id',
  'device_id',
  'species_type',
  'species_id',
  'species_name',
  'status',
  'photo_url',
  'photo_key',
  'content_type',
  'byte_size',
  'ai_category',
  'ai_subject',
  'ai_reason',
  'ai_model',
  'created_at',
  'updated_at',
].join(',');

interface Contribution {
  id: string;
  status: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the caller is a moderator, asked of the database rather than of this
 * process. api.moderators is readable for the caller's own row only, so a
 * non-moderator simply reads nothing - which is the answer we want, and it is
 * the same table the update policy consults.
 */
async function isModerator(caller: Caller): Promise<boolean> {
  const rows = await get<{ device_id: string }[]>(
    `moderators?select=device_id&device_id=eq.${caller.deviceId}&limit=1`,
    caller,
  );
  return rows.length > 0;
}

/** One message an operator can act on, from a PostgREST failure. */
function upstreamMessage(error: unknown): string {
  if (error instanceof PostgrestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function registerModerateRoute(app: FastifyInstance): void {
  /**
   * GET /moderate/queue - the pending contributions, oldest first.
   *
   * A moderator reads the whole queue; anyone else is told plainly that they
   * may not, rather than being handed a misleading empty list (RLS would return
   * only their own rows, which is not the queue).
   */
  app.get('/moderate/queue', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({
        error:
          'Reviewing contributions needs a caller identity: the same X-Device-Id (or demo ' +
          'Authorization bearer) that /mcp accepts. See infra/mcp/README.md.',
      });
    }

    try {
      if (!(await isModerator(caller))) {
        return reply.code(403).send({
          error: 'This device is not a moderator, so it cannot review the contribution queue.',
        });
      }

      const rows = await get<Contribution[]>(
        `species_contributions?select=${QUEUE_SELECT}&status=eq.pending&order=created_at.asc&limit=${QUEUE_LIMIT}`,
        caller,
      );
      return reply.send({ pending: rows.length, contributions: rows });
    } catch (error) {
      request.log.error({ err: error }, 'moderate: reading the queue failed');
      return reply.code(502).send({
        error: `The contribution queue could not be read (${upstreamMessage(error)}).`,
      });
    }
  });

  /**
   * POST /moderate/decision - approve or reject one pending contribution.
   *
   * Body: { id: uuid, decision: 'approve' | 'reject' }.
   *
   * The filter pins the row to `status=eq.pending`, so a contribution can be
   * decided exactly once: a second attempt matches nothing and is reported as
   * 404 rather than silently re-deciding an already-reviewed photo.
   */
  app.post('/moderate/decision', async (request, reply) => {
    const caller = resolveCaller(request.headers);
    if (!caller) {
      return reply.code(401).send({
        error:
          'Reviewing contributions needs a caller identity: the same X-Device-Id (or demo ' +
          'Authorization bearer) that /mcp accepts. See infra/mcp/README.md.',
      });
    }

    const body: unknown = request.body;
    if (!isRecord(body)) {
      return reply.code(400).send({ error: 'The decision body must be a JSON object.' });
    }

    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(id)) {
      return reply.code(400).send({ error: 'id must be the contribution uuid.' });
    }

    const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
    if (!DECISIONS.includes(decision as Decision)) {
      return reply.code(400).send({ error: `decision must be one of: ${DECISIONS.join(', ')}.` });
    }

    const status = decision === 'approve' ? 'approved' : 'rejected';

    try {
      if (!(await isModerator(caller))) {
        return reply.code(403).send({
          error: 'This device is not a moderator, so it cannot decide a contribution.',
        });
      }

      const rows = await update<Contribution[]>(
        'species_contributions',
        `id=eq.${id}&status=eq.pending`,
        { status, reviewed_by: caller.deviceId, reviewed_at: new Date().toISOString() },
        caller,
      );

      if (rows.length === 0) {
        return reply.code(404).send({
          error: 'No pending contribution with that id. It may already have been decided.',
        });
      }

      request.log.info(
        { deviceId: caller.deviceId, contributionId: id, status },
        'moderate: decided a contribution',
      );
      return reply.send({ status, contribution: rows[0] });
    } catch (error) {
      request.log.error({ err: error }, 'moderate: deciding a contribution failed');
      return reply.code(502).send({
        error: `The contribution could not be updated (${upstreamMessage(error)}).`,
      });
    }
  });
}
