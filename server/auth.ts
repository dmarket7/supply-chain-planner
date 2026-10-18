import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './env';

// Cached per isolate; jose handles key rotation and refetching.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(authUrl: string) {
  let jwks = jwksByUrl.get(authUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${authUrl}/.well-known/jwks.json`));
    jwksByUrl.set(authUrl, jwks);
  }
  return jwks;
}

/** Tolerates common copy/paste slips in the secret: whitespace, quotes, trailing slashes. */
export function normalizeAuthUrl(raw: string | undefined): string | null {
  const s = raw?.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (!s) return null;
  try {
    return new URL(s).toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Why a token was rejected, without echoing the token. Safe to return to the client. */
function rejectionReason(err: unknown): string {
  if (err instanceof errors.JWTExpired) return 'expired';
  if (err instanceof errors.JWTClaimValidationFailed) return `claim "${err.claim}" mismatch`;
  if (err instanceof errors.JWKSNoMatchingKey) return 'no matching signing key';
  if (err instanceof errors.JWSSignatureVerificationFailed) return 'bad signature';
  if (
    err instanceof errors.JWKSInvalid ||
    err instanceof errors.JWKSTimeout ||
    (err instanceof errors.JOSEError && /JSON Web Key Set/i.test(err.message))
  ) {
    return 'could not load signing keys; check NEON_AUTH_URL';
  }
  if (err instanceof errors.JOSEError) return err.code;
  return 'unexpected error';
}

/** Verifies the Neon Auth JWT in `Authorization: Bearer <token>` and sets `userId`. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authUrl = normalizeAuthUrl(c.env.NEON_AUTH_URL);
  if (!authUrl) {
    console.error('NEON_AUTH_URL is missing or not a URL');
    return c.json({ error: 'Server auth is not configured (NEON_AUTH_URL)' }, 500);
  }

  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const { payload } = await jwtVerify(header.slice(7), getJwks(authUrl), {
      issuer: new URL(authUrl).origin,
    });
    if (!payload.sub) return c.json({ error: 'Invalid token', reason: 'no subject' }, 401);
    c.set('userId', payload.sub);
  } catch (err) {
    const reason = rejectionReason(err);
    console.warn(`Token rejected: ${reason}; auth host ${new URL(authUrl).host}`);
    return c.json({ error: 'Invalid token', reason }, 401);
  }
  await next();
});
