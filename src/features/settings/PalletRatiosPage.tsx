import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommodityEstimate } from '../../../shared/pallets';
import type { PalletRatioEdit, PalletRatioFileRow, PalletRatioImportResult, PalletRatioRow, PalletRatiosResponse } from '../../../shared/types';
import { BasisBadge, Card, Empty, ErrorNote, PageHeader, tableCls, tdCls, thCls } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { readWorkbook } from '../import/parseWorkbook';
import { parsePalletRatios } from './parsePalletRatios';

const btn = 'rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700';
const primary = 'rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900';
const input = 'w-24 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900';

export const RATIO_FILTERS = {
  'needs-data': { label: 'Needs data', hint: 'Estimated or no ratio, with open inbound', test: (r: PalletRatioRow) => r.basis !== 'real' && r.openLines > 0 },
  all: { label: 'All', hint: 'Every part', test: () => true },
  estimated: { label: 'Estimated', hint: 'Using a commodity average', test: (r: PalletRatioRow) => r.basis === 'estimated' },
  none: { label: 'No ratio', hint: 'No ratio for the part or its commodity', test: (r: PalletRatioRow) => r.basis === 'none' },
  real: { label: 'Real', hint: 'Own ratio', test: (r: PalletRatioRow) => r.basis === 'real' },
  manual: { label: 'Manual', hint: 'Entered here', test: (r: PalletRatioRow) => r.source === 'manual' },
  conflicts: { label: 'Differs from file', hint: 'Manual value differs from the latest upload', test: (r: PalletRatioRow) => r.conflict },
} as const;
type FilterKey = keyof typeof RATIO_FILTERS;

const num = (v: number | null) => (v == null ? '—' : v.toLocaleString());
const unitsPerTruck = (r: Pick<PalletRatioRow, 'unitsPerPallet' | 'palletsPerTruck'>) =>
  r.unitsPerPallet && r.palletsPerTruck ? r.unitsPerPallet * r.palletsPerTruck : null;

export function PalletRatiosPage() {
  const [params, setParams] = useSearchParams();
  const filter: FilterKey = (params.get('filter') as FilterKey) in RATIO_FILTERS ? (params.get('filter') as FilterKey) : 'all';
  const [search, setSearch] = useState('');
  const { data, error, isLoading } = useQuery({
    queryKey: ['pallet-ratios'],
    queryFn: () => api<PalletRatiosResponse>('/pallet-ratios'),
  });

  const counts = useMemo(
    () => Object.fromEntries(Object.entries(RATIO_FILTERS).map(([k, f]) => [k, data?.rows.filter(f.test).length ?? 0])) as Record<FilterKey, number>,
    [data],
  );
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rows ?? [])
      .filter(RATIO_FILTERS[filter].test)
      .filter((r) => !q || [r.partNumber, r.itemName, r.commodity].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => b.openUnits - a.openUnits || a.partNumber.localeCompare(b.partNumber));
  }, [data, filter, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pallet ratios"
        description="Units per pallet and pallets per truck for each part, used to convert inbound quantities into pallets. Parts without their own ratio use their commodity's median and are marked Estimated until a real ratio is entered."
      />
      <UploadCard />
      {error && <ErrorNote error={error} />}
      {data && <EstimatesCard estimates={data.estimates} rows={data.rows} />}

      <Card className="overflow-x-auto p-0">
        <div className="flex flex-wrap items-center gap-2 p-4 pb-2">
          {(Object.keys(RATIO_FILTERS) as FilterKey[]).map((k) => (
            <button
              key={k}
              title={RATIO_FILTERS[k].hint}
              onClick={() => setParams(k === 'all' ? {} : { filter: k }, { replace: true })}
              aria-pressed={filter === k}
              className={`rounded-full px-3 py-1 text-sm ${filter === k ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'}`}
            >
              {RATIO_FILTERS[k].label} <span className="tabular-nums opacity-70">{counts[k]}</span>
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search part, item or commodity"
            className="ml-auto w-64 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </div>
        <p className="px-4 pb-2 text-xs text-slate-500">{RATIO_FILTERS[filter].hint}. Sorted by open inbound units.</p>
        {isLoading ? (
          <div className="p-4 text-sm text-slate-500">Loading…</div>
        ) : !rows.length ? (
          <div className="p-4">
            <Empty>{data?.rows.length ? 'No parts match.' : 'No pallet ratios yet. Upload the Pallet Ratios file to get started.'}</Empty>
          </div>
        ) : (
          <RatioTable rows={rows} />
        )}
      </Card>
    </div>
  );
}

function UploadCard() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ fileName: string; sheetName: string; rows: PalletRatioFileRow[] } | null>(null);
  const [preview, setPreview] = useState<PalletRatioImportResult | null>(null);
  const [done, setDone] = useState<PalletRatioImportResult | null>(null);

  const send = (rows: PalletRatioFileRow[], dryRun: boolean) =>
    api<PalletRatioImportResult>('/pallet-ratios/import', { method: 'POST', body: JSON.stringify({ rows, dryRun }) });

  const read = useMutation({
    mutationFn: async (file: File) => {
      const { sheetName, rows } = parsePalletRatios(readWorkbook(await file.arrayBuffer()));
      if (!rows.length) throw new Error(`No parts found on "${sheetName}".`);
      return { fileName: file.name, sheetName, rows, result: await send(rows, true) };
    },
    onMutate: () => {
      setPreview(null);
      setDone(null);
    },
    onSuccess: ({ result, ...p }) => {
      setParsed(p);
      setPreview(result);
    },
  });
  const save = useMutation({
    mutationFn: () => send(parsed!.rows, false),
    onSuccess: (result) => {
      setDone(result);
      setParsed(null);
      setPreview(null);
      void queryClient.invalidateQueries();
    },
  });

  const reset = () => {
    setParsed(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-sm font-medium">Upload Pallet Ratios file</h2>
          <p className="mt-1 text-xs text-slate-500">
            Reads CPN, Standard Order Qty. (units per pallet), Pallet to truck ratio, Can double stack?, Note 1, Item Name and Product Group. Manual edits made
            here are kept; parts where the file disagrees are listed.
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.xlsm,.csv"
          onChange={(e) => e.target.files?.[0] && read.mutate(e.target.files[0])}
          className="text-sm"
          aria-label="Pallet Ratios file"
        />
      </div>
      {read.isPending && <div className="text-sm text-slate-500">Reading…</div>}
      {(read.error || save.error) && <ErrorNote error={read.error ?? save.error} />}
      {parsed && preview && (
        <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
          <div className="font-medium">
            {parsed.fileName} · {parsed.sheetName}
          </div>
          <ImportCounts result={preview} />
          <div className="mt-3 flex gap-2">
            <button className={primary} disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Importing…' : `Import ${preview.total} parts`}
            </button>
            <button className={btn} onClick={reset} disabled={save.isPending}>Cancel</button>
          </div>
        </div>
      )}
      {done && (
        <div className="rounded-md bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950 dark:text-green-100">
          Imported.
          <ImportCounts result={done} />
        </div>
      )}
    </Card>
  );
}

function ImportCounts({ result }: { result: PalletRatioImportResult }) {
  const verb = result.dryRun ? 'will be' : 'were';
  return (
    <>
      <p className="mt-1">
        {result.total} parts: {result.added} new, {result.changed} changed, {result.unchanged} unchanged. {result.missing} have no units per pallet in the
        file and {result.dryRun ? 'will be' : 'are'} estimated from their commodity.
      </p>
      {result.conflicts.length > 0 && (
        <div className="mt-2 text-amber-800 dark:text-amber-200">
          {result.conflicts.length} manual edit{result.conflicts.length === 1 ? '' : 's'} differ from the file and {verb} kept:
          <ul className="mt-1 list-inside list-disc text-xs">
            {result.conflicts.slice(0, 10).map((c) => (
              <li key={c.partNumber}>
                <span className="font-mono">{c.partNumber}</span>: manual {num(c.manual.unitsPerPallet)}/pallet, {num(c.manual.palletsPerTruck)} pallets/truck; file{' '}
                {num(c.file.unitsPerPallet)}/pallet, {num(c.file.palletsPerTruck)} pallets/truck
              </li>
            ))}
            {result.conflicts.length > 10 && <li>…and {result.conflicts.length - 10} more (filter: Differs from file)</li>}
          </ul>
        </div>
      )}
    </>
  );
}

function EstimatesCard({ estimates, rows }: { estimates: CommodityEstimate[]; rows: PalletRatioRow[] }) {
  const uncovered = [...new Set(rows.filter((r) => r.basis === 'none' && r.commodity).map((r) => r.commodity!))].sort();
  return (
    <Card className="overflow-x-auto p-0">
      <h2 className="px-4 pt-4 text-sm font-medium">Commodity estimates</h2>
      <p className="px-4 text-xs text-slate-500">
        Parts without their own ratio use the median units per pallet of their commodity. A wide range means the estimate is rough: entering real ratios for
        those parts matters most.
      </p>
      {estimates.length > 0 && (
        <table className={tableCls}>
          <thead>
            <tr>
              <th className={thCls}>Commodity</th>
              {['Median units / pallet', 'Median pallets / truck', 'Based on', 'Range'].map((h) => (
                <th key={h} className={`${thCls} text-right`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {estimates.map((e) => (
              <tr key={e.commodity}>
                <td className={`${tdCls} font-medium`}>{e.commodity}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{e.unitsPerPallet.toLocaleString()}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{num(e.palletsPerTruck)}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{e.parts} part{e.parts === 1 ? '' : 's'}</td>
                <td className={`${tdCls} text-right tabular-nums ${e.wideSpread ? 'text-amber-700 dark:text-amber-300' : ''}`}>
                  {e.min.toLocaleString()}–{e.max.toLocaleString()}
                  {e.wideSpread && ' · wide'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {uncovered.length > 0 && (
        <p className="px-4 py-3 text-sm text-red-700 dark:text-red-300">
          No real ratios yet, so no estimate for: {uncovered.join(', ')}. These parts show units only.
        </p>
      )}
    </Card>
  );
}

function RatioTable({ rows }: { rows: PalletRatioRow[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <table className={tableCls}>
      <thead>
        <tr>
          {['Part', 'Item', 'Commodity', 'Units / pallet', 'Pallets / truck', 'Units / truck', 'Double stack', 'Open inbound', 'Source', ''].map((h) => (
            <th key={h} className={`${thCls} whitespace-nowrap`}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) =>
          editing === r.partNumber ? (
            <EditRow key={r.partNumber} row={r} onDone={() => setEditing(null)} />
          ) : (
            <ViewRow key={r.partNumber} row={r} onEdit={() => setEditing(r.partNumber)} />
          ),
        )}
      </tbody>
    </table>
  );
}

function ViewRow({ row: r, onEdit }: { row: PalletRatioRow; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const revert = useMutation({
    mutationFn: () => api(`/pallet-ratios/${encodeURIComponent(r.partNumber)}/manual`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  return (
    <tr className="align-top">
      <td className={`${tdCls} whitespace-nowrap font-mono text-xs`}>{r.partNumber}</td>
      <td className={`${tdCls} max-w-xs text-xs`}>
        {r.itemName ?? '—'}
        {r.note && <div className="mt-0.5 text-slate-500">{r.note}</div>}
      </td>
      <td className={`${tdCls} text-xs`}>{r.commodity ?? '—'}</td>
      <td className={`${tdCls} whitespace-nowrap tabular-nums`}>
        {r.basis === 'real' ? (
          r.unitsPerPallet!.toLocaleString()
        ) : (
          <>
            <BasisBadge basis={r.basis} estimate={r.estimate} short />
            {r.effectiveUnitsPerPallet != null && <span className="ml-2 text-slate-500">≈{r.effectiveUnitsPerPallet.toLocaleString()}</span>}
          </>
        )}
      </td>
      <td className={`${tdCls} tabular-nums`}>{num(r.palletsPerTruck)}</td>
      <td className={`${tdCls} tabular-nums`}>{num(unitsPerTruck(r))}</td>
      <td className={tdCls}>{r.canDoubleStack ? 'Yes' : ''}</td>
      <td className={`${tdCls} whitespace-nowrap tabular-nums`}>
        {r.openLines ? `${r.openUnits.toLocaleString()} units · ${r.openLines} line${r.openLines === 1 ? '' : 's'}` : '—'}
      </td>
      <td className={`${tdCls} text-xs`}>
        {r.source === 'manual' ? (
          <span title={`${r.updatedBy ?? ''} · ${formatDateTime(r.updatedAt)}`}>Manual</span>
        ) : r.source === 'file' ? (
          'File'
        ) : (
          <span className="text-slate-400">Not in file</span>
        )}
        {r.conflict && r.fileValues && (
          <div className="mt-0.5 text-amber-700 dark:text-amber-300">
            File says {num(r.fileValues.unitsPerPallet)}/pallet, {num(r.fileValues.palletsPerTruck)}/truck
          </div>
        )}
      </td>
      <td className={`${tdCls} whitespace-nowrap text-right`}>
        <button className={btn} onClick={onEdit}>Edit</button>
        {r.source === 'manual' && (
          <button
            className={`${btn} ml-2`}
            disabled={revert.isPending}
            onClick={() => revert.mutate()}
            title={r.fileValues ? 'Go back to the values from the uploaded file' : 'Remove this ratio; the part goes back to a commodity estimate'}
          >
            {r.fileValues ? 'Use file' : 'Clear'}
          </button>
        )}
      </td>
    </tr>
  );
}

function parseRatio(v: string): number | null | 'invalid' {
  if (!v.trim()) return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 'invalid';
}

function EditRow({ row: r, onDone }: { row: PalletRatioRow; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [units, setUnits] = useState(r.unitsPerPallet?.toString() ?? '');
  const [trucks, setTrucks] = useState(r.palletsPerTruck?.toString() ?? '');
  const [stack, setStack] = useState(r.canDoubleStack);
  const [note, setNote] = useState(r.note ?? '');
  const u = parseRatio(units);
  const t = parseRatio(trucks);
  const invalid = u === 'invalid' || t === 'invalid';
  const save = useMutation({
    mutationFn: (body: PalletRatioEdit) => api(`/pallet-ratios/${encodeURIComponent(r.partNumber)}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onDone();
    },
  });
  const submit = () => {
    if (invalid) return;
    save.mutate({ unitsPerPallet: u, palletsPerTruck: t, canDoubleStack: stack, note });
  };
  const preview = u && t && !invalid ? u * t : null;
  return (
    <tr className="bg-slate-50 align-top dark:bg-slate-900">
      <td className={`${tdCls} whitespace-nowrap font-mono text-xs`}>{r.partNumber}</td>
      <td className={`${tdCls} text-xs`}>
        {r.itemName ?? '—'}
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" className={`${input} mt-1 block w-full`} />
      </td>
      <td className={`${tdCls} text-xs`}>{r.commodity ?? '—'}</td>
      <td className={tdCls}>
        <input
          autoFocus
          value={units}
          onChange={(e) => setUnits(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          inputMode="decimal"
          placeholder={r.effectiveUnitsPerPallet ? `≈${r.effectiveUnitsPerPallet}` : ''}
          aria-label="Units per pallet"
          className={`${input} ${u === 'invalid' ? 'border-red-500' : ''}`}
        />
      </td>
      <td className={tdCls}>
        <input
          value={trucks}
          onChange={(e) => setTrucks(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          inputMode="decimal"
          aria-label="Pallets per truck"
          className={`${input} ${t === 'invalid' ? 'border-red-500' : ''}`}
        />
      </td>
      <td className={`${tdCls} tabular-nums`}>{num(preview)}</td>
      <td className={tdCls}>
        <input type="checkbox" checked={stack} onChange={(e) => setStack(e.target.checked)} aria-label="Can double stack" />
      </td>
      <td className={`${tdCls} text-xs text-slate-500`} colSpan={2}>
        {invalid ? <span className="text-red-700 dark:text-red-300">Use a number above 0, or leave blank.</span> : 'Saved as a manual value; uploads won’t overwrite it.'}
        {save.error && <ErrorNote error={save.error} />}
      </td>
      <td className={`${tdCls} whitespace-nowrap text-right`}>
        <button className={primary} disabled={invalid || save.isPending} onClick={submit}>Save</button>
        <button className={`${btn} ml-2`} onClick={onDone}>Cancel</button>
      </td>
    </tr>
  );
}
