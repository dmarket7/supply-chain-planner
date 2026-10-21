import { describe, expect, it } from 'vitest';
import {
  courierCandidates,
  isGenericCarrier,
  labelForRegistration,
  mappingKeyFor,
  resolveLineTracking,
  type ResolveContext,
} from '../server/tracking/couriers';
import { isStalledRegistration, needsCarrierAccount } from '../shared/couriers';
import type { TrackingRegistrationInfo } from '../shared/types';

/** Stand-in for a courier list fetched from TrackingMore; codes here are test data, not real mappings. */
const couriers = [
  { courierCode: 'dhl', name: 'DHL Express' },
  { courierCode: 'dhl-ecommerce', name: 'DHL eCommerce' },
  { courierCode: 'dhl-global-forwarding', name: 'DHL Global Forwarding' },
  { courierCode: 'dsv', name: 'DSV' },
  { courierCode: 'fedex', name: 'FedEx' },
  { courierCode: 'fedex-freight', name: 'FedEx Freight' },
  { courierCode: 'ups', name: 'UPS' },
  { courierCode: 'expeditors', name: 'Expeditors' },
];

describe('courier candidates', () => {
  it('suggests a single exact match, but only as a suggestion', () => {
    expect(courierCandidates('DSV', couriers)).toMatchObject({ suggested: 'dsv', ambiguous: false });
    expect(courierCandidates('Expeditors', couriers).candidates[0].courierCode).toBe('expeditors');
  });

  it('flags carriers with several services as ambiguous, preselecting the single exact match', () => {
    const r = courierCandidates('DHL', couriers);
    expect(r.ambiguous).toBe(true);
    expect(r.suggested).toBe('dhl');
    expect(r.candidates.map((c) => c.courierCode)).toEqual(expect.arrayContaining(['dhl', 'dhl-ecommerce', 'dhl-global-forwarding']));
  });

  it('keeps FedEx and FedEx Freight apart', () => {
    expect(courierCandidates('FedEx Freight', couriers).candidates[0].courierCode).toBe('fedex-freight');
    expect(courierCandidates('FedEx', couriers)).toMatchObject({ ambiguous: true, suggested: 'fedex' });
  });

  it('ranks "API" variants that need a carrier account after the standard service', () => {
    const list = [
      { courierCode: 'fedex-unified-api', name: 'FedEx API' },
      { courierCode: 'fedex', name: 'FedEx' },
      { courierCode: 'fedex-freight', name: 'Fedex Freight' },
      { courierCode: 'ups-unified-api', name: 'UPS API' },
      { courierCode: 'ups', name: 'UPS' },
    ];
    const r = courierCandidates('FedEx', list);
    expect(r.suggested).toBe('fedex');
    expect(r.candidates.map((c) => c.courierCode)).toEqual(['fedex', 'fedex-freight', 'fedex-unified-api']);
    expect(courierCandidates('UPS', list).suggested).toBe('ups');
    expect([needsCarrierAccount('fedex-unified-api'), needsCarrierAccount('dhl-api'), needsCarrierAccount('x', 'UPS API')]).toEqual([true, true, true]);
    expect([needsCarrierAccount('fedex', 'FedEx'), needsCarrierAccount('apitrack', 'Apitrack')]).toEqual([false, false]);
  });

  it('returns nothing for generic carriers and unsupported names', () => {
    expect(courierCandidates('Forwarder', couriers).candidates).toEqual([]);
    expect(courierCandidates('Truck', couriers).candidates).toEqual([]);
    expect(courierCandidates('Air cargo', couriers).candidates).toEqual([]);
    expect(courierCandidates('Say Cargo', couriers).candidates).toEqual([]);
    expect(isGenericCarrier(null)).toBe(true);
  });

  it('keys generic carriers by reference prefix', () => {
    expect(mappingKeyFor('Forwarder', 'CWF12345678901')).toEqual({ carrier: 'Forwarder', prefix: 'CWF' });
    expect(mappingKeyFor('DSV', 'CWF12345678901')).toEqual({ carrier: 'DSV', prefix: '' });
    expect(mappingKeyFor(null, '123456789')).toEqual({ carrier: 'Unknown', prefix: '' });
  });
});

describe('line routing', () => {
  const ctx: ResolveContext = {
    directCarriers: new Map([['FedEx', 'fedex']]),
    registrationProvider: 'trackingmore',
    mappings: [
      { carrier: 'DSV', prefix: '', courierCode: 'dsv', status: 'mapped' },
      { carrier: 'Forwarder', prefix: 'CWF', courierCode: 'dsv', status: 'mapped' },
      { carrier: 'Truck', prefix: '', courierCode: null, status: 'unsupported' },
    ],
    courierNames: new Map(couriers.map((c) => [c.courierCode, c.name])),
  };
  const reg = (over: Partial<TrackingRegistrationInfo> = {}): TrackingRegistrationInfo => ({
    id: 1,
    provider: 'trackingmore',
    courierCode: 'dsv',
    state: 'active',
    registeredAt: '2026-10-14T00:00:00Z',
    lastSyncedAt: '2026-10-16T00:00:00Z',
    lastSuccessAt: '2026-10-16T00:00:00Z',
    lastProviderStatus: 'transit',
    lastProviderSubstatus: null,
    latestEvent: null,
    latestCheckpointAt: null,
    lastError: null,
    lastErrorAt: null,
    lastWarning: null,
    ...over,
  });

  it('keeps FedEx on the direct API', () => {
    expect(resolveLineTracking({ carrier: 'FedEx', trackingNumber: '878196053414', courierOverride: null }, ctx)).toMatchObject({ label: 'direct', provider: 'fedex' });
  });

  it('routes mapped carriers and forwarder prefixes to TrackingMore', () => {
    expect(resolveLineTracking({ carrier: 'DSV', trackingNumber: 'X1', courierOverride: null }, ctx)).toMatchObject({
      label: 'not_registered',
      provider: 'trackingmore',
      courierCode: 'dsv',
      courierName: 'DSV',
      courierSource: 'mapping',
    });
    expect(resolveLineTracking({ carrier: 'Forwarder', trackingNumber: 'CWF123456', courierOverride: null }, ctx, reg())).toMatchObject({ label: 'active', courierCode: 'dsv' });
  });

  it('warns that the courier may be wrong when a registration has no scans for hours', () => {
    const line = { carrier: 'DSV', trackingNumber: 'X1', courierOverride: null };
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    expect(resolveLineTracking(line, ctx, reg({ state: 'awaiting_data', registeredAt: hoursAgo(8) }))).toMatchObject({ label: 'awaiting_data', reason: expect.stringContaining('courier may be wrong') });
    expect(resolveLineTracking(line, ctx, reg({ state: 'awaiting_data', registeredAt: hoursAgo(1) })).reason).toBeNull();
    expect(isStalledRegistration({ state: 'awaiting_data', registeredAt: hoursAgo(8), latestCheckpointAt: hoursAgo(9) })).toBe(false);
    expect(isStalledRegistration({ state: 'active', registeredAt: hoursAgo(8), latestCheckpointAt: null })).toBe(false);
  });

  it('leaves other forwarder prefixes and unknown carriers unresolved, and honours "unsupported"', () => {
    expect(resolveLineTracking({ carrier: 'Forwarder', trackingNumber: 'PNS12345678', courierOverride: null }, ctx)).toMatchObject({ label: 'unresolved', reason: expect.stringContaining('PNS') });
    expect(resolveLineTracking({ carrier: 'Sinotrans', trackingNumber: 'S1', courierOverride: null }, ctx)).toMatchObject({ label: 'unresolved' });
    expect(resolveLineTracking({ carrier: 'Truck', trackingNumber: 'T1', courierOverride: null }, ctx)).toMatchObject({ label: 'unsupported' });
    expect(resolveLineTracking({ carrier: 'DSV', trackingNumber: null, courierOverride: null }, ctx).label).toBe('no_tracking');
  });

  it('uses a confirmed per-line override, even for a generic carrier', () => {
    expect(resolveLineTracking({ carrier: 'Forwarder', trackingNumber: 'PNS12345678', courierOverride: 'expeditors' }, ctx)).toMatchObject({
      label: 'not_registered',
      courierCode: 'expeditors',
      courierSource: 'override',
    });
  });

  it('treats a registration under another courier as not registered for this one', () => {
    expect(resolveLineTracking({ carrier: 'DSV', trackingNumber: 'X1', courierOverride: null }, ctx, reg({ courierCode: 'ups' })).label).toBe('not_registered');
  });

  it('labels registrations without confusing "awaiting data" or API errors with "not found"', () => {
    expect(labelForRegistration(reg({ state: 'awaiting_data' }))).toBe('awaiting_data');
    expect(labelForRegistration(reg({ state: 'registering' }))).toBe('awaiting_data');
    expect(labelForRegistration(reg({ state: 'expired' }))).toBe('expired');
    expect(labelForRegistration(reg({ state: 'unavailable' }))).toBe('unavailable');
    expect(labelForRegistration(reg({ state: 'register_failed' }))).toBe('api_error');
    expect(labelForRegistration(reg({ lastError: 'HTTP 502', lastErrorAt: '2026-10-17T00:00:00Z' }))).toBe('api_error');
    expect(labelForRegistration(reg({ lastError: 'old', lastErrorAt: '2026-10-15T00:00:00Z' }))).toBe('active');
  });
});
