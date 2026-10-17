import type { ShipmentMode, ShipmentStatus } from '../../shared/types';

export interface TrackingRequest {
  shipmentId: number;
  carrier: string | null;
  mode: ShipmentMode | null;
  trackingNumber: string;
}

export interface TrackingResultEvent {
  occurredAt: string; // ISO timestamp
  status: ShipmentStatus;
  description?: string;
  location?: string;
  raw?: unknown;
}

export interface TrackingResult {
  shipmentId: number;
  status: ShipmentStatus;
  estimatedArrivalDate?: string; // YYYY-MM-DD
  deliveredAt?: string; // ISO timestamp
  events: TrackingResultEvent[];
}

/**
 * A source of tracking data: an aggregator (Ship24, AfterShip, ...) or a single carrier API.
 * Implementations live next to this file and are registered in registry.ts.
 */
export interface TrackingProvider {
  name: string;
  supports(req: TrackingRequest): boolean;
  track(reqs: TrackingRequest[]): Promise<TrackingResult[]>;
}
