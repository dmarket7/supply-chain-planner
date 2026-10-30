import { lazy } from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { AuthPage } from './AuthPage';
import { Layout } from './Layout';
import { useSession } from './session';

// Route-level code splitting keeps SheetJS (import) and Recharts (charts) out of the initial bundle.
const DashboardPage = lazy(() => import('../features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const InventoryPage = lazy(() => import('../features/inventory/InventoryPage').then((m) => ({ default: m.InventoryPage })));
const InboundPage = lazy(() => import('../features/inbound/InboundPage').then((m) => ({ default: m.InboundPage })));
const PerformancePage = lazy(() => import('../features/performance/PerformancePage').then((m) => ({ default: m.PerformancePage })));
const OutboundPage = lazy(() => import('../features/outbound/OutboundPage').then((m) => ({ default: m.OutboundPage })));
const ArrivalLogPage = lazy(() => import('../features/arrivals/ArrivalLogPage').then((m) => ({ default: m.ArrivalLogPage })));
const TrackingSetupPage = lazy(() => import('../features/tracking/TrackingSetupPage').then((m) => ({ default: m.TrackingSetupPage })));
const PalletRatiosPage = lazy(() => import('../features/settings/PalletRatiosPage').then((m) => ({ default: m.PalletRatiosPage })));
const ImportPage = lazy(() => import('../features/import/ImportPage').then((m) => ({ default: m.ImportPage })));

export function App() {
  const { user, loading } = useSession();
  if (loading) return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="*" element={<Navigate to="/auth" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="inbound" element={<InboundPage />} />
        <Route path="outbound" element={<OutboundPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="shipments" element={<ShipmentsRedirect />} />
        <Route path="arrivals" element={<ArrivalLogPage />} />
        <Route path="tracking" element={<TrackingSetupPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="settings/pallets" element={<PalletRatiosPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** The Shipments page is now part of Inbound; old links (e.g. `?progress=changed`) keep working. */
export function inboundPathForShipments(params: URLSearchParams): string {
  const progress = params.get('progress');
  return progress ? `/inbound?changed=${encodeURIComponent(progress)}` : '/inbound';
}

function ShipmentsRedirect() {
  const [params] = useSearchParams();
  return <Navigate to={inboundPathForShipments(params)} replace />;
}
