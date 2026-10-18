import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { todayIso } from '../../shared/dates';
import type { BranchSummary } from '../../shared/types';
import { api, qs } from '../lib/api';

const STORAGE_KEY = 'scp.branch';

interface BranchState {
  /** Selected branch code, or '' for all branches. */
  branch: string;
  setBranch: (branch: string) => void;
}

const BranchContext = createContext<BranchState | null>(null);

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function BranchProvider({ children }: { children: ReactNode }) {
  const [branch, setBranchState] = useState(readStored);
  const setBranch = useCallback((next: string) => {
    setBranchState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode etc.: the choice just isn't remembered.
    }
  }, []);
  return <BranchContext.Provider value={{ branch, setBranch }}>{children}</BranchContext.Provider>;
}

export function useBranch() {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error('useBranch must be used inside BranchProvider');
  return ctx;
}

export function useBranchSummaries() {
  const today = todayIso();
  return useQuery({
    queryKey: ['branches', today],
    queryFn: () => api<BranchSummary[]>(`/branches${qs({ today })}`),
  });
}

export function BranchSelect() {
  const { branch, setBranch } = useBranch();
  const { data } = useBranchSummaries();
  const known = data?.some((b) => b.branch === branch);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-slate-500">Branch</span>
      <select
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        className="max-w-[14rem] rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <option value="">All branches</option>
        {data?.map((b) => (
          <option key={b.branch} value={b.branch}>
            {b.branch} ({b.lines.toLocaleString()})
          </option>
        ))}
        {branch && data && !known && <option value={branch}>{branch} (no lines)</option>}
      </select>
    </label>
  );
}
