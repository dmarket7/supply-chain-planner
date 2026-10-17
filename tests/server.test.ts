import { describe, expect, it } from 'vitest';
import { arrivalVariance, daysBetween } from '../shared/dates';
import type { Shipment, ShipmentInput } from '../shared/types';
import { dedupeKey, planImport } from '../server/importPlan';
import { groupInboundByDay, supplierScorecard, toArrivalEntry } from '../server/reports';

const input = (over: Partial<ShipmentInput>): ShipmentInput => ({
  supplier: 'Acme',
  promisedArrivalDate: '2026-10-20',
  ...over,
});

const shipment = (over: Partial<Shipment>): Shipment => ({
  id: 1,
  supplier: 'Acme',
  poNumber: null,
  lineRef: null,
  itemDescription: null,
  quantity: null,
  carrier: 'UPS',
  mode: 'parcel',
  trackingNumber: null,
  shipDate: null,
  promisedArrivalDate: '2026-10-20',
  estimatedArrivalDate: null,
  actualArrivalDate: null,
  arrivalSource: null,
  status: 'pending',
  lastTrackedAt: null,
  ...over,
});

describe('dates', () => {
  it('computes variance; late is positive', () => {
    expect(daysBetween('2026-10-20', '2026-10-23')).toBe(3);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // across US DST change
    expect(arrivalVariance('2026-10-20', '2026-10-19')).toEqual({ varianceDays: -1, onTime: true });
    expect(arrivalVariance('2026-10-20', '2026-10-20')).toEqual({ varianceDays: 0, onTime: true });
    expect(arrivalVariance('2026-10-20', '2026-10-22')).toEqual({ varianceDays: 2, onTime: false });
  });
});

describe('planImport', () => {
  const suppliers = new Map([['Acme', 1], ['Globex', 2]]);

  it('keys by tracking number, else supplier+PO+line', () => {
    expect(dedupeKey(input({ trackingNumber: '1z 123' }), 1)).toBe('trk:1Z123');
    expect(dedupeKey(input({ poNumber: 'po-9', lineRef: '2' }), 1)).toBe('po:1:PO-9:2');
  });

  it('collapses duplicates, counts inserts/updates and finds promised-date changes', () => {
    const plan = planImport(
      [
        input({ trackingNumber: 'A', promisedArrivalDate: '2026-10-20' }),
        input({ trackingNumber: 'A', promisedArrivalDate: '2026-10-21' }), // dup in file, last wins
        input({ trackingNumber: 'B', promisedArrivalDate: '2026-10-22' }),
        input({ supplier: 'Globex', poNumber: 'P1' }),
      ],
      suppliers,
      [
        { id: 10, dedupeKey: 'trk:A', promisedArrivalDate: '2026-10-18' },
        { id: 11, dedupeKey: 'trk:B', promisedArrivalDate: '2026-10-22' },
      ],
    );
    expect(plan.rows).toHaveLength(3);
    expect(plan.insertCount).toBe(1);
    expect(plan.updateCount).toBe(2);
    expect(plan.promisedDateChanges).toEqual([
      { dedupeKey: 'trk:A', previousDate: '2026-10-18', newDate: '2026-10-21' },
    ]);
  });
});

describe('reports', () => {
  it('groups inbound by expected day, preferring tracking ETA', () => {
    const days = groupInboundByDay([
      shipment({ id: 1, promisedArrivalDate: '2026-10-21' }),
      shipment({ id: 2, promisedArrivalDate: '2026-10-25', estimatedArrivalDate: '2026-10-21', carrier: 'FedEx', status: 'in_transit' }),
      shipment({ id: 3, promisedArrivalDate: '2026-10-20', carrier: null }),
    ]);
    expect(days.map((d) => [d.date, d.total])).toEqual([['2026-10-20', 1], ['2026-10-21', 2]]);
    expect(days[1].byCarrier).toEqual({ UPS: 1, FedEx: 1 });
    expect(days[1].byStatus).toEqual({ pending: 1, in_transit: 1 });
    expect(days[0].byCarrier).toEqual({ Unknown: 1 });
  });

  it('scores suppliers against the original promised date', () => {
    const entries = [
      toArrivalEntry({ ...shipment({ actualArrivalDate: '2026-10-22' }), originalPromisedDate: '2026-10-20' }),
      toArrivalEntry({ ...shipment({ actualArrivalDate: '2026-10-19' }), originalPromisedDate: '2026-10-20' }),
      toArrivalEntry({ ...shipment({ supplier: 'Globex', actualArrivalDate: '2026-10-20' }), originalPromisedDate: '2026-10-20' }),
    ];
    expect(entries[0]).toMatchObject({ varianceDays: 2, onTime: false });
    expect(supplierScorecard(entries)).toEqual([
      { supplier: 'Acme', arrivals: 2, onTime: 1, onTimePct: 50, avgVarianceDays: 0.5 },
      { supplier: 'Globex', arrivals: 1, onTime: 1, onTimePct: 100, avgVarianceDays: 0 },
    ]);
  });
});
