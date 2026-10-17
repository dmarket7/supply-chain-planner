import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, todayIso } from '../../../shared/dates';
import type { InboundDay } from '../../../shared/types';
import { Card, DateInput, Empty, ErrorNote, PageHeader, StatTile, StatusBadge, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { ShipmentDrawer } from '../shipments/ShipmentDrawer';
import { InboundChart } from './InboundChart';

export function InboundByDayPage() {
  const [from, setFrom] = useState(addDays(todayIso(), -7));
  const [to, setTo] = useState(addDays(todayIso(), 21));
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ['inbound-by-day', from, to],
    queryFn: () => api<{ days: InboundDay[] }>(`/reports/inbound-by-day${qs({ from, to })}`),
  });
  const days = data?.days ?? [];
  const today = todayIso();
  const total = days.reduce((n, d) => n + d.total, 0);
  const todayCount = days.find((d) => d.date === today)?.total ?? 0;
  const nextWeek = days.filter((d) => d.date > today && d.date <= addDays(today, 7)).reduce((n, d) => n + d.total, 0);
  const overdue = days
    .filter((d) => d.date < today)
    .reduce((n, d) => n + d.shipments.filter((s) => !s.actualArrivalDate).length, 0);

  function selectDay(date: string) {
    setOpenDay(date);
    document.getElementById(`day-${date}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inbound by day"
        description="Shipments grouped by expected arrival (carrier ETA when known, otherwise the supplier's promised date)."
        actions={
          <>
            <DateInput label="From" value={from} onChange={setFrom} />
            <DateInput label="To" value={to} onChange={setTo} />
          </>
        }
      />
      {error && <ErrorNote error={error} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Expected today" value={todayCount} />
        <StatTile label="Next 7 days" value={nextWeek} />
        <StatTile label="Past due, not arrived" value={overdue} hint="Expected date passed in this range" />
        <StatTile label="In range" value={total} />
      </div>

      <Card>
        {isLoading ? (
          <div className="h-72 animate-pulse rounded-md bg-slate-100 dark:bg-slate-900" />
        ) : days.length === 0 ? (
          <Empty>No inbound shipments in this range. Import a report to get started.</Empty>
        ) : (
          <InboundChart days={days} onSelectDay={selectDay} />
        )}
      </Card>

      <div className="space-y-3">
        {days.map((d) => {
          const open = openDay === d.date;
          return (
            <Card key={d.date} className="scroll-mt-4 p-0">
              <button
                id={`day-${d.date}`}
                onClick={() => setOpenDay(open ? null : d.date)}
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left"
                aria-expanded={open}
              >
                <span className={`font-medium ${d.date === today ? 'text-blue-700 dark:text-blue-300' : ''}`}>
                  {formatDate(d.date, { weekday: 'short' })}
                  {d.date === today && ' · Today'}
                </span>
                <span className="text-sm tabular-nums text-slate-500">{d.total} shipments</span>
                <span className="text-sm text-slate-500">
                  {Object.entries(d.byCarrier)
                    .sort((a, b) => b[1] - a[1])
                    .map(([c, n]) => `${c} ${n}`)
                    .join(' · ')}
                </span>
                <span className="ml-auto text-sm text-slate-400">{open ? 'Hide' : 'Show'}</span>
              </button>
              {open && (
                <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
                  <table className={tableCls}>
                    <thead>
                      <tr>{['Supplier', 'PO', 'Carrier', 'Tracking', 'Promised', 'Status'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {d.shipments.map((s) => (
                        <tr key={s.id} onClick={() => setSelected(s.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900">
                          <td className={tdCls}>{s.supplier}</td>
                          <td className={tdCls}>{s.poNumber ?? '—'}</td>
                          <td className={tdCls}>{s.carrier ?? '—'}</td>
                          <td className={`${tdCls} font-mono text-xs`}>{s.trackingNumber ?? '—'}</td>
                          <td className={tdCls}>{formatDate(s.promisedArrivalDate)}</td>
                          <td className={tdCls}><StatusBadge status={s.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      {selected !== null && <ShipmentDrawer id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
