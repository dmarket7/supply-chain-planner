/** Fill for estimated bars: series-1 hatched over its soft tint. */
export const ESTIMATED_FILL = 'url(#estimated-hatch)';

/** Defines the hatch pattern once per chart; it sits outside the chart so legend swatches can use it too. */
export function EstimatedHatch() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        <pattern id="estimated-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--series-1-soft)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--series-1)" strokeWidth="2.5" />
        </pattern>
      </defs>
    </svg>
  );
}

export function LegendSwatch({ color }: { color: string }) {
  return color === ESTIMATED_FILL ? (
    <svg width="10" height="10" aria-hidden><rect width="10" height="10" rx="2" fill={ESTIMATED_FILL} /></svg>
  ) : (
    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
  );
}

export function Legend({ items }: { items: readonly { key: string; label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
      {items.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <LegendSwatch color={s.color} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function TooltipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      {color && <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color === ESTIMATED_FILL ? 'var(--series-1-soft)' : color }} />}
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <span className="ml-auto pl-4 tabular-nums">{value}</span>
    </div>
  );
}

export const tooltipBoxCls = 'rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-md dark:border-slate-700 dark:bg-slate-900';
