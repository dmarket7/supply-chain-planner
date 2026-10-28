import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface Column<T> {
  id: string;
  label: string;
  /** Hover text on the header. */
  title?: string;
  align?: 'right';
  /** Sortable when given; blanks (null or '') sort last either way. */
  sortValue?: (row: T) => string | number | null;
  render: (row: T) => ReactNode;
  /** Off until the viewer turns it on in Columns. */
  defaultHidden?: boolean;
  className?: string;
}

type Sort = { id: string; dir: 'asc' | 'desc' } | null;
interface Saved {
  visible?: string[];
  sort?: Sort;
}

/** Above this many rows only the rows in view are rendered. */
const VIRTUAL_FROM = 150;
const ROW_ESTIMATE = 41;

function load(key: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Saved;
  } catch {
    return {};
  }
}
function save(key: string, value: Saved) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not remembered
  }
}

function compare(a: string | number | null, b: string | number | null): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}
const blank = (v: string | number | null) => v === null || v === '';

const headCls = 'sticky top-0 z-20 whitespace-nowrap border-b border-slate-200 bg-white px-3 py-2 font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-950';
const cellCls = 'border-b border-slate-100 px-3 py-2 dark:border-slate-900';
/** The first column stays in view when scrolling sideways; it takes the row's background. */
const stickyCls = 'sticky left-0 z-10 bg-inherit';

/**
 * A table whose columns sort on click and can be hidden, with the header and first column pinned
 * while it scrolls. Column choices and the sort are remembered per table (`id`) in this browser.
 */
export function DataTable<T>({
  id,
  rows,
  columns,
  rowKey,
  onRowClick,
  highlight,
  renderExpanded,
  toolbar,
  empty = 'Nothing matches.',
  maxHeight = '70vh',
}: {
  id: string;
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  /** Rows to tint, e.g. changed since the last report. */
  highlight?: (row: T) => boolean;
  /** Detail shown under a row, e.g. when it is open. */
  renderExpanded?: (row: T) => ReactNode;
  /** Shown left of the Columns button. */
  toolbar?: ReactNode;
  empty?: ReactNode;
  maxHeight?: string;
}) {
  const storageKey = `table:${id}`;
  const [saved, setSaved] = useState<Saved>(() => load(storageKey));
  const update = (next: Saved) => {
    setSaved(next);
    save(storageKey, next);
  };
  const defaults = columns.filter((c) => !c.defaultHidden).map((c) => c.id);
  const visibleIds = new Set(saved.visible?.filter((v) => columns.some((c) => c.id === v)) ?? defaults);
  const shown = columns.filter((c) => visibleIds.has(c.id));
  const sort = saved.sort && columns.some((c) => c.id === saved.sort!.id && c.sortValue) ? saved.sort : null;

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.id === sort.id);
    if (!sort || !col?.sortValue) return rows;
    const value = col.sortValue;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return rows
      .map((r) => ({ r, v: value(r) }))
      .sort((a, b) => (blank(a.v) ? (blank(b.v) ? 0 : 1) : blank(b.v) ? -1 : sign * compare(a.v, b.v)))
      .map((x) => x.r);
  }, [rows, sort?.id, sort?.dir, columns]);

  const cycleSort = (colId: string) => {
    const next: Sort = sort?.id !== colId ? { id: colId, dir: 'asc' } : sort.dir === 'asc' ? { id: colId, dir: 'desc' } : null;
    update({ ...saved, sort: next });
  };
  const toggle = (colId: string) => {
    const next = new Set(visibleIds);
    if (next.has(colId)) next.delete(colId);
    else next.add(colId);
    if (next.size) update({ ...saved, visible: columns.filter((c) => next.has(c.id)).map((c) => c.id) });
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = sorted.length > VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 15,
    // Server render and tests have no scroll element; render the first screenful.
    initialRect: { width: 1200, height: 800 },
  });
  const items = virtual ? virtualizer.getVirtualItems() : sorted.map((_, index) => ({ index, start: 0, end: 0 }));
  const padTop = virtual && items.length ? items[0].start : 0;
  const padBottom = virtual && items.length ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        {toolbar}
        <span className="ml-auto text-xs tabular-nums text-slate-500">{sorted.length.toLocaleString()} rows</span>
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            Columns ▾
          </summary>
          <div className="absolute right-0 z-30 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {columns.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
                <input type="checkbox" checked={visibleIds.has(c.id)} onChange={() => toggle(c.id)} />
                {c.label}
              </label>
            ))}
            <button onClick={() => update({ ...saved, visible: undefined })} className="mt-1 w-full rounded px-1 py-0.5 text-left text-xs text-slate-500 hover:underline">
              Reset columns
            </button>
          </div>
        </details>
      </div>
      {sorted.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-slate-500">{empty}</p>
      ) : (
        <div ref={scrollRef} className="overflow-auto border-t border-slate-200 dark:border-slate-800" style={{ maxHeight }}>
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {shown.map((c, i) => {
                  const dir = sort?.id === c.id ? sort.dir : null;
                  return (
                    <th
                      key={c.id}
                      title={c.title}
                      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                      className={`${headCls} ${i === 0 ? 'left-0 z-30' : ''} ${c.align === 'right' ? 'text-right' : ''}`}
                    >
                      {c.sortValue ? (
                        <button onClick={() => cycleSort(c.id)} className={`inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100 ${dir ? 'text-slate-900 dark:text-slate-100' : ''}`}>
                          {c.label}
                          <span aria-hidden className="w-2 text-xs">{dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}</span>
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            {padTop > 0 && (
              <tbody>
                <tr style={{ height: padTop }} />
              </tbody>
            )}
            {items.map(({ index }) => {
              const row = sorted[index];
              const detail = renderExpanded?.(row);
              const tint = highlight?.(row);
              return (
                // One tbody per row so a row and its detail are measured together.
                <tbody key={rowKey(row)} data-index={index} ref={virtual ? virtualizer.measureElement : undefined}>
                  <tr
                    onClick={onRowClick && (() => onRowClick(row))}
                    className={`${tint ? 'bg-violet-50 hover:bg-violet-100 dark:bg-violet-950 dark:hover:bg-violet-900' : 'bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-900'} ${onRowClick ? 'cursor-pointer' : ''}`}
                  >
                    {shown.map((c, i) => (
                      <td key={c.id} className={`${cellCls} ${i === 0 ? stickyCls : ''} ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.className ?? ''}`}>
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                  {detail && (
                    <tr>
                      <td colSpan={shown.length} className="border-b border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/50">
                        {detail}
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
            {padBottom > 0 && (
              <tbody>
                <tr style={{ height: padBottom }} />
              </tbody>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
