import type { Env } from '../env';
import type { TrackingProvider } from './provider';
import { ship24Provider } from './ship24';

/** Providers in priority order; the first one that supports a number handles it. */
export function getProviders(env: Env): TrackingProvider[] {
  const providers: TrackingProvider[] = [];
  const ship24Key = env.SHIP24_API_KEY?.trim();
  if (ship24Key) providers.push(ship24Provider(ship24Key));
  return providers;
}
