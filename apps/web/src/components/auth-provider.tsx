'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
} from 'react';
import { type Identity } from '@unkillable/shared';
import { createSessionLoader } from '../lib/session-client';
type AuthState = {
  identity: Identity | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};
const AuthContext = createContext<AuthState | null>(null);
export function AuthProvider({
  children,
  initialIdentity,
}: {
  children: React.ReactNode;
  initialIdentity?: Identity | null;
}) {
  const [identity, setIdentity] = useState<Identity | null>(
    initialIdentity ?? null,
  );
  const [loading, setLoading] = useState(initialIdentity === undefined);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const load = useRef(createSessionLoader());
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const request = (async () => {
      try {
        setIdentity(await load.current());
        setError(null);
      } catch {
        setIdentity(null);
        setError('Unable to verify session.');
      } finally {
        setLoading(false);
      }
    })();
    pending.current = request;
    void request.then(() => {
      pending.current = null;
    });
    return request;
  }, []);
  useEffect(() => {
    if (initialIdentity === undefined) void refresh();
    else {
      setIdentity(initialIdentity);
      setLoading(false);
      setError(null);
    }
    const check = () => {
      void refresh();
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [refresh, initialIdentity]);
  return (
    <AuthContext.Provider value={{ identity, loading, error, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('AuthProvider is required');
  return auth;
}
