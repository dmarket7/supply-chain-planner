import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkBook } from 'xlsx';
import { todayIso } from '../../../shared/dates';
import { dedupeKeysForFile } from '../../../shared/importKeys';
import {
  IMPORT_CHUNK_SIZE,
  TARGET_FIELDS,
  type ColumnMapping,
  type ImportResult,
  type SavedMapping,
  type ShipmentInput,
} from '../../../shared/types';
import { Card, ErrorNote, PageHeader, tableCls, tdCls, thCls } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate, poLineLabel } from '../../lib/format';
import { FIELD_LABELS, PRIMARY_FIELDS, REQUIRED_FIELDS, guessMapping } from './guessMapping';
import { normalizeRow, reportDateFromFileName, type NormalizedRow } from './normalize';
import { headerSignature, parseSheet, readWorkbook, type ParsedSheet } from './parseWorkbook';

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
  const [reportDate, setReportDate] = useState(todayIso());
  const [closedWindowDays, setClosedWindowDays] = useState(60);
  const [saveName, setSaveName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Bucket | 'all' | 'warnings'>('all');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

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
    importMutation.reset();
    setReading(true);
    setSheet(null);
    try {
      const data = await file.arrayBuffer();
      await new Promise((r) => setTimeout(r, 0)); // let "Reading…" paint before the blocking parse
      const wb = readWorkbook(data);
      setFileName(file.name);
      setReportDate(reportDateFromFileName(file.name) ?? todayIso());
      setWorkbook(wb);
      selectSheet(wb, wb.SheetNames.find((n) => PREFERRED_SHEET.test(n)) ?? wb.SheetNames[0]);
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

  const importMutation = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      let id = mappingId;
      if (saveName.trim() && sheet) {
        const saved = await api<{ id: number }>('/mappings', {
          method: 'POST',
          body: JSON.stringify({ name: saveName.trim(), mapping, headerSignature: headerSignature(sheet.headers) }),
        });
        id = saved.id;
      }
      const keys = dedupeKeysForFile(shipments);
      const rows = shipments.map((s: ShipmentInput, i) => ({ ...s, dedupeKey: keys[i] }));
      const { importId } = await api<{ importId: number }>('/imports', {
        method: 'POST',
        body: JSON.stringify({ fileName, sheetName: sheet?.name, reportDate, mappingId: id, rowCount: rows.length }),
      });
      setProgress({ done: 0, total: rows.length });
      for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
        const part = rows.slice(i, i + IMPORT_CHUNK_SIZE);
        await api(`/imports/${importId}/rows`, { method: 'POST', body: JSON.stringify({ rows: part }) });
        setProgress({ done: i + part.length, total: rows.length });
      }
      return api<ImportResult>(`/imports/${importId}/complete`, { method: 'POST', body: '{}' });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
      setSaveName('');
    },
    onSettled: () => setProgress(null),
  });

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
  const canImport = shipments.length > 0 && !missingRequired.length && !missingIdentity && !missingDates && !importMutation.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import report"
        description="Upload the inventory report (.xlsx). It's read in your browser; only the extracted PO lines are saved. Import weekly reports oldest first."
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
        <Card>
          <div className="mb-4 flex flex-wrap items-end gap-4">
            <div className="mr-auto">
              <h2 className="font-medium">Report settings</h2>
              <p className="text-sm text-slate-500">
                Sheet “{sheet.name}” · header row {sheet.headerRowIndex + 1} · {sheet.rows.length.toLocaleString()} rows
                {mappingId && ' · using saved mapping'}
              </p>
            </div>
            {workbook.SheetNames.length > 1 && (
              <label className="text-sm">
                <span className="mb-1 block text-slate-500">Sheet</span>
                <select className={select} value={sheet.name} onChange={(e) => selectSheet(workbook, e.target.value)}>
                  {workbook.SheetNames.map((n) => <option key={n}>{n}</option>)}
                </select>
              </label>
            )}
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Report date</span>
              <input
                type="date"
                value={reportDate}
                onChange={(e) => e.target.value && setReportDate(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
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
          {(missingRequired.length > 0 || missingIdentity || missingDates) && (
            <p className="mt-3 text-sm text-red-600">
              {missingRequired.length > 0 && `Map required fields: ${missingRequired.map((f) => FIELD_LABELS[f]).join(', ')}. `}
              {missingIdentity && 'Map a PO number or tracking number column. '}
              {missingDates && 'Map an ETA or PO status column.'}
            </p>
          )}
        </Card>
      )}

      {sheet && (
        <Card>
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

          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Save this mapping as (optional)</span>
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="e.g. Meerkat Supplier POs"
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <button
              disabled={!canImport}
              onClick={() => importMutation.mutate()}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            >
              {importMutation.isPending
                ? progress
                  ? `Importing… ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
                  : 'Starting…'
                : `Import ${shipments.length.toLocaleString()} lines as of ${formatDate(reportDate)}`}
            </button>
          </div>
          {importMutation.error && <div className="mt-3"><ErrorNote error={importMutation.error} /></div>}
          {importMutation.data && (
            <div className="mt-3 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">
              Imported {importMutation.data.inserted.toLocaleString()} new and {importMutation.data.updated.toLocaleString()} updated lines.
              {importMutation.data.newlyClosed > 0 && ` ${importMutation.data.newlyClosed} closed since the last report.`}
              {importMutation.data.promisedDateChanges > 0 && ` ${importMutation.data.promisedDateChanges} ETAs changed.`}
              {importMutation.data.removedAwaiting > 0 && ` ${importMutation.data.removedAwaiting} unshipped lines no longer in the report were removed.`}{' '}
              <Link to="/" className="underline">View inbound by day →</Link>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
