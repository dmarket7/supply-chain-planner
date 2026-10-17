import type { Env } from '../env';
import { manualProvider } from './manual';
import type { TrackingProvider } from './provider';

/** Providers in priority order; the first one that supports a shipment handles it. */
export function getProviders(_env: Env): TrackingProvider[] {
  return [manualProvider];
}
