import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CoverageRow, LineTracking, ShipmentDetail } from '../shared/types';
import { BranchProvider } from '../src/app/branch';
import { TrackingPanel } from '../src/features/shipments/TrackingPanel';
import { changeNotice, TrackingSetupPage } from '../src/features/tracking/TrackingSetupPage';

/** Server-side render with React Query's cache pre-filled (no network); checks the screens render the right states. */
function render(node: ReturnType<typeof h>, data: [unknown[], unknown][]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, value] of data) client.setQueryData(key, value);
  return renderToString(h(QueryClientProvider, { client }, h(MemoryRouter, null, h(BranchProvider, null, node))));
}

const status = {
  configured: true,
  providers: [
    { name: 'fedex', kind: 'direct', carriers: ['FedEx'] },
    { name: 'trackingmore', kind: 'registered', carriers: [] },
  ],
  trackingMore: 'ok',
};

const row = (over: Partial<CoverageRow>): CoverageRow => ({
  carrier: 'DSV',
  prefix: '',
  label: 'DSV',
  lines: 10,
  openLines: 4,
  numbers: 6,
  registeredLines: 0,
  overrideLines: 0,
  registrations: 0,
  stalledRegistrations: 0,
  sampleNumber: null,
  route: 'unresolved',
  provider: null,
  courierCode: null,
  courierName: null,
  reason: null,
  candidates: [],
  suggested: null,
  ambiguous: false,
  ...over,
});

describe('Carrier tracking page', () => {
  it('shows coverage, mapping state and the registration preview with its credit count', () => {
    const html = render(h(TrackingSetupPage), [
      [['tracking-status'], status],
      [
        ['tracking-coverage', ''],
        {
          registrationProvider: 'trackingmore',
          courierList: { count: 1234, syncedAt: '2026-10-20T10:00:00Z' },
          rows: [
            row({ carrier: 'FedEx', label: 'FedEx', route: 'direct', provider: 'fedex' }),
            row({ carrier: 'Forwarder', prefix: 'CWF', label: 'Forwarder · CWF…', route: 'mapped', courierCode: 'dsv', courierName: 'DSV', provider: 'trackingmore' }),
            row({ carrier: 'DHL', label: 'DHL', ambiguous: true, candidates: [{ courierCode: 'dhl', name: 'DHL Express' }, { courierCode: 'dhl-ecommerce', name: 'DHL eCommerce' }] }),
            row({ carrier: 'Truck', label: 'Truck', route: 'unsupported' }),
          ],
        },
      ],
      [
        ['register-preview', 'open', 30, ''],
        {
          enabled: true,
          linesConsidered: 20,
          identitiesToRegister: 7,
          linesToRegister: 9,
          linesToLink: 2,
          alreadyRegisteredIdentities: 3,
          directLines: 5,
          unresolvedLines: 4,
          unsupportedLines: 1,
          byCourier: [{ courierCode: 'dsv', courierName: 'DSV', identities: 7, lines: 9 }],
          unresolved: [{ key: 'Forwarder · PNS…', lines: 4, reason: '' }],
        },
      ],
    ]);
    expect(html).toContain('1,234 couriers');
    expect(html).toContain('Forwarder · CWF…');
    expect(html).toContain('Direct carrier API');
    expect(html).toContain('Several services match');
    expect(html).toContain('Not supported');
    expect(html).toContain('New tracking numbers to register');
    expect(html).toMatch(/uses up to <!-- -->7<!-- --> TrackingMore credit/);
    expect(html).toContain('Forwarder · PNS… (4)');
  });
});

describe('Changing a carrier\'s courier', () => {
  it('flags "API" couriers and stalled registrations, and says what switching costs', () => {
    const mapped = row({ carrier: 'FedEx', label: 'FedEx', route: 'mapped', provider: 'trackingmore', courierCode: 'fedex-unified-api', courierName: 'FedEx API', registrations: 3, stalledRegistrations: 3, suggested: 'fedex', candidates: [{ courierCode: 'fedex', name: 'FedEx' }] });
    const html = render(h(TrackingSetupPage), [
      [['tracking-status'], { ...status, providers: [{ name: 'trackingmore', kind: 'registered', carriers: [] }] }],
      [['tracking-coverage', ''], { registrationProvider: 'trackingmore', courierList: { count: 1701, syncedAt: '2026-10-21T10:00:00Z' }, rows: [mapped] }],
    ]);
    expect(html).toContain('Needs your own carrier account');
    expect(html).toContain('Standard tracking: fedex');
    expect(html).toMatch(/3<!-- --> registered number\(s\) have no scans/);
    expect(html).toContain('Change courier');
    expect(changeNotice(mapped)).toContain('uses up to 3 credit(s)');
    expect(changeNotice({ ...mapped, registrations: 0 })).toBeNull();
  });
});

describe('Shipment tracking panel', () => {
  const shipment = (tracking: LineTracking, over: Partial<ShipmentDetail> = {}) =>
    ({ id: 1, carrier: 'Forwarder', trackingNumber: 'CWF1', estimatedArrivalDate: null, trackingFound: null, lastTrackedAt: null, tracking, events: [], progress: [], promisedDateHistory: [], ...over }) as unknown as ShipmentDetail;
  const base: LineTracking = { label: 'not_registered', provider: 'trackingmore', courierCode: 'dsv', courierName: 'DSV', courierSource: 'mapping', reason: null, registration: null };
  const reg = {
    id: 1,
    provider: 'trackingmore',
    courierCode: 'dsv',
    state: 'awaiting_data' as const,
    registeredAt: '2026-10-20T10:00:00Z',
    lastSyncedAt: null,
    lastSuccessAt: null,
    lastProviderStatus: 'notfound',
    lastProviderSubstatus: null,
    latestEvent: null,
    latestCheckpointAt: null,
    lastError: null,
    lastErrorAt: null,
    lastWarning: null,
  };
  const panel = (s: ShipmentDetail) => render(h(TrackingPanel, { shipment: s }), [[['tracking-status'], status]]);

  it('offers registration (with the credit disclosed) for an unregistered line', () => {
    const html = panel(shipment(base));
    expect(html).toContain('Not registered');
    expect(html).toContain('Uses 1 TrackingMore credit');
    expect(html).toContain('from the carrier mapping');
  });

  it('says "awaiting data" rather than "not found" after registering', () => {
    const html = panel(shipment({ ...base, label: 'awaiting_data', registration: reg }));
    expect(html).toContain('Registered · awaiting data');
    expect(html).toContain('waiting for the carrier');
    expect(html).not.toMatch(/not found/i);
  });

  it('shows the latest checkpoint, ETA and last sync for active tracking', () => {
    const html = panel(
      shipment(
        { ...base, label: 'active', registration: { ...reg, state: 'active', lastProviderStatus: 'transit', lastProviderSubstatus: 'transit001', latestEvent: 'Departed Hong Kong', latestCheckpointAt: '2026-10-16T03:00:00Z', lastSuccessAt: '2026-10-20T11:00:00Z' } },
        { estimatedArrivalDate: '2026-10-22' },
      ),
    );
    expect(html).toContain('Tracking active');
    expect(html).toContain('Departed Hong Kong');
    expect(html).toContain('transit · transit001');
    expect(html).toContain('Look up now');
  });

  it('explains API errors and unresolved carriers', () => {
    expect(panel(shipment({ ...base, label: 'api_error', registration: { ...reg, state: 'active', lastError: 'TrackingMore tracking retrieval failed: Server error (511)', lastErrorAt: '2026-10-20T11:00:00Z' } }))).toContain('Server error (511)');
    const unresolved = panel(shipment({ ...base, label: 'unresolved', provider: null, courierCode: null, courierName: null, courierSource: null, reason: 'Forwarder · PNS… is not a specific carrier' }));
    expect(unresolved).toContain('Needs courier');
    expect(unresolved).toContain('Choose courier');
  });
});
