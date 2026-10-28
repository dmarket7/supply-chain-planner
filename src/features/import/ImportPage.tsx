import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkBook } from 'xlsx';
import { todayIso } from '../../../shared/dates';
import { dedupeKeysForFile } from '../../../shared/importKeys';
import { PROGRESS_BUCKETS, PROGRESS_BUCKET_LABELS } from '../../../shared/progress';
import {
  IMPORT_CHUNK_SIZE,
  INVENTORY_CHUNK_SIZE,
  OUTBOUND_CHUNK_SIZE,
  TARGET_FIELDS,
  type ColumnMapping,
  type ImportResult,
  type InventorySnapshotInfo,
  type OutboundSnapshotInfo,
  type SavedMapping,
  type ShipmentInput,
} from '../../../shared/types';
import { Card, ErrorNote, PageHeader, tableCls, tdCls, thCls } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate, poLineLabel } from '../../lib/format';
import { FIELD_LABELS, PRIMARY_FIELDS, REQUIRED_FIELDS, guessMapping } from './guessMapping';
import { normalizeRow, reportDateFromFileName, type NormalizedRow } from './normalize';
import { findInventorySheet, parseInventorySummary, type ParsedInventory } from './parseInventorySummary';
import { findOdmSheet, parseOdmOrders, type ParsedOdmOrders } from './parseOdmOrders';
import { headerSignature, parseSheet, readWorkbook, type ParsedSheet } from './parseWorkbook';
import { ImportHistory } from './ImportHistory';
import { rebuildPoHistory } from './rebuildHistory';
import { uploadChunked } from './uploadChunked';

/** The tab that holds inbound PO lines in the Meerkat report; other reports fall back to the first sheet. */
const PREFERRED_SHEET = /supplier\s*po/i;

type Bucket = 'awaiting' | 'shipped' | 'closed' | 'skipped' | 'error';
const BUCKET_LABELS: Record<Bucket, string> = {
  awaiting: 'Open · awaiting shipment',
  shipped: 'Open · shipped / has ETA',
  closed: 'Closed (arrived)',
  skipped: 'Skipped',
  error: 'Errors',
};

/** The three tabs one import covers, in the order they're saved. */
const STEPS = ['po', 'outbound', 'inventory'] as const;
type Step = (typeof STEPS)[number];
const STEP_TITLES: Record<Step, string> = { po: 'Supplier POs', outbound: 'ODM open orders', inventory: 'Inventory' };
type StepState =
  | { status: 'idle' }
  | { status: 'running'; done?: number; total?: number }
  | { status: 'done'; message: string }
  | { status: 'error'; error: unknown };
const IDLE: Record<Step, StepState> = { po: { status: 'idle' }, outbound: { status: 'idle' }, inventory: { status: 'idle' } };

/** A tab read with its own parser; error is set when the tab is there but couldn't be read. */
interface Tab<T> {
  parsed: T | null;
  error: string | null;
}
const NO_TAB = { parsed: null, error: null };

function readTab<T>(name: string | null, parse: (name: string) => T): Tab<T> {
  if (!name) return NO_TAB;
  try {
    return { parsed: parse(name), error: null };
  } catch (e) {
    return { parsed: null, error: `Couldn't read the ${name} tab: ${e instanceof Error ? e.message : e}` };
  }
}

function poResultText(r: ImportResult): string {
  const parts = [`${r.inserted.toLocaleString()} new and ${r.updated.toLocaleString()} updated lines.`];
  if (r.newlyClosed > 0) parts.push(`${r.newlyClosed} closed since the last report.`);
  if (r.promisedDateChanges > 0) parts.push(`${r.promisedDateChanges} ETAs changed.`);
  if (r.removedAwaiting > 0) parts.push(`${r.removedAwaiting} unshipped lines no longer in the report were removed.`);
  if (r.previousReportDate) {
    const changed = PROGRESS_BUCKETS.filter((b) => r.progress[b] > 0)
      .map((b) => `${r.progress[b].toLocaleString()} ${PROGRESS_BUCKET_LABELS[b].toLowerCase()}`)
      .join(', ');
    parts.push(`Since the ${formatDate(r.previousReportDate)} report: ${changed || 'no changes'}.`);
  }
  return parts.join(' ');
}

function outboundResultText(r: OutboundSnapshotInfo): string {
  const changes = r.changes
    ? ` Since ${formatDate(r.changes.previousReportDate)}: ${r.changes.noLongerListed.toLocaleString()} SOs no longer listed, ${r.changes.added.toLocaleString()} new, ${r.changes.quantityChanged.toLocaleString()} with a changed quantity; ship date pushed out on ${r.changes.summary.pushedOut.toLocaleString()} and pulled in on ${r.changes.summary.pulledIn.toLocaleString()}.`
    : '';
  return `${r.orderCount.toLocaleString()} sales orders.${changes}`;
}

function bucketOf(r: NormalizedRow): Bucket {
  if (r.errors.length) return 'error';
  if (r.skipped || !r.shipment) return 'skipped';
  const s = r.shipment;
  if (s.poStatus === 'closed' || s.actualArrivalDate) return 'closed';
  if (!s.asn && !s.trackingNumber && !s.promisedArrivalDate) return 'awaiting';
  return 'shipped';
}

export function ImportPage() {
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [workbook, setWorkbook] = useState<WorkBook | null>(null);
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mappingId, setMappingId] = useState<number | null>(null);
  const [showAllFields, setShowAllFields] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [reportDate, setReportDate] = useState(todayIso());
  const [closedWindowDays, setClosedWindowDays] = useState(60);
  const [saveName, setSaveName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Bucket | 'all' | 'warnings'>('all');
  const [odm, setOdm] = useState<Tab<ParsedOdmOrders>>(NO_TAB);
  const [inventory, setInventory] = useState<Tab<ParsedInventory>>(NO_TAB);
  const [steps, setSteps] = useState<Record<Step, StepState>>(IDLE);

  const savedMappings = useQuery({ queryKey: ['mappings'], queryFn: () => api<SavedMapping[]>('/mappings') });

  function selectSheet(wb: WorkBook, name: string) {
    const parsed = parseSheet(wb, name);
    setSheet(parsed);
    const sig = headerSignature(parsed.headers);
    const saved = savedMappings.data?.find((m) => m.headerSignature === sig);
    setMapping(saved ? saved.mapping : guessMapping(parsed.headers));
    setMappingId(saved?.id ?? null);
    setFilter('all');
  }

  async function onFile(file: File) {
    setParseError(null);
    setSteps(IDLE);
    setReading(true);
    setSheet(null);
    setOdm(NO_TAB);
    setInventory(NO_TAB);
    try {
      const data = await file.arrayBuffer();
      await new Promise((r) => setTimeout(r, 0)); // let "Reading…" paint before the blocking parse
      const wb = readWorkbook(data);
      setFileName(file.name);
      setReportDate(reportDateFromFileName(file.name) ?? todayIso());
      setWorkbook(wb);
      selectSheet(wb, wb.SheetNames.find((n) => PREFERRED_SHEET.test(n)) ?? wb.SheetNames[0]);
      setOdm(readTab(findOdmSheet(wb), (n) => parseOdmOrders(wb, n)));
      setInventory(readTab(findInventorySheet(wb), (n) => parseInventorySummary(wb, n)));
    } catch (e) {
      setParseError(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setReading(false);
    }
  }

  const normalized = useMemo(
    () =>
      sheet
        ? sheet.rows.map((r, i) => normalizeRow(r, mapping, sheet.headerRowIndex + i + 2, { reportDate, closedWindowDays }))
        : [],
    [sheet, mapping, reportDate, closedWindowDays],
  );
  const buckets = useMemo(() => {
    const counts: Record<Bucket, number> = { awaiting: 0, shipped: 0, closed: 0, skipped: 0, error: 0 };
    for (const r of normalized) counts[bucketOf(r)]++;
    return counts;
  }, [normalized]);
  const shipments = useMemo(() => normalized.flatMap((r) => (r.shipment ? [r.shipment] : [])), [normalized]);
  const carrierCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shipments) if (s.trackingNumber || s.carrier) m.set(s.carrier ?? 'Not recognized', (m.get(s.carrier ?? 'Not recognized') ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [shipments]);
  const warningRows = normalized.filter((r) => r.warnings.length && !r.errors.length && !r.skipped).length;
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  const missingIdentity = !mapping.trackingNumber && !mapping.poNumber;
  const missingDates = !mapping.promisedArrivalDate && !mapping.poStatus;
  const mappingIncomplete = missingRequired.length > 0 || missingIdentity || missingDates;

  const available: Record<Step, boolean> = {
    po: !!sheet && shipments.length > 0 && !mappingIncomplete,
    outbound: !!odm.parsed?.orders.length,
    inventory: !!inventory.parsed?.positions.length,
  };

  const runners: Record<Step, (progress: (done: number, total: number) => void) => Promise<string>> = {
    po: async (progress) => {
      let id = mappingId;
      if (saveName.trim() && sheet) {
        const saved = await api<{ id: number }>('/mappings', {
          method: 'POST',
          body: JSON.stringify({ name: saveName.trim(), mapping, headerSignature: headerSignature(sheet.headers) }),
        });
        id = saved.id;
        setSaveName('');
      }
      const keys = dedupeKeysForFile(shipments);
      const rows = shipments.map((s: ShipmentInput, i) => ({ ...s, dedupeKey: keys[i] }));
      const result = await uploadChunked<ImportResult>({
        base: '/imports',
        start: { fileName, sheetName: sheet?.name, reportDate, mappingId: id, rowCount: rows.length },
        idKey: 'importId',
        chunkPath: 'rows',
        field: 'rows',
        items: rows,
        size: IMPORT_CHUNK_SIZE,
        onProgress: progress,
      });
      if (result.needsRebuild) {
        await rebuildPoHistory(progress);
        return `Saved as of ${formatDate(reportDate)}. A report as new or newer was already imported, so the inbound history was rebuilt from every report in date order.`;
      }
      return poResultText(result);
    },
    outbound: async (progress) => {
      const p = odm.parsed!;
      const result = await uploadChunked<OutboundSnapshotInfo>({
        base: '/outbound/snapshots',
        start: { fileName, reportDate, rowCount: p.rowCount, orderCount: p.orders.length, skippedQuotations: p.skippedQuotations },
        idKey: 'snapshotId',
        chunkPath: 'orders',
        field: 'orders',
        items: p.orders,
        size: OUTBOUND_CHUNK_SIZE,
        onProgress: progress,
      });
      return outboundResultText(result);
    },
    inventory: async (progress) => {
      const p = inventory.parsed!;
      const result = await uploadChunked<InventorySnapshotInfo>({
        base: '/inventory/snapshots',
        start: { fileName, reportDate, rowCount: p.rowCount, positionCount: p.positions.length },
        idKey: 'snapshotId',
        chunkPath: 'positions',
        field: 'positions',
        items: p.positions,
        size: INVENTORY_CHUNK_SIZE,
        onProgress: progress,
      });
      return `Stock for ${p.parts.toLocaleString()} parts in ${result.positionCount.toLocaleString()} part-branch positions.`;
    },
  };

  const setStep = (step: Step, state: StepState) => setSteps((prev) => ({ ...prev, [step]: state }));
  async function runStep(step: Step) {
    setStep(step, { status: 'running' });
    try {
      const message = await runners[step]((done, total) => setStep(step, { status: 'running', done, total }));
      setStep(step, { status: 'done', message });
    } catch (error) {
      setStep(step, { status: 'error', error });
    }
  }
  /** Each tab is saved on its own, so one failing doesn't stop the others; it can be retried alone. */
  async function runAll(only?: Step) {
    for (const step of only ? [only] : STEPS.filter((s) => available[s])) await runStep(step);
    void queryClient.invalidateQueries();
  }
  const running = STEPS.some((s) => steps[s].status === 'running');
  const allDone = STEPS.filter((s) => available[s]).every((s) => steps[s].status === 'done');
  const anyAvailable = STEPS.some((s) => available[s]);

  const previewRows = useMemo(() => {
    const list =
      filter === 'all'
        ? normalized
        : filter === 'warnings'
          ? normalized.filter((r) => r.warnings.length && !r.errors.length && !r.skipped)
          : normalized.filter((r) => bucketOf(r) === filter);
    return list.slice(0, 200);
  }, [normalized, filter]);

  const select = 'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';
  const fieldsShown = showAllFields ? TARGET_FIELDS : PRIMARY_FIELDS;
  const advancedOpen = showAdvanced || (!!sheet && mappingIncomplete);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import report"
        description="Upload the weekly Meerkat inventory report (.xlsx). It's read in your browser, and one button saves the Supplier POs, ODM Open Order and Inventory Summary tabs. Set the report date to the date the report was run; reports can be imported in any order, and each one adds to the change history."
      />

      <Card>
        <label
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-8 text-center text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) void onFile(f);
          }}
        >
          <span className="font-medium">{reading ? 'Reading workbook…' : (fileName ?? 'Drop a report here or click to choose a file')}</span>
          <span className="text-slate-500">Excel or CSV</span>
          <input
            type="file"
            accept=".xlsx,.xls,.xlsm,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = '';
            }}
          />
        </label>
        {parseError && <div className="mt-3"><ErrorNote error={new Error(parseError)} /></div>}
      </Card>

      {workbook && sheet && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <TabCard
              title={STEP_TITLES.po}
              sheetName={sheet.name}
              state={steps.po}
              onRetry={() => void runAll('po')}
              disabled={running}
            >
              {mappingIncomplete ? (
                <span className="text-red-600">Some required columns aren't mapped. Map them under Advanced below.</span>
              ) : (
                <>
                  {shipments.length.toLocaleString()} PO lines: {buckets.awaiting.toLocaleString()} awaiting shipment ·{' '}
                  {buckets.shipped.toLocaleString()} shipped · {buckets.closed.toLocaleString()} closed
                  {buckets.error > 0 && <span className="text-red-600"> · {buckets.error.toLocaleString()} errors</span>}
                  {mappingId && ' · saved mapping'}
                </>
              )}
            </TabCard>
            <TabCard title={STEP_TITLES.outbound} sheetName={odm.parsed?.sheetName} error={odm.error} state={steps.outbound} onRetry={() => void runAll('outbound')} disabled={running}>
              {odm.parsed && (
                <>
                  {odm.parsed.rowCount.toLocaleString()} rows → {odm.parsed.orders.length.toLocaleString()} sales orders (reservation pieces added up) ·{' '}
                  {odm.parsed.skippedQuotations.toLocaleString()} quotation rows left out
                  {odm.parsed.unscheduledOrders > 0 && ` · ${odm.parsed.unscheduledOrders.toLocaleString()} without a ship date`}
                  {odm.parsed.errors.length > 0 && <span className="text-amber-700 dark:text-amber-300"> · {odm.parsed.errors.length} rows skipped</span>}
                </>
              )}
            </TabCard>
            <TabCard title={STEP_TITLES.inventory} sheetName={inventory.parsed?.sheetName} error={inventory.error} state={steps.inventory} onRetry={() => void runAll('inventory')} disabled={running}>
              {inventory.parsed && (
                <>
                  {inventory.parsed.parts.toLocaleString()} parts in {inventory.parsed.positions.length.toLocaleString()} part-branch positions ·{' '}
                  {inventory.parsed.closedRows.toLocaleString()} fully shipped lots left out
                  {inventory.parsed.heldUnits > 0 && ` · ${inventory.parsed.heldUnits.toLocaleString()} units held (quarantine, RMA, cycle count)`}
                  {inventory.parsed.errors.length > 0 && <span className="text-amber-700 dark:text-amber-300"> · {inventory.parsed.errors.length} rows skipped</span>}
                </>
              )}
            </TabCard>
          </div>

          <Card>
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-sm">
                <span className="mb-1 block text-slate-500">Report date</span>
                <input
                  type="date"
                  value={reportDate}
                  onChange={(e) => e.target.value && setReportDate(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <button
                disabled={!anyAvailable || running}
                onClick={() => void runAll()}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
              >
                {running ? 'Importing…' : `Import report as of ${formatDate(reportDate)}`}
              </button>
              {allDone && anyAvailable && (
                <span className="text-sm">
                  <Link to="/" className="underline">View the dashboard →</Link>{' '}
                  {steps.po.status === 'done' && <Link to="/inbound?changed=changed" className="ml-2 underline">See what changed →</Link>}
                </span>
              )}
            </div>
          </Card>

          <Card className="p-0">
            <button
              onClick={() => setShowAdvanced(!advancedOpen)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm"
              aria-expanded={advancedOpen}
            >
              <span className="font-medium">Advanced: Supplier POs columns and row preview</span>
              <span className="text-slate-400">{advancedOpen ? 'Hide' : 'Show'}</span>
            </button>
            {advancedOpen && (
              <div className="space-y-6 border-t border-slate-200 p-4 dark:border-slate-800">
                <div>
                  <div className="mb-4 flex flex-wrap items-end gap-4">
                    <p className="mr-auto text-sm text-slate-500">
                      Sheet “{sheet.name}” · header row {sheet.headerRowIndex + 1} · {sheet.rows.length.toLocaleString()} rows
                      {mappingId && ' · using saved mapping'}
                    </p>
                    {workbook.SheetNames.length > 1 && (
                      <label className="text-sm">
                        <span className="mb-1 block text-slate-500">Sheet</span>
                        <select className={select} value={sheet.name} onChange={(e) => selectSheet(workbook, e.target.value)}>
                          {workbook.SheetNames.map((n) => <option key={n}>{n}</option>)}
                        </select>
                      </label>
                    )}
                    {mapping.poStatus && (
                      <label className="text-sm">
                        <span className="mb-1 block text-slate-500">Include closed lines with ETA in the last</span>
                        <span className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={3650}
                            value={closedWindowDays}
                            onChange={(e) => setClosedWindowDays(Math.max(0, Number(e.target.value) || 0))}
                            className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                          />
                          days
                        </span>
                      </label>
                    )}
                    <label className="text-sm">
                      <span className="mb-1 block text-slate-500">Save this mapping as (optional)</span>
                      <input
                        value={saveName}
                        onChange={(e) => setSaveName(e.target.value)}
                        placeholder="e.g. Meerkat Supplier POs"
                        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                      />
                    </label>
                  </div>

                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium">Columns</h3>
                    <button onClick={() => setShowAllFields(!showAllFields)} className="text-sm text-slate-500 hover:underline">
                      {showAllFields ? 'Show main columns only' : `Show all ${TARGET_FIELDS.length} columns`}
                    </button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {fieldsShown.map((field) => (
                      <label key={field} className="text-sm">
                        <span className="mb-1 block">
                          {FIELD_LABELS[field]}
                          {REQUIRED_FIELDS.includes(field) && <span className="text-red-600"> *</span>}
                        </span>
                        <select
                          className={select}
                          value={mapping[field] ?? ''}
                          onChange={(e) => {
                            setMapping({ ...mapping, [field]: e.target.value || undefined });
                            setMappingId(null);
                          }}
                        >
                          <option value="">— not in report —</option>
                          {sheet.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                  {mappingIncomplete && (
                    <p className="mt-3 text-sm text-red-600">
                      {missingRequired.length > 0 && `Map required fields: ${missingRequired.map((f) => FIELD_LABELS[f]).join(', ')}. `}
                      {missingIdentity && 'Map a PO number or tracking number column. '}
                      {missingDates && 'Map an ETA or PO status column.'}
                    </p>
                  )}
                </div>

                <div>
                  <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
                      <button
                        key={b}
                        onClick={() => setFilter(filter === b ? 'all' : b)}
                        className={`rounded-lg border p-3 text-left ${filter === b ? 'border-slate-900 dark:border-white' : 'border-slate-200 dark:border-slate-800'}`}
                      >
                        <div className="text-xs text-slate-500">{BUCKET_LABELS[b]}</div>
                        <div className={`text-lg font-semibold tabular-nums ${b === 'error' && buckets.error ? 'text-red-600' : ''}`}>
                          {buckets[b].toLocaleString()}
                        </div>
                      </button>
                    ))}
                  </div>

                  {carrierCounts.length > 0 && (
                    <p className="mb-3 text-sm text-slate-500">
                      <span className="font-medium text-slate-700 dark:text-slate-300">Carriers: </span>
                      {carrierCounts.map(([c, n]) => `${c} ${n.toLocaleString()}`).join(' · ')}
                    </p>
                  )}

                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                    <span>
                      Showing {filter === 'all' ? 'all rows' : filter === 'warnings' ? 'rows with warnings' : BUCKET_LABELS[filter].toLowerCase()}
                      {previewRows.length === 200 && ' (first 200)'}
                    </span>
                    <button onClick={() => setFilter(filter === 'warnings' ? 'all' : 'warnings')} className="text-amber-700 hover:underline dark:text-amber-400">
                      {warningRows.toLocaleString()} rows with warnings
                    </button>
                  </div>
                  <div className="max-h-[28rem] overflow-auto">
                    <table className={tableCls}>
                      <thead className="sticky top-0 bg-white dark:bg-slate-950">
                        <tr>
                          {['Row', 'Supplier', 'PO / line', 'ASN', 'Status', 'Tracking', 'Carrier', 'ETA', 'Notes'].map((h) => <th key={h} className={thCls}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.map((r) => {
                          const s = r.shipment;
                          const raw = sheet.rows[r.rowNumber - sheet.headerRowIndex - 2];
                          return (
                            <tr key={r.rowNumber} className={r.errors.length ? 'bg-red-50 dark:bg-red-950/40' : r.skipped ? 'text-slate-400' : ''}>
                              <td className={`${tdCls} tabular-nums text-slate-500`}>{r.rowNumber}</td>
                              <td className={tdCls}>{s?.supplier ?? (mapping.supplier ? String(raw?.[mapping.supplier] ?? '—') : '—')}</td>
                              <td className={`${tdCls} whitespace-nowrap`}>{s ? poLineLabel(s) : '—'}</td>
                              <td className={`${tdCls} font-mono text-xs`}>{s?.asn ?? '—'}</td>
                              <td className={tdCls}>{s?.poStatus ?? '—'}</td>
                              <td className={`${tdCls} font-mono text-xs`}>
                                {s?.trackingNumber ?? '—'}
                                {s?.trackingRef && <div className="text-slate-500">{s.trackingRef}</div>}
                              </td>
                              <td className={tdCls}>{s?.carrier ?? '—'}</td>
                              <td className={`${tdCls} whitespace-nowrap`}>{formatDate(s?.promisedArrivalDate)}</td>
                              <td className={`${tdCls} text-xs`}>
                                {r.skipped && <div>{r.skipped}</div>}
                                {r.errors.map((e) => <div key={e} className="text-red-600">{e}</div>)}
                                {r.warnings.map((w) => <div key={w} className="text-amber-600">{w}</div>)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
      <ImportHistory />
    </div>
  );
}

/** One tab of the report: what was read, then how its import went. */
function TabCard({
  title,
  sheetName,
  error,
  state,
  onRetry,
  disabled,
  children,
}: {
  title: string;
  sheetName?: string;
  error?: string | null;
  state: StepState;
  onRetry: () => void;
  disabled: boolean;
  children?: ReactNode;
}) {
  const missing = !sheetName && !error;
  return (
    <Card className="flex flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium">{title}</h2>
        {sheetName && <span className="truncate text-xs text-slate-500">“{sheetName}”</span>}
      </div>
      <div className="mt-1 flex-1 text-sm text-slate-600 dark:text-slate-300">
        {error ? <span className="text-red-600">{error}</span> : missing ? <span className="text-slate-500">Not in this workbook; skipped.</span> : children}
      </div>
      {state.status === 'running' && (
        <div className="mt-3 text-sm text-slate-500">
          {state.total ? `Saving… ${state.done!.toLocaleString()} / ${state.total.toLocaleString()}` : 'Starting…'}
        </div>
      )}
      {state.status === 'done' && (
        <div className="mt-3 rounded-md bg-green-50 p-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">Imported {state.message}</div>
      )}
      {state.status === 'error' && (
        <div className="mt-3 space-y-2">
          <ErrorNote error={state.error} />
          <button onClick={onRetry} disabled={disabled} className="text-sm font-medium underline disabled:opacity-40">Retry {title.toLowerCase()}</button>
        </div>
      )}
    </Card>
  );
}
