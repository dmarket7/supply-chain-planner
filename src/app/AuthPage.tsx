import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { authClient } from '../lib/auth';
import { useSession } from './session';

export function AuthPage() {
  const { user, refresh } = useSession();
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result =
      mode === 'signIn'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: name || email });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? 'Something went wrong');
      return;
    }
    await refresh();
  }

  const input = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900';
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div>
          <h1 className="text-lg font-semibold">Supply Chain Planner</h1>
          <p className="text-sm text-slate-500">{mode === 'signIn' ? 'Sign in to continue' : 'Create your account'}</p>
        </div>
        {mode === 'signUp' && (
          <label className="block space-y-1 text-sm">
            <span>Name</span>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label className="block space-y-1 text-sm">
          <span>Email</span>
          <input className={input} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Password</span>
          <input
            className={input}
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-slate-900">
          {busy ? 'Please wait…' : mode === 'signIn' ? 'Sign in' : 'Create account'}
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')}
          className="w-full text-center text-sm text-slate-500 hover:underline"
        >
          {mode === 'signIn' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
