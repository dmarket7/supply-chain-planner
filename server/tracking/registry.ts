import type { Env } from '../env';
import { FEDEX_URLS, fedexProvider, type FedExEnvironment } from './fedex';
import type { TrackingProvider } from './provider';

/** Sandbox unless FEDEX_ENV says production, so test keys can't be pointed at live data by accident. */
export function fedexEnvironment(env: Env): FedExEnvironment | null {
  const value = env.FEDEX_ENV?.trim().toLowerCase() || 'sandbox';
  return value in FEDEX_URLS ? (value as FedExEnvironment) : null;
}

/**
 * Carrier API connections, each enabled by its own secrets. Providers are in priority order; the first
 * one that supports a number handles it. DHL, UPS, DSV, … get added here as they're built.
 */
export function getProviders(env: Env): TrackingProvider[] {
  const providers: TrackingProvider[] = [];
  const fedexId = env.FEDEX_CLIENT_ID?.trim();
  const fedexSecret = env.FEDEX_CLIENT_SECRET?.trim();
  const fedexEnv = fedexEnvironment(env);
  if (fedexId && fedexSecret && fedexEnv) {
    providers.push(fedexProvider({ clientId: fedexId, clientSecret: fedexSecret, environment: fedexEnv }));
  }
  return providers;
}
