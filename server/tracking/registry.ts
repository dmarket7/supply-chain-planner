import type { Env } from '../env';
import type { TrackingProvider } from './provider';

/**
 * Providers in priority order; the first one that supports a number handles it.
 * None yet: per-carrier API connections (FedEx, DHL, UPS, DSV, …) are added here as they're built,
 * each enabled by its own secret in `Env`.
 */
export function getProviders(_env: Env): TrackingProvider[] {
  return [];
}
