import { describe, expect, it } from 'vitest';
import { applyTrackingResult, latestEventAt, lineChanged, type TrackedLine } from '../server/tracking/apply';
import type { TrackingResult } from '../server/tracking/provider';

describe('applyTrackingResult', () => {
  const line = (over: Partial<TrackedLine> = {}): TrackedLine => ({
    id: 1,
    status: 'in_transit',
    shipDate: '2026-10-05',
    actualArrivalDate: null,
    arrivalSource: null,
    ...over,
  });
  const result = (over: Partial<TrackingResult> = {}): TrackingResult => ({ trackingNumber: 'T', status: 'in_transit', events: [], ...over });

  it('updates progress and ETA for a line in transit', () => {
    expect(applyTrackingResult(line(), result({ status: 'out_for_delivery', estimatedArrivalDate: '2026-10-09' }))).toMatchObject({
      status: 'out_for_delivery',
      estimatedArrivalDate: '2026-10-09',
      actualArrivalDate: null,
      confirmedArrival: false,
    });
  });

  it('keeps the current status when the provider has nothing yet', () => {
    expect(applyTrackingResult(line({ status: 'pending' }), result({ status: null })).status).toBe('pending');
  });

  it('confirms delivery and replaces a report estimate', () => {
    const estimated = line({ status: 'delivered', actualArrivalDate: '2026-10-10', arrivalSource: 'report_window' });
    expect(applyTrackingResult(estimated, result({ status: 'delivered', deliveredAt: '2026-10-08T14:00:00.000Z' }))).toMatchObject({
      status: 'delivered',
      actualArrivalDate: '2026-10-08',
      arrivalSource: 'tracking',
      confirmedArrival: true,
    });
  });

  it('never overrides a date entered by hand', () => {
    const manual = line({ status: 'delivered', actualArrivalDate: '2026-10-07', arrivalSource: 'manual' });
    expect(applyTrackingResult(manual, result({ status: 'delivered', deliveredAt: '2026-10-08T00:00:00Z' }))).toMatchObject({
      actualArrivalDate: '2026-10-07',
      arrivalSource: 'manual',
      confirmedArrival: false,
    });
  });

  it('ignores a delivery before the line shipped (reused tracking number)', () => {
    const r = applyTrackingResult(line(), result({ status: 'delivered', deliveredAt: '2025-06-01T00:00:00Z' }));
    expect(r).toMatchObject({ status: 'in_transit', actualArrivalDate: null, confirmedArrival: false });
    expect(r.ignoredDelivery).toMatch(/reused tracking number/);
  });
});

describe('change detection', () => {
  const line: TrackedLine = {
    id: 1,
    status: 'in_transit',
    shipDate: '2026-10-05',
    estimatedArrivalDate: '2026-10-12',
    actualArrivalDate: null,
    arrivalSource: null,
    lastEventAt: '2026-10-08T10:00:00.000Z',
  };
  const result = (over: Partial<TrackingResult>): TrackingResult => ({
    trackingNumber: 'X',
    status: 'in_transit',
    estimatedArrivalDate: '2026-10-12',
    events: [{ occurredAt: '2026-10-08T10:00:00.000Z', status: 'in_transit' }],
    ...over,
  });
  const changed = (r: TrackingResult) => lineChanged(line, applyTrackingResult(line, r), latestEventAt(r));

  it('ignores a lookup that returns the same data', () => {
    expect(changed(result({}))).toBe(false);
  });

  it('flags a new scan, a moved ETA, or a delivery', () => {
    expect(changed(result({ events: [{ occurredAt: '2026-10-09T08:00:00.000Z', status: 'in_transit' }] }))).toBe(true);
    expect(changed(result({ estimatedArrivalDate: '2026-10-14' }))).toBe(true);
    expect(changed(result({ status: 'delivered', deliveredAt: '2026-10-11T15:00:00.000Z' }))).toBe(true);
  });
});
