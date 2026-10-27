import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OUTBOUND_CHUNK_SIZE, type OutboundSnapshotInfo } from '../../../shared/types';
import { Card, ErrorNote } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import type { ParsedOdmOrders } from './parseOdmOrders';

/** Imports the ODM Open Order tab as the open sales order list as of the report date (separate from the PO lines). */
export function OutboundImportCard({ fileName, reportDate, parsed, error }: { fileName: string; reportDate: string; parsed: ParsedOdmOrders | null; error: string | null }) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const run = useMutation({
    mutationFn: async (): Promise<OutboundSnapshotInfo> => {
      const p = parsed!;
      const { snapshotId } = await api<{ snapshotId: number }>('/outbound/snapshots', {
        method: 'POST',
        body: JSON.stringify({ fileName, reportDate, rowCount: p.rowCount, orderCount: p.orders.length, skippedQuotations: p.skippedQuotations }),
      });
      setProgress({ done: 0, total: p.orders.length });
      for (let i = 0; i < p.orders.length; i += OUTBOUND_CHUNK_SIZE) {
        const part = p.orders.slice(i, i + OUTBOUND_CHUNK_SIZE);
        await api(`/outbound/snapshots/${snapshotId}/orders`, { method: 'POST', body: JSON.stringify({ orders: part }) });
        setProgress({ done: i + part.length, total: p.orders.length });
      }
      return api<OutboundSnapshotInfo>(`/outbound/snapshots/${snapshotId}/complete`, { method: 'POST', body: '{}' });
    },
    onSuccess: () => void queryClient.invalidateQueries(),
    onSettled: () => setProgress(null),
  });

  if (!parsed && !error) return null;
  return (
    <Card>
      <h2 className="font-medium">Outbound orders</h2>
      {error ? (
        <div className="mt-2"><ErrorNote error={new Error(error)} /></div>
      ) : (
        parsed && (
          <>
            <p className="mt-1 text-sm text-slate-500">
              Sheet “{parsed.sheetName}” · {parsed.rowCount.toLocaleString()} rows → {parsed.orders.length.toLocaleString()} sales orders (reservation pieces of an
              order are added up) · {parsed.skippedQuotations.toLocaleString()} quotation rows left out
              {parsed.unscheduledOrders > 0 && ` · ${parsed.unscheduledOrders.toLocaleString()} without a ship date`}. This replaces the open order list as of the
              report date, and is imported separately from the PO lines.
            </p>
            {parsed.errors.length > 0 && (
              <div className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                {parsed.errors.length} rows skipped: {parsed.errors.slice(0, 3).join('; ')}
                {parsed.errors.length > 3 && '…'}
              </div>
            )}
            <button
              disabled={!parsed.orders.length || run.isPending}
              onClick={() => run.mutate()}
              className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            >
              {run.isPending
                ? progress
                  ? `Importing… ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
                  : 'Starting…'
                : `Import ${parsed.orders.length.toLocaleString()} outbound orders as of ${formatDate(reportDate)}`}
            </button>
            {run.error && <div className="mt-3"><ErrorNote error={run.error} /></div>}
            {run.data && (
              <div className="mt-3 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">
                Imported {run.data.orderCount.toLocaleString()} sales orders as of {formatDate(run.data.reportDate)}.
                {run.data.changes &&
                  ` Since ${formatDate(run.data.changes.previousReportDate)}: ${run.data.changes.noLongerListed.toLocaleString()} SOs no longer listed, ${run.data.changes.added.toLocaleString()} new, ${run.data.changes.quantityChanged.toLocaleString()} with a changed quantity.`}{' '}
                <Link to="/outbound" className="underline">View outbound →</Link>
              </div>
            )}
          </>
        )
      )}
    </Card>
  );
}
