// Writes samples/inbound-sample.xlsx: a fake inbound report for trying the import flow.
import * as fs from 'node:fs';
import * as XLSX from 'xlsx';

XLSX.set_fs(fs);

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
};

const rows = [
  ['Inbound Shipments Report'],
  [`Run date ${day(0)}`],
  [],
  ['Vendor', 'PO #', 'Line', 'Item Description', 'Qty', 'Ship Via', 'Tracking #', 'Ship Date', 'Promised Date', 'Date Received'],
  ['Acme Components', 'PO-10421', '1', 'Bearings 6204', 400, 'UPS', '1Z5R89390357567127', day(-3), day(1), null],
  ['Acme Components', 'PO-10421', '2', 'Seals 40mm', 1200, 'UPS Ground', '1Z999AA10123456784, 1Z5R89390357567127', day(-3), day(1), null],
  ['Globex Plastics', 'PO-10433', '1', 'Housings', 60, 'Estes Express', '1234567890', day(-5), day(0), null],
  ['Initech Metals', 'PO-10440', '1', 'Steel bar 1in', 25, 'Old Dominion', '0712345678', day(-10), day(-4), day(-2)],
  ['Initech Metals', 'PO-10441', '1', 'Steel plate', 8, 'Old Dominion', '0712345679', day(-9), day(-3), day(-3)],
  ['Umbrella Supply', 'PO-10450', '1', 'Labels', 5000, 'FedEx', '123456789012', day(-1), day(3), null],
  ['Umbrella Supply', 'PO-10451', '1', 'Cartons', 300, null, null, null, day(6), null],
  ['Hooli Electronics', 'PO-10460', '1', 'Controllers', 12, 'DHL', '1234567890', day(-2), 'TBD', null],
];

fs.mkdirSync('samples', { recursive: true });
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Open POs');
XLSX.writeFile(wb, 'samples/inbound-sample.xlsx');
console.log('Wrote samples/inbound-sample.xlsx');
