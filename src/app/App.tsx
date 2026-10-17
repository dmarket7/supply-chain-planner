import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthPage } from './AuthPage';
import { Layout } from './Layout';
import { useSession } from './session';

// Route-level code splitting keeps SheetJS (import) and Recharts (inbound) out of the initial bundle.
const InboundByDayPage = lazy(() => import('../features/inbound/InboundByDayPage').then((m) => ({ default: m.InboundByDayPage })));
const ShipmentsPage = lazy(() => import('../features/shipments/ShipmentsPage').then((m) => ({ default: m.ShipmentsPage })));
const ArrivalLogPage = lazy(() => import('../features/arrivals/ArrivalLogPage').then((m) => ({ default: m.ArrivalLogPage })));
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
        <Route index element={<InboundByDayPage />} />
        <Route path="shipments" element={<ShipmentsPage />} />
        <Route path="arrivals" element={<ArrivalLogPage />} />
        <Route path="import" element={<ImportPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
