import type { Env } from '../env';
import { FEDEX_URLS, fedexProvider, type FedExEnvironment } from './fedex';
import type { TrackingProvider } from './provider';
import { trackingMoreClient, type TrackingMoreClient } from './trackingmore/client';
import { trackingMoreProvider } from './trackingmore/provider';

/** Sandbox unless FEDEX_ENV says production, so test keys can't be pointed at live data by accident. */
export function fedexEnvironment(env: Env): FedExEnvironment | null {
  const value = env.FEDEX_ENV?.trim().toLowerCase() || 'sandbox';
  return value in FEDEX_URLS ? (value as FedExEnvironment) : null;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? '');

/** TrackingMore needs both the key and TRACKINGMORE_ENABLED, so a key can be stored without being used. */
export function trackingMoreConfig(env: Env): { state: 'off' | 'disabled' | 'missing_key' | 'ok'; apiKey: string | null } {
  const apiKey = env.TRACKINGMORE_API_KEY?.trim() || null;
  const enabled = truthy(env.TRACKINGMORE_ENABLED);
  if (!enabled) return { state: apiKey ? 'disabled' : 'off', apiKey: null };
  if (!apiKey) return { state: 'missing_key', apiKey: null };
  return { state: 'ok', apiKey };
}

/** The TrackingMore client, or null when it isn't enabled. The key never leaves the server. */
export function getTrackingMoreClient(env: Env, fetchImpl?: typeof fetch): TrackingMoreClient | null {
  const { apiKey } = trackingMoreConfig(env);
  return apiKey ? trackingMoreClient(apiKey, fetchImpl) : null;
}

/**
 * Tracking providers in priority order. Direct carrier APIs come first and keep their carriers
 * (FedEx lines go to the FedEx API when it is configured); TrackingMore handles registered identities
 * of every other mapped carrier. A tracking identity is only ever sent to one provider.
 */
export function getProviders(env: Env): TrackingProvider[] {
  const providers: TrackingProvider[] = [];
  const fedexId = env.FEDEX_CLIENT_ID?.trim();
  const fedexSecret = env.FEDEX_CLIENT_SECRET?.trim();
  const fedexEnv = fedexEnvironment(env);
  if (fedexId && fedexSecret && fedexEnv) {
    providers.push(fedexProvider({ clientId: fedexId, clientSecret: fedexSecret, environment: fedexEnv }));
  }
  const tm = getTrackingMoreClient(env);
  if (tm) providers.push(trackingMoreProvider(tm));
  return providers;
}

/** Carrier -> direct provider name, for routing lines. */
export function directCarrierMap(providers: TrackingProvider[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of providers) if (p.kind === 'direct') for (const c of p.carriers) if (!map.has(c)) map.set(c, p.name);
  return map;
}
