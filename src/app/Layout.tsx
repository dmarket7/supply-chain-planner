import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { BranchSelect } from './branch';
import { useSession } from './session';

const NAV = [
  { to: '/', label: 'Inbound by day', end: true },
  { to: '/shipments', label: 'Shipments' },
  { to: '/arrivals', label: 'Arrival log' },
  { to: '/import', label: 'Import report' },
];

export function Layout() {
  const { user, signOut } = useSession();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold">Supply Chain Planner</span>
          <nav className="flex flex-wrap gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-500">
            <BranchSelect />
            <span className="hidden sm:inline">{user?.email}</span>
            <button onClick={() => void signOut()} className="hover:underline">Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Suspense fallback={<div className="text-sm text-slate-500">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
