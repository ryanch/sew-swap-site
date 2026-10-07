import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { api } from '../api';

export type GlobalRole = 'admin' | 'swap_manager';
export type User = { userId: string; email: string; displayName: string | null; roles: GlobalRole[] };

/** Admin implies every role (same rule as the API). */
export function hasRole(user: User | null, role: GlobalRole): boolean {
  return !!user && (user.roles.includes('admin') || user.roles.includes(role));
}

type AuthState = {
  user: User | null;
  loading: boolean;
  googleEnabled: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api<{ user: User }>('/api/auth/me');
      setUser(user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    setUser(null);
  }, []);

  useEffect(() => {
    refresh();
    api<{ google: boolean }>('/api/auth/config')
      .then((c) => setGoogleEnabled(c.google))
      .catch(() => setGoogleEnabled(false));
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, loading, googleEnabled, refresh, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main><p className="muted">Loading…</p></main>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** Use inside <RequireAuth>. */
export function RequireRole({ role, children }: { role: GlobalRole; children: ReactNode }) {
  const { user } = useAuth();
  if (!hasRole(user, role)) {
    return (
      <main className="stack">
        <h1>No access</h1>
        <p>You don't have access to this page.</p>
        <Link to="/">Go to the home page</Link>
      </main>
    );
  }
  return <>{children}</>;
}
