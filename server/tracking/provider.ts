import type { RegistrationState, ShipmentMode, ShipmentStatus } from '../../shared/types';

/**
 * One tracking identity to look up. Several PO lines can share it. The same number can also belong to
 * different carriers, or be reused for a later shipment, so identities are keyed by more than the number.
 */
export interface TrackingRequest {
  trackingNumber: string;
  carrier: string | null;
  mode: ShipmentMode | null;
  /** Earliest ship date among the lines using this number; guards against recycled numbers. */
  shipDate: string | null;
  /** Identity key: `reg:<registration id>` for registered identities, `num:<number>|<carrier>` otherwise. Defaults to the number. */
  key?: string;
  /** For providers that need registration: which provider and courier code it was registered with. */
  provider?: string;
  courierCode?: string | null;
  registrationId?: number | null;
  registeredAt?: Date | string | null;
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
  /** Identity key of the request this answers (see TrackingRequest.key). */
  key?: string;
  /** Null when the provider has no information yet (keep the current status). */
  status: ShipmentStatus | null;
  estimatedArrivalDate?: string; // YYYY-MM-DD
  /** Delivery time as the carrier gave it (local time, with offset when known); its date part is the arrival date. */
  deliveredAt?: string;
  /** Carrier name as identified by the provider, if any. */
  carrier?: string;
  events: TrackingResultEvent[];
  // Registration-based providers (TrackingMore) also report:
  providerStatus?: string | null;
  providerSubstatus?: string | null;
  latestEvent?: string | null;
  latestCheckpointAt?: string | null;
  providerTrackingId?: string | null;
  registrationState?: RegistrationState;
  /** Something in the data that doesn't add up, e.g. "delivered" without a delivery time. */
  discrepancy?: string | null;
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
 * A source of tracking data: one carrier's API (`direct`, e.g. FedEx), or an aggregator that only
 * tracks numbers after they are registered with it (`registered`, e.g. TrackingMore).
 * Implementations live next to this file and are registered in registry.ts.
 */
export interface TrackingProvider {
  name: string;
  kind: 'direct' | 'registered';
  /** Carrier names (as stored on shipments) a direct provider handles; empty for registered providers. */
  carriers: readonly string[];
  supports(req: TrackingRequest): boolean;
  /** Looks up each request; results for numbers the provider couldn't find are omitted. */
  track(reqs: TrackingRequest[]): Promise<TrackingResult[]>;
}
