import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CoverageRow, ImportHistoryRow, SupplierPerformanceResponse, LineTracking, OutboundResponse, PalletRatioRow, PalletRatiosResponse, Shipment, ShipmentDetail } from '../shared/types';
import { BranchProvider } from '../src/app/branch';
import { TrackingPanel } from '../src/features/shipments/TrackingPanel';
import { changeNotice, TrackingSetupPage } from '../src/features/tracking/TrackingSetupPage';

/** Server-side render with React Query's cache pre-filled (no network); checks the screens render the right states. */
function render(node: ReturnType<typeof h>, data: [unknown[], unknown][], path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, value] of data) client.setQueryData(key, value);
  return renderToString(h(QueryClientProvider, { client }, h(MemoryRouter, { initialEntries: [path] }, h(BranchProvider, null, node))));
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
  async function inboundFixture() {
    const { addDays, todayIso } = await import('../shared/dates');
    const { RatioLookup } = await import('../shared/pallets');
    const { groupInboundByDay, groupInboundByPart, withPallets } = await import('../server/reports');
    const today = todayIso();
    const base = { supplier: 'Acme', carrier: 'UPS', mode: 'parcel', status: 'in_transit', promisedArrivalDate: today, estimatedArrivalDate: null, actualArrivalDate: null, latestChange: null };
    const lines = withPallets(
      [
        { ...base, id: 1, poNumber: 'PO-TODAY', partNumber: 'A', commodity: 'SSD', quantity: 2000 },
        { ...base, id: 2, poNumber: 'PO-TODAY-2', partNumber: 'B', commodity: 'SSD', quantity: 420 },
        { ...base, id: 3, poNumber: 'PO-HDD', partNumber: 'C', commodity: 'HDD', quantity: 50, promisedArrivalDate: addDays(today, 2) },
        { ...base, id: 4, poNumber: 'PO-UNDATED', partNumber: 'A', commodity: 'SSD', quantity: 10, status: 'awaiting_shipment', promisedArrivalDate: null },
      ] as unknown as Shipment[],
      new RatioLookup([{ partNumber: 'A', unitsPerPallet: 840, palletsPerTruck: 26, productGroup: 'SSD', source: 'file' }]),
    );
    const dated = lines.filter((l) => l.promisedArrivalDate);
    const data: [unknown[], unknown][] = [
      [['inbound-by-day', addDays(today, -7), addDays(today, 21), ''], { from: '', to: '', days: groupInboundByDay(dated), parts: groupInboundByPart(dated) }],
      [['shipments', ''], lines],
      [['progress-latest', ''], null],
    ];
    return { today, addDays, data };
  }

  it('shows inbound in pallets by default and calls out estimated and missing ratios', async () => {
    const { InboundPage } = await import('../src/features/inbound/InboundPage');
    const { data } = await inboundFixture();
    const html = render(h(InboundPage), data, '/inbound');
    expect(html).toContain('Pallets today');
    expect(html).toMatch(/2\.9<\/div>/); // 2000/840 + 420/840
    expect(html).toContain('2 full + 2 partial');
    expect(html).toContain('/settings/pallets?filter=needs-data');
    expect(html).toContain('Improve pallet ratios');
    expect(html).toContain('By part');
    // The table lists lines expected in the range; lines with no date yet sit behind their chip.
    expect(html).toContain('PO-HDD');
    expect(html).not.toContain('PO-UNDATED');
  });

  it('filters the lines to a day picked on the chart, or to those with no date yet', async () => {
    const { InboundPage } = await import('../src/features/inbound/InboundPage');
    const { data, today, addDays } = await inboundFixture();
    const day = render(h(InboundPage), data, `/inbound?date=${addDays(today, 2)}`);
    expect(day).toContain('PO-HDD');
    expect(day).not.toContain('PO-TODAY');
    const undated = render(h(InboundPage), data, '/inbound?dates=undated');
    expect(undated).toContain('PO-UNDATED');
    expect(undated).not.toContain('PO-HDD');
  });

  it('sends old Shipments links to Inbound', async () => {
    const { inboundPathForShipments } = await import('../src/app/App');
    expect(inboundPathForShipments(new URLSearchParams('progress=eta_moved'))).toBe('/inbound?changed=eta_moved');
    expect(inboundPathForShipments(new URLSearchParams())).toBe('/inbound');
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
  async function outboundFixture() {
    const { addDays, todayIso } = await import('../shared/dates');
    const { RatioLookup } = await import('../shared/pallets');
    const { outboundReport } = await import('../server/reports');
    const today = todayIso();
    const lookup = new RatioLookup([{ partNumber: 'A', unitsPerPallet: 100, palletsPerTruck: 26, productGroup: 'SSD', source: 'file' }]);
    const base = { emsPo: null, status: 'Reserved Physical', warehouse: null, manufacturer: null, packagingType: null, totalPrice: null, sourceRows: 1, shipDateSource: 'confirmed' as const, scheduledShipDate: null, confirmedShipDate: null, dockDate: null, originalRequestDate: null, poReceiptDate: null, itemName: null };
    const moved = [{ kind: 'confirmed_date' as const, from: addDays(today, -6), to: addDays(today, 1), causes: ['customer' as const] }];
    const orders = [
      { ...base, id: 1, soNumber: 'SO-MOVED', shipTo: 'CELESTICA LLC-RICHARDSON', cpn: 'A', mpn: 'MPN-A', businessGroup: 'SSD', quantity: 1300, shipDate: addDays(today, 1), dockDate: addDays(today, -2), changes: moved },
      { ...base, id: 2, soNumber: 'SO-LATER', shipTo: 'CELESTICA LLC-RICHARDSON', cpn: 'B', mpn: 'MPN-B', businessGroup: 'SSD', quantity: 1300, shipDate: addDays(today, 3), changes: [] },
    ].map((o) => ({ ...o, pallets: lookup.line(o.cpn, o.businessGroup, o.quantity), supply: null }));
    const summary = { added: 350, gone: 928, pushedOut: 1, pulledIn: 0, newlyConfirmed: 0, dockMoved: 0, quantity: 26, status: 0, noCause: 0 };
    const data: OutboundResponse = {
      from: '',
      to: '',
      snapshot: { id: 1, fileName: 'r.xlsx', reportDate: '2026-10-18', rowCount: 3, orderCount: 2, skippedQuotations: 1, changes: { previousReportDate: '2026-10-10', noLongerListed: 928, added: 350, quantityChanged: 26, summary } },
      inventoryReportDate: null,
      ...outboundReport(orders, addDays(today, -7), addDays(today, 28), today),
    };
    return { today, addDays, data, key: ['outbound', addDays(today, -7), addDays(today, 28), ''] };
  }

  it('lists orders with what changed since the last report and how far after the customer request they ship', async () => {
    const { OutboundPage } = await import('../src/features/outbound/OutboundPage');
    const { data, key } = await outboundFixture();
    const html = render(h(OutboundPage), [[key, data]]);
    expect(html).toContain('SO-MOVED');
    expect(html).toContain('SO-LATER');
    expect(html).toMatch(/928<\/span> (<!-- -->)?SOs no longer listed/);
    expect(html).toMatch(/1<\/span> (<!-- -->)?ship date pushed out/);
    expect(html).toContain('Confirmed ship date');
    expect(html).toContain('customer moved the dock date');
    expect(html).toContain('3d after');
    expect(html).toContain('Trucks next 7 days');
    expect(html).toMatch(/26\.0<\/div>/); // 13 real + 13 estimated pallets
    expect(html).toContain('/settings/pallets?filter=needs-data');
  });

  it('filters the orders to the day picked on the chart', async () => {
    const { OutboundPage } = await import('../src/features/outbound/OutboundPage');
    const { data, key, today, addDays } = await outboundFixture();
    const html = render(h(OutboundPage), [[key, data]], `/outbound?date=${addDays(today, 3)}`);
    expect(html).toContain('SO-LATER');
    expect(html).not.toContain('SO-MOVED');
    expect(html).toContain('Remove filter Ships');
  });

  it('shows ship-to totals in the By ship-to view', async () => {
    const { OutboundPage } = await import('../src/features/outbound/OutboundPage');
    const { data, key } = await outboundFixture();
    const html = render(h(OutboundPage), [[key, data]], '/outbound?view=shipto');
    expect(html).toContain('By ship-to');
    expect(html).toContain('CELESTICA LLC-RICHARDSON');
    expect(html).not.toContain('SO-MOVED');
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

  it('filters to parts whose available stock changed since the previous inventory', async () => {
    const { InventoryPage } = await import('../src/features/inventory/InventoryPage');
    const { parts, today } = await fixture();
    const withChange = [{ ...parts[0], availableChange: -120 }, { ...parts[0], partNumber: 'STEADY', availableChange: 0 }];
    const html = render(h(InventoryPage), [[['supply', ''], { inventory: { id: 1, fileName: 'r.xlsx', reportDate: today, rowCount: 1, positionCount: 1 }, outboundReportDate: today, parts: withChange }]], '/inventory?filter=changed');
    expect(html).toContain('-120');
    expect(html).not.toContain('STEADY');
  });
});

describe('import history', () => {
  it('links the newest report\'s changes to the filtered views', async () => {
    const { ImportHistory } = await import('../src/features/import/ImportHistory');
    const summary = { added: 3, gone: 2, pushedOut: 155, pulledIn: 125, newlyConfirmed: 0, dockMoved: 154, quantity: 13, status: 0, noCause: 114 };
    const counts = { shipped: 4, arrived: 5, eta_moved: 6, tracking: 0, new_order: 7, reopened: 0 };
    const rows: ImportHistoryRow[] = [
      { reportDate: '2026-10-18', inbound: { importId: 2, fileName: 'b', counts, linesStored: true }, outbound: { snapshotId: 2, orderCount: 10, summary }, inventory: { snapshotId: 2, positionCount: 9, up: 8, down: 1 } },
      { reportDate: '2026-10-10', inbound: { importId: 1, fileName: 'a', counts, linesStored: false }, outbound: { snapshotId: 1, orderCount: 9, summary: null }, inventory: null },
    ];
    const html = render(h(ImportHistory), [[['import-history'], rows]]);
    expect(html).toContain('/outbound?changed=pushed');
    expect(html).toContain('/inbound?changed=eta_moved');
    expect(html).toContain('/inventory?filter=changed');
    expect(html).toMatch(/114(<!-- -->)? date moves with no cause/);
    expect(html).toContain('first report');
    expect(html.match(/href="\/inbound\?changed=eta_moved"/g)).toHaveLength(1); // only the newest row links
    expect(html).toContain('imported before reports could be added out of order');
    expect(html).toContain('Delete…');
  });
});

describe('data table', () => {
  it('sorts blanks last, hides columns, and renders only the rows in view for long tables', async () => {
    const { DataTable } = await import('../src/components/DataTable');
    type Row = { id: number; name: string; qty: number | null };
    const columns = [
      { id: 'name', label: 'Name', sortValue: (r: Row) => r.name, render: (r: Row) => `name-${r.name}` },
      { id: 'qty', label: 'Qty', sortValue: (r: Row) => r.qty, render: (r: Row) => `qty-${r.qty ?? 'none'}` },
      { id: 'secret', label: 'Secret', render: () => 'hidden-cell', defaultHidden: true },
    ];
    const saved = { visible: ['name', 'qty'], sort: { id: 'qty', dir: 'desc' } };
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem: () => {} });
    try {
      const rows: Row[] = [{ id: 1, name: 'a', qty: 5 }, { id: 2, name: 'b', qty: null }, { id: 3, name: 'c', qty: 20 }];
      const html = renderToString(h(DataTable<Row>, { id: 't', rows, columns, rowKey: (r) => r.id }));
      expect(html.indexOf('qty-20')).toBeLessThan(html.indexOf('qty-5'));
      expect(html.indexOf('qty-5')).toBeLessThan(html.indexOf('qty-none'));
      expect(html).toContain('aria-sort="descending"');
      expect(html).not.toContain('hidden-cell');

      const many = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `n${i}`, qty: i }));
      const long = renderToString(h(DataTable<Row>, { id: 't', rows: many, columns, rowKey: (r) => r.id }));
      expect(long).toMatch(/2,000(<!-- -->)? rows/);
      expect((long.match(/<tbody data-index/g) ?? []).length).toBeLessThan(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('performance page', () => {
  it('shows the supplier scorecard, worst first, with status flags', async () => {
    const { PerformancePage } = await import('../src/features/performance/PerformancePage');
    const { lastMonths } = await import('../shared/performance');
    const months = lastMonths('2026-10-29', 6).map((month) => ({ month, count: 6, onTimePct: 30 }));
    const ot = (count: number, onTime: number) => ({ count, onTime, onTimePct: count ? Math.round((onTime / count) * 1000) / 10 : null, medianDaysLate: count > onTime ? 9 : null });
    const data: SupplierPerformanceResponse = {
      from: '2026-07-31', to: '2026-10-29', period: 90, includeHistory: false, firstUpload: '2026-10-10',
      totals: { arrival: ot(20, 8), previousArrival: ot(10, 6), ship: ot(4, 3), historyArrivals: 300, suppliers: 2, consistentlyLate: 1, gettingWorse: 0, etaMoves: 7 },
      trend: { arrival: months, ship: months },
      suppliers: [
        { supplier: 'SLOW PARTS', status: 'consistently_late', arrival: ot(16, 4), ship: ot(2, 1), lines: 20, openLines: 4, etaMovesPerLine: 0.5, etdAfterRequestPct: 60, months },
        { supplier: 'FAST PARTS', status: 'reliable', arrival: ot(4, 4), ship: ot(2, 2), lines: 4, openLines: 0, etaMovesPerLine: 0, etdAfterRequestPct: 0, months },
      ],
    };
    const html = render(h(PerformancePage), [[['performance-suppliers', '', '90', false], data]], '/performance');
    expect(html).toContain('Supplier scorecard');
    expect(html.indexOf('SLOW PARTS')).toBeLessThan(html.indexOf('FAST PARTS'));
    expect(html).toContain('Consistently late');
    expect(html).toContain('Reliable');
    expect(html).toMatch(/40%/); // 8 of 20 received on time
    expect(html).toMatch(/-20 pts vs the period before/);
    expect(html).toMatch(/300(<!-- -->)? more lines were received/);
  });
});
