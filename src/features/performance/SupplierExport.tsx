import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { todayIso } from '../../../shared/dates';
import type { SupplierReportResponse } from '../../../shared/types';
import { Card, DateInput, ErrorNote } from '../../components/ui';
import { api, qs } from '../../lib/api';

/** Downloads late deliveries and ETA/ETD changes per supplier as an Excel workbook. */
export function SupplierExport({ branch, includeHistory }: { branch: string; includeHistory: boolean }) {
  const today = todayIso();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const download = useMutation({
    mutationFn: async () => {
      const [report, { downloadSupplierWorkbook }] = await Promise.all([
        api<SupplierReportResponse>(`/reports/performance/supplier-report${qs({ from, to, branch: branch || undefined, includeHistory: includeHistory ? '1' : undefined })}`),
        import('./supplierWorkbook'),
      ]);
      downloadSupplierWorkbook(report);
      return report;
    },
  });
  const done = download.data;

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h2 className="font-medium">Supplier report for Excel</h2>
          <p className="text-sm text-slate-500">Each supplier's late deliveries, open past-due lines and every ETA/ETD change, by line and by month.</p>
        </div>
        <DateInput label="Received from" value={from} onChange={setFrom} />
        <DateInput label="to" value={to} onChange={setTo} />
        <button
          onClick={() => download.mutate()}
          disabled={download.isPending || !from || !to || from > to}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
        >
          {download.isPending ? 'Preparing…' : 'Download Excel'}
        </button>
      </div>
      {download.error && <ErrorNote error={download.error} />}
      {done && !download.isPending && (
        <p className="mt-2 text-sm text-slate-500">
          Downloaded {done.suppliers.length.toLocaleString()} suppliers, {done.late.length.toLocaleString()} late deliveries and {done.changes.length.toLocaleString()}{' '}
          date changes from {done.uploads.length.toLocaleString()} uploads.
        </p>
      )}
    </Card>
  );
}
