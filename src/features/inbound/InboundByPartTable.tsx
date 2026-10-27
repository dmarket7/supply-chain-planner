import { useState } from 'react';
import type { InboundPart } from '../../../shared/types';
import { BasisBadge, Card, tableCls, tdCls, thCls } from '../../components/ui';
import { formatPallets } from '../../lib/format';

const SHOWN = 15;

/** Inbound in the selected range by part (Wintec PN), most pallets first. */
export function InboundByPartTable({ parts }: { parts: InboundPart[] }) {
  const [all, setAll] = useState(false);
  if (!parts.length) return null;
  const rows = all ? parts : parts.slice(0, SHOWN);
  const right = `${tdCls} text-right tabular-nums`;
  return (
    <Card className="overflow-x-auto p-0">
      <h2 className="px-4 pt-4 font-medium">By part</h2>
      <p className="px-4 text-sm text-slate-500">
        Pallet-equivalents add up fractions of pallets; full + partial counts each line's whole pallets and its leftover pallet, which may be combined with other items.
      </p>
      <table className={tableCls}>
        <thead>
          <tr>
            <th className={thCls}>Part</th>
            <th className={thCls}>Description</th>
            <th className={thCls}>Commodity</th>
            {['Lines', 'Units', 'Units / pallet', 'Pallet-eq', 'Full + partial'].map((h) => (
              <th key={h} className={`${thCls} whitespace-nowrap text-right`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.partNumber ?? ''}>
              <td className={`${tdCls} whitespace-nowrap font-mono text-xs`}>{p.partNumber ?? '—'}</td>
              <td className={`${tdCls} max-w-xs truncate text-xs`} title={p.description ?? undefined}>{p.description ?? '—'}</td>
              <td className={`${tdCls} text-xs`}>{p.commodity ?? '—'}</td>
              <td className={right}>{p.pallets.lines}</td>
              <td className={right}>{p.pallets.units.toLocaleString()}</td>
              <td className={`${right} whitespace-nowrap`}>
                <BasisBadge basis={p.basis} estimate={p.estimate} short />
                {p.unitsPerPallet != null && <span className="ml-2">{p.unitsPerPallet.toLocaleString()}</span>}
              </td>
              <td className={right}>{p.basis === 'none' ? '—' : formatPallets(p.pallets.palletEq)}</td>
              <td className={right}>{p.basis === 'none' ? '—' : `${p.pallets.fullPallets} + ${p.pallets.partialPallets}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {parts.length > SHOWN && (
        <button onClick={() => setAll(!all)} className="w-full px-4 py-2 text-sm text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-900">
          {all ? 'Show fewer' : `Show all ${parts.length} parts`}
        </button>
      )}
    </Card>
  );
}
