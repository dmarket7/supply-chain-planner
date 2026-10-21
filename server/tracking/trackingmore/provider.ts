import type { TrackingProvider, TrackingRequest, TrackingResult } from '../provider';
import { TrackingRateLimitError } from '../provider';
import { TRACKINGMORE_MAX_PER_CALL, type TrackingMoreClient } from './client';
import { parseTrackingMoreTracking } from './normalize';

export const TRACKINGMORE = 'trackingmore';

/**
 * TrackingMore as a tracking provider for the refresh engine. It only retrieves numbers that were
 * registered beforehand (see registration.ts): /trackings/get is free, registration costs a credit, so
 * refresh never registers anything.
 */
export function trackingMoreProvider(client: TrackingMoreClient): TrackingProvider {
  return {
    name: TRACKINGMORE,
    kind: 'registered',
    carriers: [],
    supports: (req) => req.provider === TRACKINGMORE && !!req.courierCode && !!req.registrationId,
    async track(reqs) {
      // One identity per (number, courier) at TrackingMore, so group by courier and match on the number.
      const byCourier = new Map<string, TrackingRequest[]>();
      for (const r of reqs) byCourier.set(r.courierCode!, [...(byCourier.get(r.courierCode!) ?? []), r]);
      const results: TrackingResult[] = [];
      for (const [courierCode, group] of byCourier) {
        for (let i = 0; i < group.length; i += TRACKINGMORE_MAX_PER_CALL) {
          const chunk = group.slice(i, i + TRACKINGMORE_MAX_PER_CALL);
          let found;
          try {
            found = await client.getTrackings({ trackingNumbers: chunk.map((r) => r.trackingNumber), courierCode });
          } catch (err) {
            if (err instanceof TrackingRateLimitError) throw new TrackingRateLimitError(err.retryAfterSeconds, results);
            throw err;
          }
          for (const req of chunk) {
            const t = found.find(
              (f) => f.tracking_number.toUpperCase() === req.trackingNumber.toUpperCase() && (!f.courier_code || f.courier_code === courierCode),
            );
            if (!t) continue;
            const { undatedCheckpoints, ...parsed } = parseTrackingMoreTracking(t, { registeredAt: req.registeredAt });
            if (undatedCheckpoints) console.warn(`TrackingMore ${req.trackingNumber}: ${undatedCheckpoints} checkpoint(s) without a time skipped`);
            results.push({ ...parsed, trackingNumber: req.trackingNumber, key: req.key });
          }
        }
      }
      return results;
    },
  };
}
