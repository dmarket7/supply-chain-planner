import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { ESTIMATED_ARRIVAL_SOURCES } from '../../shared/types';
import type { Db } from '../db/client';
import { shipments, trackingEvents } from '../db/schema';
import type { TrackingProvider, TrackingRequest } from './provider';

/**
 * Pulls tracking for shipments that haven't arrived, or whose arrival date is only an estimate
 * from the report, and writes events, status, ETA and arrival date.
 * Shared by the API route and (later) a cron Worker.
 */
export async function refreshTracking(db: Db, providers: TrackingProvider[], shipmentIds?: number[]) {
  const open = await db
    .select({
      shipmentId: shipments.id,
      carrier: shipments.carrier,
      mode: shipments.mode,
      trackingNumber: shipments.trackingNumber,
    })
    .from(shipments)
    .where(
      and(
        isNotNull(shipments.trackingNumber),
        or(isNull(shipments.actualArrivalDate), inArray(shipments.arrivalSource, [...ESTIMATED_ARRIVAL_SOURCES])),
        shipmentIds?.length ? inArray(shipments.id, shipmentIds) : undefined,
      ),
    );

  const byProvider = new Map<TrackingProvider, TrackingRequest[]>();
  let unsupported = 0;
  for (const s of open as TrackingRequest[]) {
    const provider = providers.find((p) => p.supports(s));
    if (!provider) {
      unsupported++;
      continue;
    }
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), s]);
  }

  let updated = 0;
  for (const [provider, reqs] of byProvider) {
    for (const result of await provider.track(reqs)) {
      const delivered = result.deliveredAt?.slice(0, 10);
      await db.batch([
        db
          .update(shipments)
          .set({
            status: result.status,
            estimatedArrivalDate: result.estimatedArrivalDate ?? null,
            ...(delivered
              ? { actualArrivalDate: delivered, arrivalSource: 'tracking' as const, arrivalWindowStart: null, arrivalWindowEnd: null }
              : {}),
            lastTrackedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, result.shipmentId)),
        db.delete(trackingEvents).where(
          and(eq(trackingEvents.shipmentId, result.shipmentId), eq(trackingEvents.provider, provider.name)),
        ),
        ...(result.events.length
          ? [
              db.insert(trackingEvents).values(
                result.events.map((e) => ({
                  shipmentId: result.shipmentId,
                  occurredAt: new Date(e.occurredAt),
                  status: e.status,
                  description: e.description ?? null,
                  location: e.location ?? null,
                  provider: provider.name,
                  raw: e.raw ?? null,
                })),
              ),
            ]
          : []),
      ]);
      updated++;
    }
  }
  return { checked: open.length, updated, unsupported };
}
