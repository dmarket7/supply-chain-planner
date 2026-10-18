// Writes samples/inbound-sample.xlsx: a fake report in the Meerkat inventory report layout
// ("Supplier POs" tab plus a decoy tab), for trying the import flow without real data.
// Usage: node scripts/make-sample.mjs [YYYYMMDD report date]  (default: today)
import * as fs from 'node:fs';
import * as XLSX from 'xlsx';

XLSX.set_fs(fs);

const arg = process.argv[2];
const report = arg ? new Date(`${arg.slice(0, 4)}-${arg.slice(4, 6)}-${arg.slice(6, 8)}T00:00:00Z`) : new Date();
const stamp = report.toISOString().slice(0, 10).replaceAll('-', '');
// Excel serial date, `offset` days from the report date.
const day = (offset) => Math.round(report.getTime() / 86_400_000) + 25569 + offset;

const HEADERS = [
  'POCreateDate', 'Branch', 'WarehouseLocation', 'Commodity', 'SIP', 'SupplierName', 'WintecPN', 'VendorPN',
  'Description', 'WintecPO', 'WintecPOLine', 'Meta PO', 'CRD', 'ETDDate', 'ETADate', 'POBuyPrice', 'POOrderQty',
  'ExtPOBuyPrice', 'POStatus', 'PackslipID', 'ASN', 'Tracking Num', 'Incoterm', 'META Special Instruction', 'COO',
  'Shipment Status', 'Ship From Location', 'Carrier',
];

const line = ({ supplier, pn, desc, po, ln, qty, status, etd, eta, asn = null, tracking = null, commodity = 'DRAM', coo = 'TW' }) => [
  day(-30), 'JIT-MSUS-META', 'JIT_Olive Branch_MS', commodity, 'Buy/Sell', supplier, pn, `V-${pn}`, desc, po, ln,
  '7000190000', day(-5), etd === undefined ? null : day(etd), eta === undefined ? null : day(eta), 100, qty, 100 * qty,
  status, asn ?? '', asn, tracking, 'DAP', '', coo, '', '', '',
];

const rows = [
  HEADERS,
  // Shipped, arriving over the next days
  line({ supplier: 'ACME MEMORY INC', pn: 'MET-000101', desc: 'DIMM DDR5 64GB', po: '0160001', ln: '1-1', qty: 2000, status: 'Open', etd: -3, eta: 1, asn: '26700001', tracking: '878196053414' }),
  line({ supplier: 'ACME MEMORY INC', pn: 'MET-000101', desc: 'DIMM DDR5 64GB', po: '0160001', ln: '1-2', qty: 1500, status: 'Open', etd: -3, eta: 1, asn: '26700002', tracking: '878196053414' }),
  line({ supplier: 'GLOBEX NETWORKS', pn: 'MET-000202', desc: 'NIC 200G OCP', po: '0160010', ln: '1-1', qty: 800, status: 'Open', etd: -2, eta: 3, asn: '26700010', tracking: '6007213289', commodity: 'NIC', coo: 'VN' }),
  line({ supplier: 'INITECH STORAGE', pn: 'MET-000303', desc: 'SSD 7.68TB U.2', po: '0160020', ln: '2-1', qty: 400, status: 'Open', etd: -6, eta: 2, asn: 'EX26100011A', tracking: 'HKG19921086/IS20260944701', commodity: 'SSD', coo: 'CN' }),
  line({ supplier: 'INITECH STORAGE', pn: 'MET-000303', desc: 'SSD 7.68TB U.2', po: '0160020', ln: '2-2', qty: 400, status: 'Open', etd: -6, eta: 2, asn: 'EX26100011A', tracking: '297-73979334', commodity: 'SSD', coo: 'CN' }),
  line({ supplier: 'UMBRELLA OPTICS', pn: 'MET-000404', desc: 'Transceiver 800G', po: '0160030', ln: '1-1', qty: 3000, status: 'Open', etd: -1, eta: 5, asn: '26700030', tracking: '1ZA74803E144317113', commodity: 'TRANSCEIVER', coo: 'MY' }),
  line({ supplier: 'HOOLI POWER', pn: 'MET-000505', desc: 'BBU module', po: '0160040', ln: '1-1', qty: 60, status: 'Open', etd: -4, eta: 0, asn: '26700040', tracking: 'Truck', commodity: 'Power/BBU', coo: 'MX' }),
  // Past ETA but still open: late
  line({ supplier: 'GLOBEX NETWORKS', pn: 'MET-000206', desc: 'Switch 51.2T', po: '0159990', ln: '1-1', qty: 20, status: 'Open', etd: -12, eta: -4, asn: '26699990', tracking: '3457463472', commodity: 'Switch', coo: 'TW' }),
  // Same ASN split by country of origin
  line({ supplier: 'ACME MEMORY INC', pn: 'MET-000102', desc: 'DIMM DDR5 32GB', po: '0160002', ln: '4-3', qty: 943, status: 'Open', etd: -1, eta: 4, asn: '87851017', tracking: '878102297286' }),
  line({ supplier: 'ACME MEMORY INC', pn: 'MET-000102', desc: 'DIMM DDR5 32GB', po: '0160002', ln: '4-3', qty: 2202, status: 'Open', etd: -1, eta: 4, asn: '87851017', tracking: '878102297286', coo: 'IN' }),
  // Not shipped yet
  line({ supplier: 'UMBRELLA OPTICS', pn: 'MET-000405', desc: 'Transceiver 400G', po: '0160050', ln: '1-1', qty: 5000, status: 'Open', etd: 9 }),
  line({ supplier: 'INITECH STORAGE', pn: 'MET-000304', desc: 'SSD 15.36TB E3.S', po: '0160051', ln: '1-1', qty: 250, status: 'Open', commodity: 'SSD' }),
  // Closed recently (arrived)
  line({ supplier: 'ACME MEMORY INC', pn: 'MET-000101', desc: 'DIMM DDR5 64GB', po: '0159900', ln: '1-1', qty: 1000, status: 'Closed', etd: -14, eta: -9, asn: '26690000', tracking: '877987683035' }),
  line({ supplier: 'GLOBEX NETWORKS', pn: 'MET-000202', desc: 'NIC 200G OCP', po: '0159901', ln: '1-1', qty: 500, status: 'Closed', etd: -20, eta: -15, asn: '26690001', tracking: '6013368482', commodity: 'NIC' }),
  // Closed long ago: skipped by the default 60-day window
  line({ supplier: 'ACME MEMORY INC', pn: 'MET-000100', desc: 'DIMM DDR4 32GB', po: '0150000', ln: '1-1', qty: 900, status: 'Closed', etd: -200, eta: -195, asn: '25000001', tracking: '611229363' }),
  // Closed without ETA: skipped
  line({ supplier: 'HOOLI POWER', pn: 'MET-000500', desc: 'PSU 3kW', po: '0150001', ln: '1-1', qty: 30, status: 'Closed', etd: -300 }),
];

fs.mkdirSync('samples', { recursive: true });
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Inventory Receipt Date', 'WintecPO', 'Tracking'], [day(-1), '0160001', 'X1']]), 'Transactions');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Supplier POs');
const out = `samples/Sample Inventory Report ${stamp}.xlsx`;
XLSX.writeFile(wb, out);
console.log(`Wrote ${out}`);
