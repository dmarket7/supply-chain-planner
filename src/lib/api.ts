import { getToken } from './auth';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string })?.error ?? res.statusText, body);
  return body as T;
}

export const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  const s = p.toString();
  return s ? `?${s}` : '';
};
