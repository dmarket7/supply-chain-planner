import * as XLSX from 'xlsx';
import { daysBetween } from '../../../shared/dates';
import { median, SUPPLIER_STATUS_LABELS, type ReportLine } from '../../../shared/performance';
import type { SupplierReportResponse } from '../../../shared/types';

type Cell = XLSX.CellObject | string | number | null;
interface Col {
  label: string;
  width: number;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
/** An ISO date as a real Excel date, so it sorts and filters as one. */
const date = (iso: string | null): Cell => {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return { t: 'n', v: (Date.UTC(y, m - 1, d) - EXCEL_EPOCH) / 86_400_000, z: 'yyyy-mm-dd' };
};
const pct = (v: number | null): Cell => (v === null ? null : { t: 'n', v: v / 100, z: '0%' });

/** A header row plus data rows, with column widths and a filter on the header. */
function table(cols: Col[], rows: Cell[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([cols.map((c) => c.label), ...rows]);
  ws['!cols'] = cols.map((c) => ({ wch: c.width }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: cols.length - 1 } }) };
  return ws;
}

const LINE_COLS: Col[] = [
  { label: 'Supplier', width: 28 },
  { label: 'PO', width: 12 },
  { label: 'Line', width: 7 },
  { label: 'ASN', width: 16 },
  { label: 'Part', width: 22 },
  { label: 'Branch', width: 22 },
  { label: 'Qty', width: 9 },
];
const lineCells = (l: ReportLine): Cell[] => [l.supplier, l.poNumber, l.lineRef, l.asn, l.partNumber, l.branch, l.quantity];

export function supplierWorkbook(r: SupplierReportResponse): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    table(
      [
        { label: 'Supplier', width: 28 },
        { label: 'Status (today)', width: 18 },
        { label: 'Received', width: 10 },
        { label: 'Measured', width: 10 },
        { label: 'On time', width: 9 },
        { label: 'Late', width: 8 },
        { label: 'On-time %', width: 10 },
        { label: 'Median days late', width: 10 },
        { label: 'Max days late', width: 10 },
        { label: 'Open past due (today)', width: 12 },
        { label: 'ETA changes', width: 10 },
        { label: 'Lines with ETA changes', width: 12 },
        { label: 'Days ETA pushed', width: 10 },
        { label: 'ETD changes', width: 10 },
        { label: 'Shipped (measured)', width: 11 },
        { label: 'Shipped late', width: 9 },
        { label: 'First ETD after request %', width: 12 },
      ],
      r.suppliers.map((s) => [
        s.supplier,
        s.status ? SUPPLIER_STATUS_LABELS[s.status] : null,
        s.received,
        s.measured,
        s.onTime,
        s.late,
        pct(s.onTimePct),
        s.medianDaysLate,
        s.maxDaysLate,
        s.openPastDue,
        s.etaChanges,
        s.linesWithEtaChanges,
        s.etaDaysPushed,
        s.etdChanges,
        s.shipMeasured,
        s.shippedLate,
        pct(s.etdAfterRequestPct),
      ]),
    ),
    'Suppliers',
  );

  XLSX.utils.book_append_sheet(
    wb,
    table(
      [
        ...LINE_COLS,
        { label: 'Requested ship (CRD)', width: 12 },
        { label: 'First ETD', width: 12 },
        { label: 'First ETA', width: 12 },
        { label: 'First ETA seen in upload', width: 12 },
        { label: 'Final ETA', width: 12 },
        { label: 'Received', width: 12 },
        { label: 'Days late', width: 9 },
        { label: 'Measured against', width: 12 },
        { label: 'ETA changes', width: 9 },
        { label: 'Days ETA pushed', width: 9 },
        { label: 'ETD changes', width: 9 },
        { label: 'Shipped', width: 12 },
        { label: 'Ship days late', width: 9 },
      ],
      r.late.map((l) => [
        ...lineCells(l),
        date(l.requestDate),
        date(l.firstEtd),
        date(l.firstEta),
        date(l.firstEtaSeen),
        date(l.finalEta),
        date(l.arrived),
        l.daysLate,
        l.baseline === 'final' ? 'Final ETA' : 'First ETA',
        l.etaChanges,
        l.etaDaysPushed,
        l.etdChanges,
        date(l.shipped),
        l.shipDaysLate,
      ]),
    ),
    'Late deliveries',
  );

  XLSX.utils.book_append_sheet(
    wb,
    table(
      [
        ...LINE_COLS,
        { label: 'First ETA', width: 12 },
        { label: 'Current ETA', width: 12 },
        { label: 'Days past first ETA', width: 10 },
        { label: 'ETA changes', width: 9 },
        { label: 'Current ETD', width: 12 },
        { label: 'ETD changes', width: 9 },
      ],
      r.openPastDue.map((l) => [...lineCells(l), date(l.firstEta), date(l.finalEta), l.daysLate, l.etaChanges, date(l.finalEtd), l.etdChanges]),
    ),
    'Open past due',
  );

  XLSX.utils.book_append_sheet(
    wb,
    table(
      [
        { label: 'Upload', width: 12 },
        { label: 'Supplier', width: 28 },
        { label: 'PO', width: 12 },
        { label: 'Line', width: 7 },
        { label: 'ASN', width: 16 },
        { label: 'Qty', width: 9 },
        { label: 'Part', width: 22 },
        { label: 'Branch', width: 22 },
        { label: 'Date', width: 6 },
        { label: 'From', width: 12 },
        { label: 'To', width: 12 },
        { label: 'Days moved (+ later)', width: 11 },
      ],
      r.changes.map((c) => [date(c.reportDate), c.supplier, c.poNumber, c.lineRef, c.asn, c.quantity, c.partNumber, c.branch, c.field, date(c.from), date(c.to), c.days]),
    ),
    'Date changes',
  );

  XLSX.utils.book_append_sheet(
    wb,
    table(
      [
        { label: 'Supplier', width: 28 },
        { label: 'Month', width: 9 },
        { label: 'Received (measured)', width: 11 },
        { label: 'Late', width: 8 },
        { label: 'On-time %', width: 10 },
        { label: 'Median days late', width: 10 },
        { label: 'ETA changes', width: 10 },
      ],
      r.months.map((m) => [m.supplier, m.month, m.measured, m.late, pct(m.onTimePct), m.medianDaysLate, m.etaChanges]),
    ),
    'By month',
  );

  const gaps = r.uploads.slice(1).map((d, i) => daysBetween(r.uploads[i], d));
  const about: Cell[][] = [
    ['Supplier performance report'],
    [],
    ['Received between', date(r.from), date(r.to)],
    ['Warehouse', r.branch ?? 'All'],
    ['Created', date(r.today)],
    ['Supplier POs uploads in range', r.uploads.length, r.uploads.length ? `${r.uploads[0]} to ${r.uploads[r.uploads.length - 1]}` : null],
    ['Typical days between uploads', median(gaps)],
    ['Promises known from', date(r.firstUpload)],
    ['Lines received before their promise was recorded', r.includeHistory ? 'Included, measured against the final ETA' : 'Left out'],
    [],
    ['How to read it'],
    ['Late', 'Received at Wintec (Inventory Summary MaterialRecDate) any day after the first ETA our uploads recorded. No grace days.'],
    ['Measured', 'Received lines whose ETA we recorded before they arrived. Lines received before that are left out unless included above.'],
    ['ETA / ETD changes', 'Counted when an upload shows a different date than the upload before it. Several moves between two uploads count as one.'],
    ['Days ETA pushed', 'Total days the ETA moved later across those changes.'],
    ['Open past due', 'Not received or closed today, and past the first ETA.'],
    ['Shipped late', 'The supplier shipped after the first ETD we recorded; measured only when the ETD moved after we first saw it.'],
    ['First ETD after request %', "Share of lines whose first ETD was already after Meta's requested ship date (CRD)."],
    ['Status (today)', 'Consistently late: at least half late in each of the last 3 months with 5+ arrivals. Getting worse: last 30 days 20+ points worse than the 90 days before. Reliable: 90%+ on time on 10+ arrivals.'],
    ['Final ETA', 'Suppliers often move the ETA to the receipt date, so lines measured against the final ETA understate lateness.'],
  ];
  const aboutWs = XLSX.utils.aoa_to_sheet(about);
  aboutWs['!cols'] = [{ wch: 42 }, { wch: 100 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, aboutWs, 'About');
  return wb;
}

export const supplierWorkbookName = (r: SupplierReportResponse) => `supplier-performance_${r.branch ? `${r.branch}_` : ''}${r.from}_${r.to}.xlsx`;

export function downloadSupplierWorkbook(r: SupplierReportResponse) {
  XLSX.writeFile(supplierWorkbook(r), supplierWorkbookName(r), { compression: true });
}
