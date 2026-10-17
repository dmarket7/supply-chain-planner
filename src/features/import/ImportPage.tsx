import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkBook } from 'xlsx';
import { TARGET_FIELDS, type ColumnMapping, type ImportResult, type SavedMapping } from '../../../shared/types';
import { Card, ErrorNote, PageHeader, tableCls, tdCls, thCls } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { FIELD_LABELS, REQUIRED_FIELDS, guessMapping } from './guessMapping';
import { normalizeRow } from './normalize';
import { headerSignature, parseSheet, readWorkbook, type ParsedSheet } from './parseWorkbook';

export function ImportPage() {
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<WorkBook | null>(null);
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mappingId, setMappingId] = useState<number | null>(null);
  const [saveName, setSaveName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [showOnly, setShowOnly] = useState<'all' | 'issues'>('all');

  const savedMappings = useQuery({ queryKey: ['mappings'], queryFn: () => api<SavedMapping[]>('/mappings') });

  function selectSheet(wb: WorkBook, name: string) {
    const parsed = parseSheet(wb, name);
    setSheet(parsed);
    const sig = headerSignature(parsed.headers);
    const saved = savedMappings.data?.find((m) => m.headerSignature === sig);
    setMapping(saved ? saved.mapping : guessMapping(parsed.headers));
    setMappingId(saved?.id ?? null);
  }

  async function onFile(file: File) {
    setParseError(null);
    importMutation.reset();
    try {
      const wb = readWorkbook(await file.arrayBuffer());
      setFileName(file.name);
      setWorkbook(wb);
      selectSheet(wb, wb.SheetNames[0]);
    } catch (e) {
      setParseError(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const normalized = useMemo(
    () => (sheet ? sheet.rows.map((r, i) => normalizeRow(r, mapping, sheet.headerRowIndex + i + 2)) : []),
    [sheet, mapping],
  );
  const shipments = normalized.flatMap((r) => r.shipments);
  const errorRows = normalized.filter((r) => r.errors.length).length;
  const warningRows = normalized.filter((r) => r.warnings.length).length;
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  const missingIdentity = !mapping.trackingNumber && !mapping.poNumber;

  const importMutation = useMutation({
    mutationFn: async () => {
      let id = mappingId;
      if (saveName.trim() && sheet) {
        const saved = await api<{ id: number }>('/mappings', {
          method: 'POST',
          body: JSON.stringify({ name: saveName.trim(), mapping, headerSignature: headerSignature(sheet.headers) }),
        });
        id = saved.id;
      }
      return api<ImportResult>('/imports', {
        method: 'POST',
        body: JSON.stringify({ fileName, mappingId: id, rows: shipments }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
      setSaveName('');
    },
  });

  const previewRows = (showOnly === 'issues' ? normalized.filter((r) => r.errors.length || r.warnings.length) : normalized).slice(0, 200);
  const select = 'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';

  return (
    <div className="space-y-6">
      <PageHeader title="Import report" description="Upload the inbound shipments report (.xlsx, .xls or .csv). The file is read in your browser; only the extracted shipments are saved." />

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
          <span className="font-medium">{fileName ?? 'Drop a report here or click to choose a file'}</span>
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
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-medium">Map columns</h2>
              <p className="text-sm text-slate-500">
                Header row {sheet.headerRowIndex + 1} · {sheet.rows.length} data rows
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
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {TARGET_FIELDS.map((field) => (
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
          {(missingRequired.length > 0 || missingIdentity) && (
            <p className="mt-3 text-sm text-red-600">
              {missingRequired.length > 0 && `Map required fields: ${missingRequired.map((f) => FIELD_LABELS[f]).join(', ')}. `}
              {missingIdentity && 'Map a tracking number or PO number column.'}
            </p>
          )}
        </Card>
      )}

      {sheet && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-medium">{shipments.length} shipments</span> from {normalized.length - errorRows} rows
              {errorRows > 0 && <span className="text-red-600"> · {errorRows} rows skipped (errors)</span>}
              {warningRows > 0 && <span className="text-amber-600"> · {warningRows} with warnings</span>}
            </div>
            <div className="flex gap-1 text-sm">
              {(['all', 'issues'] as const).map((v) => (
                <button key={v} onClick={() => setShowOnly(v)} className={`rounded-md px-2 py-1 ${showOnly === v ? 'bg-slate-200 dark:bg-slate-800' : ''}`}>
                  {v === 'all' ? 'All rows' : 'Only issues'}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[28rem] overflow-auto">
            <table className={tableCls}>
              <thead className="sticky top-0 bg-white dark:bg-slate-950">
                <tr>
                  {['Row', 'Supplier', 'PO', 'Carrier', 'Tracking', 'Promised', 'Arrived', 'Notes'].map((h) => <th key={h} className={thCls}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r) => {
                  const list = r.shipments.length ? r.shipments : [null];
                  return list.map((s, i) => (
                    <tr key={`${r.rowNumber}-${i}`} className={r.errors.length ? 'bg-red-50 dark:bg-red-950/40' : ''}>
                      <td className={`${tdCls} tabular-nums text-slate-500`}>{i === 0 ? r.rowNumber : ''}</td>
                      <td className={tdCls}>{s?.supplier ?? '—'}</td>
                      <td className={tdCls}>{s?.poNumber ?? '—'}</td>
                      <td className={tdCls}>{s?.carrier ?? '—'}{s?.mode && <span className="ml-1 text-xs text-slate-500">{s.mode.toUpperCase()}</span>}</td>
                      <td className={`${tdCls} font-mono text-xs`}>{s?.trackingNumber ?? '—'}</td>
                      <td className={tdCls}>{formatDate(s?.promisedArrivalDate)}</td>
                      <td className={tdCls}>{formatDate(s?.actualArrivalDate)}</td>
                      <td className={`${tdCls} text-xs`}>
                        {i === 0 && r.errors.map((e) => <div key={e} className="text-red-600">{e}</div>)}
                        {i === 0 && r.warnings.map((w) => <div key={w} className="text-amber-600">{w}</div>)}
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
          {previewRows.length === 200 && <p className="mt-2 text-xs text-slate-500">Showing the first 200 rows.</p>}

          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Save this mapping as (optional)</span>
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="e.g. Weekly inbound report"
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <button
              disabled={!shipments.length || missingRequired.length > 0 || missingIdentity || importMutation.isPending}
              onClick={() => importMutation.mutate()}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            >
              {importMutation.isPending ? 'Importing…' : `Import ${shipments.length} shipments`}
            </button>
          </div>
          {importMutation.error && <div className="mt-3"><ErrorNote error={importMutation.error} /></div>}
          {importMutation.data && (
            <div className="mt-3 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">
              Imported: {importMutation.data.inserted} new, {importMutation.data.updated} updated
              {importMutation.data.promisedDateChanges > 0 && `, ${importMutation.data.promisedDateChanges} promised dates changed`}.{' '}
              <Link to="/" className="underline">View inbound by day →</Link>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
