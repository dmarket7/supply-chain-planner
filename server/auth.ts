import { createRemoteJWKSet, jwtVerify } from 'jose';
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

/** Verifies the Neon Auth JWT in `Authorization: Bearer <token>` and sets `userId`. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);

  const authUrl = c.env.NEON_AUTH_URL;
  try {
    const { payload } = await jwtVerify(header.slice(7), getJwks(authUrl), {
      issuer: new URL(authUrl).origin,
    });
    if (!payload.sub) return c.json({ error: 'Invalid token' }, 401);
    c.set('userId', payload.sub);
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }
  await next();
});
