import { useBranch } from '../../app/branch';
import { ChipGroup, useUrlFilters } from '../../components/filters';
import { PageHeader } from '../../components/ui';
import { PERIOD_OPTIONS } from './common';
import { ReceivingTab } from './ReceivingTab';
import { ShippingTab } from './ShippingTab';
import { SuppliersTab } from './SuppliersTab';

const TABS = [
  { value: 'suppliers', label: 'Suppliers' },
  { value: 'shipping', label: 'Our shipping' },
  { value: 'receiving', label: 'Receiving' },
] as const;
type Tab = (typeof TABS)[number]['value'];

/**
 * Where things go wrong, measured from the uploaded reports: suppliers against their first
 * promises, our shipping against confirmed and requested dates, and receiving at our warehouses.
 */
export function PerformancePage() {
  const { branch } = useBranch();
  const f = useUrlFilters();
  const tab: Tab = TABS.some((t) => t.value === f.get('tab')) ? (f.get('tab') as Tab) : 'suppliers';
  const period = PERIOD_OPTIONS.some((p) => p.value === f.get('period')) ? f.get('period')! : '90';
  return (
    <div className="space-y-6">
      <PageHeader
        title={branch ? `Performance · ${branch}` : 'Performance'}
        description="On-time performance from the uploaded reports. Each weekly upload records the promises made, so these measures grow more complete over time."
        actions={tab !== 'receiving' && <ChipGroup label="Period" value={period} options={PERIOD_OPTIONS} onChange={(v) => f.set('period', v === '90' ? null : v)} />}
      />
      <ChipGroup label="View" value={tab} options={[...TABS]} onChange={(v) => f.set('tab', v === 'suppliers' ? null : v)} />
      {tab === 'suppliers' && <SuppliersTab branch={branch} period={period} />}
      {tab === 'shipping' && <ShippingTab branch={branch} period={period} />}
      {tab === 'receiving' && <ReceivingTab branch={branch} />}
    </div>
  );
}
