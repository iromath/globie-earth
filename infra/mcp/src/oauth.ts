// MCP OAuth 2.1: the discovery documents and the two-tier token surface Alexa+
// requires before it will register this server as an add-on.
//
// Alexa+ is the MCP *client*. Before it talks to /mcp it insists on the standard
// OAuth 2.1 discovery chain (Amazon's add-on certification checklist), and it
// uses two credentials for two different jobs:
//
//   - Tier 1, `client_credentials` (scope mcp:service): one machine credential
//     the client uses to register the add-on, enumerate tools/resources and poll
//     /health. No user is involved, so the token carries no refresh token and
//     lives at most an hour.
//   - Tier 2, `authorization_code` + PKCE S256 (scopes mcp:tools /
//     mcp:resources): the user path, entered only when a user-specific tool is
//     first invoked.
//
// What this module is NOT: the static `MCP_BEARER_TOKEN` in identity.ts is a
// shared demo secret, and this is the honest production path *beside* it, not a
// re-dressing of that secret (AMAZON-MCP-PLAN.md 6, decision D4). Both live at
// the same edge; identity.ts accepts either.
//
// Tokens are self-contained - an HMAC-SHA256-signed payload, verified with no
// store - so the surface survives a container restart. Authorization *codes* are
// short-lived and held in memory, which is enough for one instance and is said
// so here rather than implied.
//
// The surface is dormant until MCP_OAUTH_SECRET is set: with no secret there is
// nothing to sign or verify with, so the routes explain themselves and /health
// reports `configured:false`, exactly like every other optional neighbour.

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The scopes this server understands. `mcp:service` is Tier 1; the other two Tier 2. */
const SCOPES = ['mcp:service', 'mcp:tools', 'mcp:resources'] as const;

/** A token may not outlive an hour, so a leaked one ages out on its own. */
const MAX_TOKEN_SECONDS = 3600;

/** An authorization code is single-use and short-lived: long enough for one exchange. */
const CODE_TTL_MS = 5 * 60 * 1000;

export interface OAuthConfig {
  /** The HMAC key tokens are signed with, and the `configured` switch. */
  secret: string;
  /** The single registered client (Tier 1 secret, Tier 2 public id). */
  clientId: string;
  clientSecret: string;
  /** Exact redirect URIs the Tier 2 flow may return to. Empty refuses every authorize. */
  redirectUris: string[];
  /** The device a user token is bound to. A stand-in for a sign-in here. */
  userDeviceId: string | null;
  /** The issuer/resource origin, or null to derive it per request from the Host. */
  publicUrl: string | null;
}

/** What a verified access token grants: its scopes and the device it acts as. */
export interface OAuthGrant {
  scope: string[];
  deviceId: string;
}

/** The signed payload inside an access token. Short keys keep the token small. */
interface TokenPayload {
  v: 1;
  typ: 'service' | 'user';
  scope: string[];
  /** The device this token acts as. Always set at mint time. */
  device: string;
  iat: number;
  exp: number;
  jti: string;
}

/** One outstanding authorization code, awaiting its single redemption. */
interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string[];
  deviceId: string;
  expiresAt: number;
}

const codes = new Map<string, AuthCode>();

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

/** The configuration, or null when the surface is not enabled (no secret set). */
export function readOAuthConfig(): OAuthConfig | null {
  const secret = env('MCP_OAUTH_SECRET');
  if (!secret) return null;
  return {
    secret,
    clientId: env('MCP_OAUTH_CLIENT_ID') ?? '',
    clientSecret: env('MCP_OAUTH_CLIENT_SECRET') ?? '',
    redirectUris: (env('MCP_OAUTH_REDIRECT_URIS') ?? '')
      .split(',')
      .map((uri) => uri.trim())
      .filter(Boolean),
    // A user token must land on a device the RPCs can scope, so it falls back to
    // the same demo device the static-bearer path already uses.
    userDeviceId: env('MCP_OAUTH_USER_DEVICE_ID') ?? env('MCP_DEMO_DEVICE_ID'),
    publicUrl: env('MCP_PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
  };
}

/** What /health reports about the OAuth surface, without leaking any secret. */
export function oauthHealth(): Record<string, unknown> {
  const config = readOAuthConfig();
  return {
    configured: Boolean(config),
    // A client id/secret pair is what makes Tier 1 actually usable; report it
    // separately so a half-configured surface is visible rather than inferred.
    client: Boolean(config?.clientId && config?.clientSecret),
    redirectUris: config?.redirectUris.length ?? 0,
    userDevice: Boolean(config?.userDeviceId),
    issuer: config?.publicUrl ?? null,
  };
}

/**
 * The issuer/resource origin. Falls back to the request's own Host when
 * MCP_PUBLIC_URL is unset, so discovery works locally without configuration.
 */
function issuerFor(request: FastifyRequest): string {
  const config = readOAuthConfig();
  if (config?.publicUrl) return config.publicUrl;
  const forwarded = request.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || 'https';
  const host = request.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signToken(payload: TokenPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** The grant a token carries, or null when it is malformed, forged or expired. */
export function verifyOAuthToken(token: string): OAuthGrant | null {
  const config = readOAuthConfig();
  if (!config) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac('sha256', config.secret).update(body).digest('base64url');
  // Constant-time, and false when lengths differ - which leaks nothing here.
  if (!sameSecret(signature, expected)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return null;
  }

  if (payload?.v !== 1) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.device !== 'string' || !payload.device) return null;

  return {
    scope: Array.isArray(payload.scope) ? payload.scope : [],
    deviceId: payload.device,
  };
}

/** `Authorization: Basic <base64(id:secret)>`, or null when it is not that. */
function basicAuth(header: string | string[] | undefined): { id: string; secret: string } | null {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim();
  const match = raw?.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { id: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

/** A JSON error body, without a WWW-Authenticate header: Amazon does not use it. */
function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return reply.code(status).send({ error, error_description: description });
}

function issueToken(
  config: OAuthConfig,
  typ: 'service' | 'user',
  scope: string[],
  deviceId: string,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    v: 1,
    typ,
    scope,
    device: deviceId,
    iat: now,
    exp: now + MAX_TOKEN_SECONDS,
    jti: randomUUID(),
  };
  return {
    access_token: signToken(payload, config.secret),
    token_type: 'Bearer',
    expires_in: MAX_TOKEN_SECONDS,
    scope: scope.join(' '),
    // Deliberately no refresh_token: neither tier issues one (Amazon checklist).
  };
}

/** The endpoints. Registered from main() beside /mcp, after CORS. */
export function registerOAuthRoutes(app: FastifyInstance): void {
  // OAuth clients post `application/x-www-form-urlencoded`, which Fastify does
  // not parse by default. Register it once, only if nothing else has.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (error) {
          done(error as Error);
        }
      },
    );
  }

  // RFC 9728 Protected Resource Metadata: the entry point a client reads first.
  // It points at the authorization server below and names the scopes the
  // resource (the MCP server) understands. Served at the bare well-known URI and
  // at the /mcp-suffixed one, so either discovery style resolves.
  const protectedResourceMetadata = (request: FastifyRequest): Record<string, unknown> => {
    const issuer = issuerFor(request);
    return {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_documentation: `${issuer}/health`,
    };
  };
  app.get('/.well-known/oauth-protected-resource', (request) =>
    protectedResourceMetadata(request),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', (request) =>
    protectedResourceMetadata(request),
  );

  // Auth-server metadata (RFC 8414). `code_challenge_methods_supported` must
  // include S256 or the client refuses the flow before it starts.
  app.get('/.well-known/oauth-authorization-server', (request) => {
    const issuer = issuerFor(request);
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      scopes_supported: [...SCOPES],
      response_types_supported: ['code'],
      grant_types_supported: ['client_credentials', 'authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      bearer_methods_supported: ['header'],
    };
  });

  // The Tier 2 consent step. A real deployment renders a sign-in here; this
  // server has no user directory, so it mints a code bound to the configured
  // user device and redirects - the shortcut is the honest limit of this build,
  // stated rather than dressed up. The redirect URI is checked against an exact
  // allowlist *before* any redirect, so this can never be an open redirector.
  app.get('/oauth/authorize', async (request, reply) => {
    const config = readOAuthConfig();
    if (!config) {
      return oauthError(reply, 503, 'temporarily_unavailable', 'OAuth is not configured on this server.');
    }
    const query = request.query as Record<string, string | undefined>;
    const clientId = query.client_id ?? '';
    const redirectUri = query.redirect_uri ?? '';
    const challenge = query.code_challenge ?? '';
    const method = query.code_challenge_method ?? '';
    const scope = (query.scope ?? '').split(/\s+/).filter(Boolean);
    const state = query.state ?? '';

    if (config.clientId && clientId !== config.clientId) {
      return oauthError(reply, 400, 'invalid_request', 'Unknown client_id.');
    }
    if (!redirectUri || !config.redirectUris.includes(redirectUri)) {
      // No redirect here: an unregistered redirect_uri must not be redirected to.
      return oauthError(reply, 400, 'invalid_request', 'redirect_uri is not registered.');
    }
    if (query.response_type !== 'code') {
      return oauthError(reply, 400, 'unsupported_response_type', 'Only response_type=code is supported.');
    }
    if (!challenge || method !== 'S256') {
      return oauthError(reply, 400, 'invalid_request', 'code_challenge with code_challenge_method=S256 is required.');
    }
    if (!config.userDeviceId) {
      return oauthError(
        reply,
        503,
        'temporarily_unavailable',
        'No user device is configured (MCP_OAUTH_USER_DEVICE_ID / MCP_DEMO_DEVICE_ID).',
      );
    }

    const code = randomUUID();
    codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      scope: scope.length ? scope : ['mcp:tools'],
      deviceId: config.userDeviceId,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    if (state) location.searchParams.set('state', state);
    return reply.redirect(location.toString());
  });

  // The token endpoint, both tiers. Form-encoded, or client credentials via
  // HTTP Basic. Anything unused is a 4xx with a machine-readable `error`.
  app.post('/oauth/token', async (request, reply) => {
    const config = readOAuthConfig();
    if (!config) {
      return oauthError(reply, 503, 'temporarily_unavailable', 'OAuth is not configured on this server.');
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const params = new Map<string, string>();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') params.set(key, value);
    }

    const basic = basicAuth(request.headers.authorization);
    const clientId = basic?.id ?? params.get('client_id') ?? '';
    const clientSecret = basic?.secret ?? params.get('client_secret') ?? '';
    const grantType = params.get('grant_type') ?? '';

    const clientOk =
      Boolean(config.clientId && config.clientSecret) &&
      sameSecret(clientId, config.clientId) &&
      sameSecret(clientSecret, config.clientSecret);

    if (grantType === 'client_credentials') {
      if (!clientOk) {
        return oauthError(reply, 401, 'invalid_client', 'Client authentication failed.');
      }
      // Tier 1 may only claim the service scope; anything else is downgraded.
      const requested = (params.get('scope') ?? '').split(/\s+/).filter(Boolean);
      const scope = requested.filter((s) => s === 'mcp:service');
      const deviceId = config.userDeviceId;
      if (!deviceId) {
        return oauthError(
          reply,
          503,
          'temporarily_unavailable',
          'No service device is configured (MCP_OAUTH_USER_DEVICE_ID / MCP_DEMO_DEVICE_ID).',
        );
      }
      return reply.send(issueToken(config, 'service', scope.length ? scope : ['mcp:service'], deviceId));
    }

    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const verifier = params.get('code_verifier') ?? '';
      const redirectUri = params.get('redirect_uri') ?? '';

      // Single-use: redeem and remove before any further checks.
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.expiresAt < Date.now()) {
        return oauthError(reply, 400, 'invalid_grant', 'Unknown or expired authorization code.');
      }
      if (entry.clientId && clientId !== entry.clientId) {
        return oauthError(reply, 401, 'invalid_client', 'Code was issued to a different client.');
      }
      if (redirectUri !== entry.redirectUri) {
        return oauthError(reply, 400, 'invalid_grant', 'redirect_uri does not match the one used at authorize.');
      }
      // PKCE S256: base64url(sha256(verifier)) must equal the stored challenge.
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || !sameSecret(computed, entry.codeChallenge)) {
        return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed.');
      }
      return reply.send(issueToken(config, 'user', entry.scope, entry.deviceId));
    }

    return oauthError(reply, 400, 'unsupported_grant_type', 'Supported: client_credentials, authorization_code.');
  });
}
