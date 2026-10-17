import { createAuthClient } from '@neondatabase/neon-js/auth';

export const authClient = createAuthClient(import.meta.env.VITE_NEON_AUTH_URL);

/** Neon Auth puts a JWT in session.token; the API verifies it against the JWKS. */
export async function getToken(): Promise<string | null> {
  const { data } = await authClient.getSession();
  return data?.session?.token ?? null;
}
