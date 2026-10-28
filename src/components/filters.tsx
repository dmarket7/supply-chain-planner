import { useSearchParams } from 'react-router-dom';

/**
 * Filters live in the URL so the dashboard and import history can link to a filtered view, and a
 * filtered view can be shared. A null value clears that filter. Change several in one `update`:
 * separate calls in the same event would each start from the same URL.
 */
export function useUrlFilters() {
  const [params, setParams] = useSearchParams();
  const get = (name: string) => params.get(name) || null;
  const update = (values: Record<string, string | null>) =>
    setParams(
      (p) => {
        for (const [name, value] of Object.entries(values)) {
          if (value) p.set(name, value);
          else p.delete(name);
        }
        return p;
      },
      { replace: true },
    );
  const set = (name: string, value: string | null) => update({ [name]: value });
  const clear = (names: string[]) => update(Object.fromEntries(names.map((n) => [n, null])));
  return { get, set, update, clear };
}

const controlCls = 'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900';

export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string; count?: number }[];
  onChange: (v: string | null) => void;
}) {
  return (
    <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className={`${controlCls} max-w-56 ${value ? 'border-slate-900 dark:border-white' : ''}`}>
      <option value="">{label}: all</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
          {o.count !== undefined ? ` (${o.count.toLocaleString()})` : ''}
        </option>
      ))}
    </select>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label="Search" className={`${controlCls} w-56`} />;
}

export interface ActiveFilter {
  key: string;
  label: string;
  onClear: () => void;
}

/** Each applied filter as a removable chip, and Clear all. */
export function ActiveFilters({ filters, onClearAll }: { filters: ActiveFilter[]; onClearAll: () => void }) {
  if (!filters.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {filters.map((f) => (
        <span key={f.key} className="inline-flex items-center gap-1 rounded-full bg-slate-900 py-0.5 pl-3 pr-1 text-white dark:bg-white dark:text-slate-900">
          {f.label}
          <button onClick={f.onClear} aria-label={`Remove filter ${f.label}`} className="rounded-full px-1.5 hover:bg-white/20 dark:hover:bg-slate-900/10">
            ×
          </button>
        </span>
      ))}
      <button onClick={onClearAll} className="text-slate-500 hover:underline">
        Clear all
      </button>
    </div>
  );
}

/** Pill buttons for a small set of choices, e.g. reservation status, with counts. */
export function ChipGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string | null; label: string; count?: number }[];
  onChange: (v: string | null) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = (value ?? null) === o.value;
        return (
          <button
            key={o.label}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`rounded-full border px-3 py-1 text-sm ${active ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900' : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'}`}
          >
            {o.label}
            {o.count !== undefined && <span className="ml-1 tabular-nums opacity-70">{o.count.toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}
