import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth, type GlobalRole } from '../auth/AuthContext';

type AdminUser = {
  userId: string;
  email: string;
  displayName: string | null;
  roles: GlobalRole[];
  bootstrapAdmin: boolean;
};

const ROLE_LABELS: { role: GlobalRole; label: string; help: string }[] = [
  { role: 'admin', label: 'Admin', help: 'Can do everything, including changing roles.' },
  { role: 'swap_manager', label: 'Swap Manager', help: 'Can create and run swaps.' },
];

export default function AdminUsersPage() {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState('');

  // Only the newest search may fill the list: the first load can finish after a search typed quickly.
  const latest = useRef(0);
  const load = useCallback(async (q: string) => {
    const request = ++latest.current;
    setError('');
    try {
      const res = await api<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`);
      if (request === latest.current) setUsers(res.users);
    } catch (err) {
      if (request === latest.current) setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load('');
  }, [load]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    load(query);
  };

  const replace = (updated: AdminUser) =>
    setUsers((list) => list?.map((u) => (u.userId === updated.userId ? updated : u)) ?? null);

  return (
    <main className="stack wide">
      <p>
        <Link to="/">← Home</Link>
      </p>
      <h1>User roles</h1>
      <p className="muted">People appear here after they sign in for the first time.</p>
      <form className="search" onSubmit={search} role="search">
        <label htmlFor="user-search">Find a person by email or name</label>
        <div className="row">
          <input id="user-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit">Search</button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {users && users.length === 0 && <p>No one matches that search.</p>}
      {users && users.length > 0 && (
        <ul className="user-list">
          {users.map((u) => (
            <UserRow key={u.userId} user={u} onChange={replace} />
          ))}
        </ul>
      )}
    </main>
  );
}

function UserRow({ user, onChange }: { user: AdminUser; onChange: (u: AdminUser) => void }) {
  const { user: me } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const lockedReason = (role: GlobalRole) => {
    if (role !== 'admin' || !user.roles.includes('admin')) return '';
    if (user.bootstrapAdmin) return 'Admin is set by the ADMIN_EMAILS setting.';
    if (user.userId === me?.userId) return "You can't remove your own Admin role.";
    return '';
  };

  const toggle = async (role: GlobalRole, on: boolean) => {
    setBusy(true);
    setError('');
    try {
      const path = `/api/admin/users/${encodeURIComponent(user.userId)}/roles/${role}`;
      const res = await api<{ user: AdminUser }>(path, { method: on ? 'PUT' : 'DELETE', body: {} });
      onChange(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const notes = ROLE_LABELS.map(({ role }) => lockedReason(role)).filter(Boolean);

  return (
    <li className="user-row" aria-label={user.email}>
      <div>
        <strong>{user.displayName ?? user.email}</strong>
        {user.displayName && <div className="muted">{user.email}</div>}
      </div>
      <div className="roles">
        {ROLE_LABELS.map(({ role, label, help }) => (
          <label key={role} className="checkbox" title={help}>
            <input
              type="checkbox"
              checked={user.roles.includes(role)}
              disabled={busy || !!lockedReason(role)}
              onChange={(e) => toggle(role, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
      {notes.map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
