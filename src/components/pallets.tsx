import { useState } from 'react';
import { Link } from 'react-router-dom';
import { estimatedShare, type PalletBasis, type PalletSummary } from '../../shared/pallets';

/** A choice remembered per browser; storage can be unavailable (private windows), so it falls back. */
export function useStoredChoice<T extends string>(key: string, options: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return options.includes(saved as T) ? (saved as T) : fallback;
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // not remembered
      }
    },
  ];
}

export function MetricToggle<T extends string>({ options, labels, value, onChange }: { options: readonly T[]; labels: Record<T, string>; value: T; onChange: (m: T) => void }) {
  return (
    <div className="block text-sm">
      <span className="mb-1 block text-slate-500">Show</span>
      <div role="group" aria-label="Show as" className="inline-flex rounded-md border border-slate-300 p-0.5 dark:border-slate-700">
        {options.map((m) => (
          <button
            key={m}
            onClick={() => onChange(m)}
            aria-pressed={value === m}
            className={`rounded px-3 py-1 text-sm ${value === m ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
          >
            {labels[m]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Calls out how much of the pallet picture is estimated or missing, with a link to fix the ratios. */
export function DataQualityNote({ sum, parts }: { sum: PalletSummary; parts: { basis: PalletBasis }[] }) {
  const estimatedParts = parts.filter((p) => p.basis === 'estimated').length;
  const noRatioParts = parts.filter((p) => p.basis === 'none').length;
  if (!estimatedParts && !noRatioParts) return null;
  const pct = Math.round(estimatedShare(sum) * 100);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <span>
        {estimatedParts > 0 && (
          <>
            <strong>{pct}%</strong> of pallets in this range are estimated from commodity averages ({estimatedParts} part{estimatedParts === 1 ? '' : 's'}).{' '}
          </>
        )}
        {noRatioParts > 0 && (
          <>
            <strong>{noRatioParts}</strong> part{noRatioParts === 1 ? ' has' : 's have'} no ratio and {noRatioParts === 1 ? 'is' : 'are'} left out of pallet totals (
            {sum.noRatioUnits.toLocaleString()} units).
          </>
        )}
      </span>
      <Link to="/settings/pallets?filter=needs-data" className="ml-auto whitespace-nowrap font-medium underline">
        Improve pallet ratios
      </Link>
    </div>
  );
}
