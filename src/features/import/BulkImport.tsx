import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SavedMapping } from '../../../shared/types';
import { Card, ErrorNote, tableCls, tdCls, thCls } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { reportDateFromFileName } from './normalize';
import { rebuildPoHistory } from './rebuildHistory';
import { importReportFile, STEP_TITLES, type Step } from './saveReport';

type FileStatus =
  | { kind: 'waiting' }
  | { kind: 'reading' }
  | { kind: 'saving'; step: Step; done?: number; total?: number }
  | { kind: 'done'; summary: string; notes: string[] }
  | { kind: 'error'; error: unknown };

interface Item {
  key: string;
  file: File;
  reportDate: string;
  status: FileStatus;
}

type RebuildState = { kind: 'idle' } | { kind: 'running'; done?: number; total?: number } | { kind: 'done' } | { kind: 'error'; error: unknown };

const byDate = (a: Item, b: Item) => (a.reportDate || '9999').localeCompare(b.reportDate || '9999') || a.file.name.localeCompare(b.file.name);
const paint = () => new Promise((r) => setTimeout(r, 0));

/**
 * Imports many reports oldest first, each with every tab, for backfilling history. Reports older
 * than one already kept are stored as they go, and the inbound history is rebuilt once at the end.
 */
export function BulkImport() {
  const queryClient = useQueryClient();
  const savedMappings = useQuery({ queryKey: ['mappings'], queryFn: () => api<SavedMapping[]>('/mappings') });
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [rebuild, setRebuild] = useState<RebuildState>({ kind: 'idle' });
  const stop = useRef(false);

  const update = (key: string, status: FileStatus) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, status } : i)));

  function addFiles(files: FileList | File[]) {
    setItems((prev) => {
      const known = new Set(prev.map((i) => i.key));
      const added = [...files]
        .map((file) => ({ key: `${file.name}|${file.size}|${file.lastModified}`, file, reportDate: reportDateFromFileName(file.name) ?? '', status: { kind: 'waiting' } as FileStatus }))
        .filter((i) => !known.has(i.key));
      return [...prev, ...added].sort(byDate);
    });
  }

  async function importOne({ key, file, reportDate }: Item): Promise<boolean> {
    update(key, { kind: 'reading' });
    await paint(); // let "Reading…" show before the blocking parse
    const result = await importReportFile(await file.arrayBuffer(), { fileName: file.name, reportDate, mappings: savedMappings.data ?? [] }, (step, done, total) =>
      update(key, { kind: 'saving', step, done, total }),
    );
    update(key, { kind: 'done', summary: result.saved.join(' · ') || 'Nothing to import', notes: result.notes });
    return result.needsRebuild;
  }

  async function runRebuild() {
    setRebuild({ kind: 'running' });
    try {
      await rebuildPoHistory((done, total) => setRebuild({ kind: 'running', done, total }));
      setRebuild({ kind: 'done' });
    } catch (error) {
      setRebuild({ kind: 'error', error });
    }
  }

  /** Oldest first; stops at the first report that fails so the history has no gaps. Done reports are skipped on a rerun. */
  async function run() {
    stop.current = false;
    setRunning(true);
    setRebuild({ kind: 'idle' });
    let needsRebuild = false;
    try {
      for (const item of [...items].sort(byDate)) {
        if (item.status.kind === 'done') continue;
        if (stop.current) break;
        try {
          needsRebuild = (await importOne(item)) || needsRebuild;
        } catch (error) {
          update(item.key, { kind: 'error', error });
          break;
        }
      }
      // Rebuild even after a stop or failure, so the inbound lines match every report kept so far.
      if (needsRebuild) await runRebuild();
    } finally {
      setRunning(false);
      void queryClient.invalidateQueries();
    }
  }

  const missingDate = items.some((i) => !i.reportDate);
  const dates = items.map((i) => i.reportDate).filter(Boolean);
  const repeated = new Set(dates.filter((d, i) => dates.indexOf(d) !== i));
  const left = items.filter((i) => i.status.kind !== 'done').length;
  const finished = !running && items.length > 0 && left === 0;

  return (
    <Card className="p-0">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm" aria-expanded={open}>
        <span>
          <span className="font-medium">Import many reports at once</span>
          <span className="ml-2 text-slate-500">To backfill history, for example every weekly report this year.</span>
        </span>
        <span className="text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-200 p-4 dark:border-slate-800">
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-slate-300 p-6 text-center text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!running) addFiles(e.dataTransfer.files);
            }}
          >
            <span className="font-medium">Drop reports here or click to choose several</span>
            <span className="text-slate-500">
              Each report's date is read from its file name. They're imported oldest first with all four tabs; if older reports are added after newer ones, the
              inbound history is rebuilt once at the end.
            </span>
            <input
              type="file"
              multiple
              accept=".xlsx,.xls,.xlsm"
              className="hidden"
              disabled={running}
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>

          {items.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void run()}
                  disabled={running || missingDate || left === 0}
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
                >
                  {running ? 'Importing…' : `Import ${left.toLocaleString()} ${left === 1 ? 'report' : 'reports'}, oldest first`}
                </button>
                {running && (
                  <button onClick={() => (stop.current = true)} className="text-sm text-slate-600 hover:underline dark:text-slate-300">
                    Stop after this report
                  </button>
                )}
                {!running && (
                  <button onClick={() => setItems([])} className="text-sm text-slate-500 hover:underline">
                    Clear list
                  </button>
                )}
                {missingDate && <span className="text-sm text-red-600">Set a report date for each file without one in its name.</span>}
                {repeated.size > 0 && (
                  <span className="text-sm text-amber-700 dark:text-amber-300">
                    More than one file for {[...repeated].map((d) => formatDate(d)).join(', ')}: the later one replaces the earlier.
                  </span>
                )}
              </div>

              {rebuild.kind === 'running' && (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Rebuilding the inbound history from every report in date order…{rebuild.total ? ` ${rebuild.done} of ${rebuild.total} batches` : ''}
                </p>
              )}
              {rebuild.kind === 'error' && (
                <div className="space-y-2">
                  <ErrorNote error={rebuild.error} />
                  <button onClick={() => void runRebuild()} disabled={running} className="text-sm underline">
                    Retry the history rebuild
                  </button>
                </div>
              )}
              {finished && rebuild.kind !== 'error' && (
                <p className="text-sm">
                  All reports imported. <Link to="/performance" className="underline">See supplier performance →</Link>
                </p>
              )}

              <div className="max-h-96 overflow-auto">
                <table className={tableCls}>
                  <thead className="sticky top-0 bg-white dark:bg-slate-950">
                    <tr>
                      <th className={thCls}>Report date</th>
                      <th className={thCls}>File</th>
                      <th className={thCls}>Status</th>
                      <th className={thCls} />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.key}>
                        <td className={tdCls}>
                          <input
                            type="date"
                            value={item.reportDate}
                            disabled={running || item.status.kind === 'done'}
                            onChange={(e) => setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, reportDate: e.target.value } : i)).sort(byDate))}
                            className={`rounded-md border bg-white px-2 py-1 text-sm dark:bg-slate-900 ${!item.reportDate || repeated.has(item.reportDate) ? 'border-amber-500' : 'border-slate-300 dark:border-slate-700'}`}
                          />
                        </td>
                        <td className={`${tdCls} max-w-72 truncate`} title={item.file.name}>
                          {item.file.name}
                        </td>
                        <td className={tdCls}>
                          <StatusText status={item.status} />
                        </td>
                        <td className={`${tdCls} text-right`}>
                          {!running && item.status.kind !== 'done' && (
                            <button onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))} className="text-slate-400 hover:text-red-700" aria-label={`Remove ${item.file.name}`}>
                              ×
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function StatusText({ status }: { status: FileStatus }) {
  switch (status.kind) {
    case 'waiting':
      return <span className="text-slate-400">Waiting</span>;
    case 'reading':
      return <span className="text-slate-600 dark:text-slate-300">Reading…</span>;
    case 'saving':
      return (
        <span className="text-slate-600 dark:text-slate-300">
          Saving {STEP_TITLES[status.step]}…{status.total ? ` ${status.done?.toLocaleString()} of ${status.total.toLocaleString()}` : ''}
        </span>
      );
    case 'done':
      return (
        <span>
          <span className="text-emerald-700 dark:text-emerald-300">✓</span> {status.summary}
          {status.notes.map((n) => (
            <span key={n} className="block text-xs text-amber-700 dark:text-amber-300">{n}</span>
          ))}
        </span>
      );
    case 'error':
      return <span className="text-red-600">{status.error instanceof Error ? status.error.message : String(status.error)}</span>;
  }
}
