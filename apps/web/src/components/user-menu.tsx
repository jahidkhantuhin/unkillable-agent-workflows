'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Button } from './ui/button';
export function UserMenu() {
  const { identity, loading, error: sessionError, refresh } = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/backend/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error('Sign out failed. Try again.');
      await refresh();
      router.replace('/login');
      router.refresh();
    } catch {
      setError('Sign out failed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <span className="text-xs text-muted-foreground">Checking session…</span>
    );
  if (sessionError)
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span role="alert" className="text-xs text-muted-foreground">
          {sessionError}
        </span>
        <Button variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  if (!identity)
    return (
      <Button asChild variant="outline">
        <Link href="/login">Sign in</Link>
      </Button>
    );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <div className="min-w-0 max-w-48 text-right text-xs">
        <p className="truncate" title={identity.user.name}>
          {identity.user.name}
        </p>
        <p className="capitalize text-muted-foreground">{identity.role}</p>
      </div>
      <Button variant="outline" onClick={logout} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
