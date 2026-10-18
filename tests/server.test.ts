import { describe, expect, it } from 'vitest';
import { arrivalVariance, daysBetween } from '../shared/dates';
import type { Shipment } from '../shared/types';
import { planImport, planRow, type ExistingShipment, type IncomingRow } from '../server/importPlan';
import { describeAuthUrlProblem, normalizeAuthUrl } from '../server/auth';
import { groupInboundByDay, supplierScorecard, toArrivalEntry } from '../server/reports';

const incoming = (over: Partial<IncomingRow>): IncomingRow => ({
  dedupeKey: 'po:P1:1-1:A1',
  supplier: 'Acme',
  poNumber: 'P1',
  lineRef: '1-1',
  asn: 'A1',
  poStatus: 'open',
  promisedArrivalDate: '2026-10-08',
  ...over,
});

const existing = (over: Partial<ExistingShipment>): ExistingShipment => ({
  id: 1,
  dedupeKey: 'po:P1:1-1:A1',
  poStatus: 'open',
  status: 'in_transit',
  promisedArrivalDate: '2026-10-08',
  actualArrivalDate: null,
  arrivalSource: null,
  arrivalWindowStart: null,
  arrivalWindowEnd: null,
  lastSeenOpenReportDate: '2026-10-03',
  lastTrackedAt: null,
  ...over,
});

const shipment = (over: Partial<Shipment>): Shipment => ({
  id: 1,
  supplier: 'Acme',
  poNumber: null,
  lineRef: null,
  asn: null,
  poStatus: null,
  customerPo: null,
  partNumber: null,
  itemDescription: null,
  commodity: null,
  warehouse: null,
  quantity: null,
  carrier: 'UPS',
  mode: 'parcel',
  trackingNumber: null,
  trackingRef: null,
  requestDate: null,
  shipDate: null,
  promisedArrivalDate: '2026-10-20',
  estimatedArrivalDate: null,
  actualArrivalDate: null,
  arrivalSource: null,
  arrivalWindowStart: null,
  arrivalWindowEnd: null,
  status: 'pending',
  lastTrackedAt: null,
  ...over,
});

describe('dates', () => {
  it('computes variance; late is positive', () => {
    expect(daysBetween('2026-10-20', '2026-10-23')).toBe(3);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // across US DST change
    expect(arrivalVariance('2026-10-20', '2026-10-19')).toEqual({ varianceDays: -1, onTime: true });
    expect(arrivalVariance('2026-10-20', '2026-10-22')).toEqual({ varianceDays: 2, onTime: false });
  });
});

describe('planRow: open lines', () => {
  const report = '2026-10-10';

  it('classifies open lines by how far along they are', () => {
    expect(planRow(incoming({ asn: null, trackingNumber: null, promisedArrivalDate: null }), undefined, report).status).toBe('awaiting_shipment');
    expect(planRow(incoming({ asn: null, trackingNumber: null }), undefined, report).status).toBe('pending');
    expect(planRow(incoming({}), undefined, report).status).toBe('in_transit');
  });

  it('records the report date as the last time the line was seen open', () => {
    expect(planRow(incoming({}), undefined, report).lastSeenOpenReportDate).toBe(report);
  });

  it('keeps a tracking-only status such as an exception', () => {
    const prev = existing({ status: 'exception', lastTrackedAt: '2026-10-09T00:00:00Z' });
    expect(planRow(incoming({}), prev, report).status).toBe('exception');
  });

  it('keeps the previous ETA when the report leaves it blank', () => {
    expect(planRow(incoming({ promisedArrivalDate: null }), existing({}), report).promisedArrivalDate).toBe('2026-10-08');
  });
});

describe('planRow: closed lines', () => {
  const report = '2026-10-10';
  const prev = existing({ lastSeenOpenReportDate: '2026-10-03' });

  it('estimates arrival inside the window between reports, at the ETA when it falls inside', () => {
    expect(planRow(incoming({ poStatus: 'closed', promisedArrivalDate: '2026-10-08' }), prev, report)).toMatchObject({
      status: 'delivered',
      actualArrivalDate: '2026-10-08',
      arrivalSource: 'report_window',
      arrivalWindowStart: '2026-10-04',
      arrivalWindowEnd: '2026-10-10',
    });
  });

  it('clamps the estimate to the window: ETA before it = late, after it = early', () => {
    expect(planRow(incoming({ poStatus: 'closed', promisedArrivalDate: '2026-09-30' }), prev, report).actualArrivalDate).toBe('2026-10-04');
    expect(planRow(incoming({ poStatus: 'closed', promisedArrivalDate: '2026-10-15' }), prev, report).actualArrivalDate).toBe('2026-10-10');
  });

  it('assumes the ETA when the line was never seen open', () => {
    expect(planRow(incoming({ poStatus: 'closed' }), undefined, report)).toMatchObject({
      actualArrivalDate: '2026-10-08',
      arrivalSource: 'eta',
      arrivalWindowStart: null,
    });
  });

  it('keeps an earlier estimate for a line that was already closed', () => {
    const closed = existing({
      poStatus: 'closed',
      status: 'delivered',
      actualArrivalDate: '2026-10-01',
      arrivalSource: 'report_window',
      arrivalWindowStart: '2026-09-27',
      arrivalWindowEnd: '2026-10-03',
    });
    expect(planRow(incoming({ poStatus: 'closed' }), closed, report)).toMatchObject({
      actualArrivalDate: '2026-10-01',
      arrivalWindowEnd: '2026-10-03',
    });
  });

  it('never overrides a confirmed arrival, even when the report says open', () => {
    const confirmed = existing({ status: 'delivered', actualArrivalDate: '2026-10-06', arrivalSource: 'tracking' });
    expect(planRow(incoming({ poStatus: 'open' }), confirmed, report)).toMatchObject({
      status: 'delivered',
      actualArrivalDate: '2026-10-06',
      arrivalSource: 'tracking',
    });
  });
});

describe('planImport', () => {
  it('counts inserts, updates, newly closed lines and ETA changes', () => {
    const plan = planImport(
      [
        incoming({ dedupeKey: 'a', poStatus: 'closed', promisedArrivalDate: '2026-10-09' }),
        incoming({ dedupeKey: 'b', promisedArrivalDate: '2026-10-12' }),
        incoming({ dedupeKey: 'c' }),
      ],
      [
        existing({ dedupeKey: 'a', promisedArrivalDate: '2026-10-08' }),
        existing({ dedupeKey: 'b', promisedArrivalDate: '2026-10-12' }),
      ],
      '2026-10-10',
    );
    expect(plan).toMatchObject({ insertCount: 1, updateCount: 2, newlyClosed: 1 });
    expect(plan.promisedDateChanges).toEqual([{ dedupeKey: 'a', previousDate: '2026-10-08', newDate: '2026-10-09' }]);
  });
});

describe('reports', () => {
  it('groups inbound by expected day and leaves out lines with no date', () => {
    const days = groupInboundByDay([
      shipment({ id: 1, promisedArrivalDate: '2026-10-21' }),
      shipment({ id: 2, promisedArrivalDate: '2026-10-25', estimatedArrivalDate: '2026-10-21', carrier: 'FedEx', status: 'in_transit' }),
      shipment({ id: 3, promisedArrivalDate: '2026-10-20', carrier: null }),
      shipment({ id: 4, promisedArrivalDate: null, status: 'awaiting_shipment' }),
    ]);
    expect(days.map((d) => [d.date, d.total])).toEqual([['2026-10-20', 1], ['2026-10-21', 2]]);
    expect(days[1].byCarrier).toEqual({ UPS: 1, FedEx: 1 });
    expect(days[0].byCarrier).toEqual({ Unknown: 1 });
  });

  it('scores suppliers against the original ETA and leaves out ETA-assumed arrivals by default', () => {
    const entries = [
      toArrivalEntry({ ...shipment({ actualArrivalDate: '2026-10-22', arrivalSource: 'report_window' }), originalPromisedDate: '2026-10-20' }),
      toArrivalEntry({ ...shipment({ actualArrivalDate: '2026-10-19', arrivalSource: 'tracking' }), originalPromisedDate: '2026-10-20' }),
      toArrivalEntry({ ...shipment({ actualArrivalDate: '2026-10-20', arrivalSource: 'eta' }), originalPromisedDate: '2026-10-20' }),
      toArrivalEntry({ ...shipment({ supplier: 'Globex', actualArrivalDate: '2026-10-20', arrivalSource: 'manual' }), originalPromisedDate: '2026-10-20' }),
    ];
    expect(entries[0]).toMatchObject({ varianceDays: 2, onTime: false });
    expect(supplierScorecard(entries)).toEqual([
      { supplier: 'Acme', arrivals: 2, onTime: 1, onTimePct: 50, avgVarianceDays: 0.5 },
      { supplier: 'Globex', arrivals: 1, onTime: 1, onTimePct: 100, avgVarianceDays: 0 },
    ]);
    expect(supplierScorecard(entries, true)[0]).toMatchObject({ supplier: 'Acme', arrivals: 3, onTime: 2 });
  });
});

describe('normalizeAuthUrl', () => {
  it.each([
    ['https://ep-x.neonauth.aws.neon.tech/neondb/auth', 'https://ep-x.neonauth.aws.neon.tech/neondb/auth'],
    ['  "https://ep-x.neonauth.aws.neon.tech/neondb/auth/"  ', 'https://ep-x.neonauth.aws.neon.tech/neondb/auth'],
    ["'https://ep-x.neonauth.aws.neon.tech/neondb/auth//'", 'https://ep-x.neonauth.aws.neon.tech/neondb/auth'],
    ['', null],
    ['not a url', null],
    ['postgresql://u:p@ep-x.aws.neon.tech/neondb?sslmode=require', null],
    ['http://ep-x.neonauth.aws.neon.tech/neondb/auth', null],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeAuthUrl(raw)).toBe(expected);
  });

  it('explains a bad value without echoing it', () => {
    const problem = describeAuthUrlProblem('postgresql://user:secret@ep-x.aws.neon.tech/neondb');
    expect(problem).toMatch(/database connection string/);
    expect(problem).not.toMatch(/secret/);
    expect(describeAuthUrlProblem(undefined)).toBe('NEON_AUTH_URL is not set');
    expect(describeAuthUrlProblem('https://ep-x.neonauth.aws.neon.tech/neondb/auth')).toBeNull();
  });
});
