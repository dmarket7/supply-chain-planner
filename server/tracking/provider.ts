import type { ShipmentMode, ShipmentStatus } from '../../shared/types';

/** One distinct tracking number to look up (several PO lines can share it). */
export interface TrackingRequest {
  trackingNumber: string;
  carrier: string | null;
  mode: ShipmentMode | null;
  /** Earliest ship date among the lines using this number; guards against recycled numbers. */
  shipDate: string | null;
}

export interface TrackingResultEvent {
  occurredAt: string; // ISO timestamp
  status: ShipmentStatus;
  description?: string;
  location?: string;
  raw?: unknown;
}

export interface TrackingResult {
  trackingNumber: string;
  /** Null when the provider has no information yet (keep the current status). */
  status: ShipmentStatus | null;
  estimatedArrivalDate?: string; // YYYY-MM-DD
  deliveredAt?: string; // ISO timestamp
  /** Carrier name as identified by the provider, if any. */
  carrier?: string;
  events: TrackingResultEvent[];
}

/** Thrown when the provider throttles us; carries whatever was fetched before that. */
export class TrackingRateLimitError extends Error {
  constructor(
    public retryAfterSeconds: number | null,
    public partial: TrackingResult[] = [],
  ) {
    super('Tracking provider rate limit reached');
  }
}

/**
 * A source of tracking data, typically one carrier's API.
 * Implementations live next to this file and are registered in registry.ts.
 */
export interface TrackingProvider {
  name: string;
  supports(req: TrackingRequest): boolean;
  /** Looks up each request; results for numbers the provider couldn't find are omitted. */
  track(reqs: TrackingRequest[]): Promise<TrackingResult[]>;
}
