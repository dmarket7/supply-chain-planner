import type { TrackingProvider } from './provider';

/** Placeholder until a real provider is chosen: arrivals are entered by hand. */
export const manualProvider: TrackingProvider = {
  name: 'manual',
  supports: () => false,
  track: async () => [],
};
