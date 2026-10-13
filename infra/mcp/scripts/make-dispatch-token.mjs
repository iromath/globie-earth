// Mints the credential the push dispatcher presents to PostgREST.
//
// The MCP server has no direct Postgres connection - it speaks HTTP to PostgREST
// as `anon` (infra/mcp/src/postgrest.ts) - and cannot LISTEN, so the always-on
// dispatcher (infra/mcp/src/pushDispatcher.ts) polls
// api.claim_notification_pushes() for alert rows no app has been woken for yet
// (infra/schema/253_notification_push.sql). That function is SECURITY DEFINER and
// reads api.notifications across every device, so it must not be open to the
// world: it refuses any caller without the custom claim `notification_dispatch:
// true`. This script mints exactly that token.
//
// The token is a JWT signed with the stack's own PGRST_JWT_SECRET, so PostgREST
// verifies the signature before the call runs and the function only has to check
// the claim. It is a *low-privilege* token: its role claim is `anon` and it
// carries no account `sub`, so leaking it exposes the push queue and nothing
// else. Treat it as a shared secret all the same.
//
//   node --env-file=../.env scripts/make-dispatch-token.mjs
//   node --env-file=../.env scripts/make-dispatch-token.mjs --days=90
//
// Prints the JWT and the NOTIFICATIONS_DISPATCH_TOKEN= line to paste into the MCP
// environment (infra/.env, then restart the `mcp` service). Re-run it to rotate.

import { createHmac, randomUUID } from 'node:crypto';

const secret = process.env.PGRST_JWT_SECRET?.trim();
if (!secret) {
  console.error(
    'PGRST_JWT_SECRET is not set. Run this with the stack env in scope, e.g.\n' +
      '  node --env-file=../.env scripts/make-dispatch-token.mjs',
  );
  process.exit(1);
}

/** How long the token lives. Rotate before it lapses; /health reports the expiry. */
const DEFAULT_DAYS = 365;

const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
const days = daysArg ? Number(daysArg.slice('--days='.length)) : DEFAULT_DAYS;
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number, e.g. --days=365');
  process.exit(1);
}

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT' };
const payload = {
  // The role PostgREST switches to. `anon` is the same low-privilege role every
  // device-only caller uses; the claim below is the only thing that widens it.
  role: 'anon',
  // The gate api.claim_notification_pushes checks. Not a PostgREST claim - a
  // custom one the function reads out of request.jwt.claims.
  notification_dispatch: true,
  // No `sub`: this is not a person, so it must not match an account policy.
  iat: now,
  exp: now + Math.round(days * 86400),
  jti: randomUUID(),
};

const signingInput = `${base64url(header)}.${base64url(payload)}`;
const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
const token = `${signingInput}.${signature}`;

console.log('Dispatch token (expires in %d days, %s):', days, new Date(payload.exp * 1000).toISOString());
console.log('');
console.log(token);
console.log('');
console.log('Add to the MCP environment (infra/.env):');
console.log('');
console.log(`NOTIFICATIONS_DISPATCH_TOKEN=${token}`);
