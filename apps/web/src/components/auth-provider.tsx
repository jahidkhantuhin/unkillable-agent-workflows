'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { identitySchema, type Identity } from '@unkillable/shared';
type AuthState = {
  identity: Identity | null;
  loading: boolean;
  refresh: () => Promise<void>;
};
const AuthContext = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/backend/auth/me', {
        cache: 'no-store',
      });
      setIdentity(
        response.ok ? identitySchema.parse(await response.json()) : null,
      );
    } catch {
      setIdentity(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const check = () => {
      void refresh();
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [refresh]);
  return (
    <AuthContext.Provider value={{ identity, loading, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('AuthProvider is required');
  return auth;
}
