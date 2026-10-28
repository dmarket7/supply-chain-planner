import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CoverageRow, LineTracking, OutboundResponse, PalletRatioRow, PalletRatiosResponse, Shipment, ShipmentDetail } from '../shared/types';
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

describe('pallet views', () => {
  it('shows inbound in pallets by default and calls out estimated and missing ratios', async () => {
    const { addDays, todayIso } = await import('../shared/dates');
    const { RatioLookup } = await import('../shared/pallets');
    const { groupInboundByDay, groupInboundByPart, withPallets } = await import('../server/reports');
    const { InboundByDayPage } = await import('../src/features/inbound/InboundByDayPage');
    const today = todayIso();
    const base = { supplier: 'Acme', carrier: 'UPS', mode: 'parcel', status: 'in_transit', promisedArrivalDate: today, estimatedArrivalDate: null, actualArrivalDate: null };
    const lines = withPallets(
      [
        { ...base, id: 1, partNumber: 'A', commodity: 'SSD', quantity: 2000 },
        { ...base, id: 2, partNumber: 'B', commodity: 'SSD', quantity: 420 },
        { ...base, id: 3, partNumber: 'C', commodity: 'HDD', quantity: 50 },
      ] as unknown as Shipment[],
      new RatioLookup([{ partNumber: 'A', unitsPerPallet: 840, palletsPerTruck: 26, productGroup: 'SSD', source: 'file' }]),
    );
    const html = render(h(InboundByDayPage), [
      [['inbound-by-day', addDays(today, -7), addDays(today, 21), ''], { from: '', to: '', days: groupInboundByDay(lines), parts: groupInboundByPart(lines) }],
    ]);
    expect(html).toContain('Pallets today');
    expect(html).toMatch(/2\.9<\/div>/); // 2000/840 + 420/840
    expect(html).toContain('2 full + 2 partial');
    expect(html).toContain('/settings/pallets?filter=needs-data');
    expect(html).toContain('Improve pallet ratios');
    expect(html).toContain('By part');
  });

  it('lists parts that need ratio data on the settings page', async () => {
    const { PalletRatiosPage } = await import('../src/features/settings/PalletRatiosPage');
    const row = (over: Partial<PalletRatioRow>): PalletRatioRow => ({
      partNumber: 'A',
      itemName: 'SSD 2TB',
      commodity: 'SSD',
      unitsPerPallet: 840,
      palletsPerTruck: 26,
      canDoubleStack: false,
      note: null,
      source: 'file',
      fileValues: { unitsPerPallet: 840, palletsPerTruck: 26 },
      updatedBy: 'x',
      updatedAt: null,
      basis: 'real',
      effectiveUnitsPerPallet: 840,
      conflict: false,
      openLines: 1,
      openUnits: 100,
      outboundOrders: 0,
      outboundUnits: 0,
      ...over,
    });
    const data: PalletRatiosResponse = {
      rows: [
        row({}),
        row({ partNumber: 'B', unitsPerPallet: null, basis: 'estimated', effectiveUnitsPerPallet: 840, estimate: { commodity: 'SSD', parts: 1 } }),
        row({ partNumber: 'C', commodity: 'HDD', unitsPerPallet: null, source: null, basis: 'none', effectiveUnitsPerPallet: null }),
        row({ partNumber: 'D', unitsPerPallet: null, basis: 'estimated', openLines: 0, openUnits: 0 }),
      ],
      estimates: [{ commodity: 'SSD', unitsPerPallet: 840, palletsPerTruck: 26, parts: 1, min: 840, max: 840, wideSpread: false }],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['pallet-ratios'], data);
    const html = renderToString(
      h(QueryClientProvider, { client }, h(MemoryRouter, { initialEntries: ['/settings/pallets?filter=needs-data'] }, h(PalletRatiosPage))),
    );
    expect(html).toContain('>B<');
    expect(html).toContain('>C<');
    expect(html).not.toContain('>A<'); // real ratio
    expect(html).not.toContain('>D<'); // no open inbound
    expect(html).toMatch(/No real ratios yet, so no estimate for: (<!-- -->)?HDD/);
  });
});

describe('outbound page', () => {
  it('shows pallets and trucks per ship-to, with what changed since the last report', async () => {
    const { addDays, todayIso } = await import('../shared/dates');
    const { RatioLookup } = await import('../shared/pallets');
    const { outboundReport } = await import('../server/reports');
    const { OutboundPage } = await import('../src/features/outbound/OutboundPage');
    const today = todayIso();
    const lookup = new RatioLookup([{ partNumber: 'A', unitsPerPallet: 100, palletsPerTruck: 26, productGroup: 'SSD', source: 'file' }]);
    const base = { emsPo: null, status: 'Reserved Physical', warehouse: null, manufacturer: null, packagingType: null, totalPrice: null, sourceRows: 1, shipDateSource: 'confirmed' as const, scheduledShipDate: null, confirmedShipDate: null, dockDate: null, originalRequestDate: null, poReceiptDate: null, itemName: null };
    const orders = [
      { ...base, id: 1, soNumber: '1', shipTo: 'CELESTICA LLC-RICHARDSON', cpn: 'A', mpn: 'MPN-A', businessGroup: 'SSD', quantity: 1300, shipDate: addDays(today, 1) },
      { ...base, id: 2, soNumber: '2', shipTo: 'CELESTICA LLC-RICHARDSON', cpn: 'B', mpn: 'MPN-B', businessGroup: 'SSD', quantity: 1300, shipDate: addDays(today, 1) },
    ].map((o) => ({ ...o, pallets: lookup.line(o.cpn, o.businessGroup, o.quantity), supply: null, changes: [] }));
    const data: OutboundResponse = {
      from: '',
      to: '',
      snapshot: { id: 1, fileName: 'r.xlsx', reportDate: '2026-10-18', rowCount: 3, orderCount: 2, skippedQuotations: 1, changes: { previousReportDate: '2026-10-10', noLongerListed: 928, added: 350, quantityChanged: 26, summary: { added: 350, gone: 928, pushedOut: 0, pulledIn: 0, newlyConfirmed: 0, dockMoved: 0, quantity: 26, status: 0, noCause: 0 } } },
      inventoryReportDate: null,
      ...outboundReport(orders, addDays(today, -7), addDays(today, 28), today),
    };
    const html = render(h(OutboundPage), [[['outbound', addDays(today, -7), addDays(today, 28), ''], data]]);
    expect(html).toContain('CELESTICA LLC-RICHARDSON');
    expect(html).toMatch(/928 SOs(<!-- -->)? no longer listed/);
    expect(html).toContain('Trucks next 7 days');
    expect(html).toMatch(/26\.0<\/div>/); // 13 real + 13 estimated pallets
    expect(html).toContain('/settings/pallets?filter=needs-data');
  });

  it('explains how to get outbound data before the first import', async () => {
    const { addDays, todayIso } = await import('../shared/dates');
    const { outboundReport } = await import('../server/reports');
    const { OutboundPage } = await import('../src/features/outbound/OutboundPage');
    const today = todayIso();
    const data: OutboundResponse = { from: '', to: '', snapshot: null, inventoryReportDate: null, ...outboundReport([], today, today, today) };
    const html = render(h(OutboundPage), [[['outbound', addDays(today, -7), addDays(today, 28), ''], data]]);
    expect(html).toContain('No outbound orders yet');
  });
});

describe('dashboard and inventory pages', () => {
  async function fixture() {
    const { addDays, todayIso } = await import('../shared/dates');
    const { RatioLookup } = await import('../shared/pallets');
    const { checkSupply } = await import('../shared/supply');
    const { dashboard, supplyParts } = await import('../server/dashboard');
    const today = todayIso();
    const ratios = new RatioLookup([{ partNumber: 'A', unitsPerPallet: 100, palletsPerTruck: 26, productGroup: 'SSD', source: 'file' }]);
    const base = { emsPo: null, warehouse: 'JIT-MSUS-META', manufacturer: null, packagingType: null, totalPrice: null, sourceRows: 1, shipDateSource: 'confirmed' as const, scheduledShipDate: null, confirmedShipDate: null, dockDate: null, poReceiptDate: null, itemName: null, cpn: 'A', mpn: 'MPN-A', businessGroup: 'SSD' };
    const orders = [
      { ...base, id: 1, soNumber: 'SO-READY', status: 'Reserved Physical', shipTo: 'CELESTICA LLC-RICHARDSON', quantity: 200, shipDate: addDays(today, 1) },
      { ...base, id: 2, soNumber: 'SO-SHORT', status: 'On order', shipTo: 'CELESTICA LLC-RICHARDSON', quantity: 300, shipDate: addDays(today, 2) },
    ];
    const positions = [{ partNumber: 'A', branch: 'JIT-MSUS-META', vendorPn: 'MPN-A', description: 'SSD A', commodity: 'SSD', onhand: 200, reserved: 200, available: 0, onReceipt: 0 }];
    const supply = {
      outbound: { reportDate: today },
      inventory: { id: 1, fileName: 'r.xlsx', reportDate: today, rowCount: 1, positionCount: 1 },
      orders,
      inbound: [],
      positions,
      check: checkSupply(positions, orders, []),
      changes: new Map(),
    } as unknown as Parameters<typeof dashboard>[0];
    return { today, supply, dash: dashboard(supply, ratios, today, today), parts: supplyParts(supply) };
  }

  it('shows the weekly flow, can-ship share and the short part', async () => {
    const { DashboardPage } = await import('../src/features/dashboard/DashboardPage');
    const { dash } = await fixture();
    expect(dash.exceptions.shortParts.count).toBe(1);
    const html = render(h(DashboardPage), [[['dashboard', ''], dash]]);
    expect(html).toContain('Where we&#x27;re stuck');
    expect(html).toContain('Can ship, next 7 days');
    expect(html).toMatch(/>40%</); // 200 of 500 units
    expect(html).toContain('Outbound at risk');
    expect(html).not.toContain('SO-SHORT'); // issue rows start closed
  });

  it('lists parts with their supply status', async () => {
    const { InventoryPage } = await import('../src/features/inventory/InventoryPage');
    const { parts, today } = await fixture();
    const html = render(h(InventoryPage), [[['supply', ''], { inventory: { id: 1, fileName: 'r.xlsx', reportDate: today, rowCount: 1, positionCount: 1 }, outboundReportDate: today, parts }]]);
    expect(html).toContain('>A<');
    expect(html).toContain('>Short<');
    expect(html).toContain('300');
  });
});
