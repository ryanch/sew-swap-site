import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { hasRole, useAuth } from '../auth/AuthContext';
import type { Swap } from '../swaps/swaps';
import type { Make } from './MakesPage';

function SwapSection({ title, swaps }: { title: string; swaps: Swap[] }) {
  if (swaps.length === 0) return null;
  return (
    <section className="stack" aria-labelledby={title}>
      <h2 id={title}>{title}</h2>
      <ul className="user-list">
        {swaps.map((s) => (
          <li key={s.swapId} className="user-row" aria-label={`${title}: ${s.title}`}>
            <Link to={`/swaps/${s.swapId}`}>{s.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function HomePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [mine, setMine] = useState<{ joined: Swap[]; owned: Swap[] }>({ joined: [], owned: [] });
  const [toConfirm, setToConfirm] = useState(0);

  useEffect(() => {
    api<{ joined: Swap[]; owned: Swap[] }>('/api/me/swaps')
      .then(setMine)
      .catch(() => {});
    api<{ makes: Make[] }>('/api/me/makes')
      .then((r) => setToConfirm(r.makes.filter((m) => !m.confirmedAt).length))
      .catch(() => {});
  }, []);

  const welcome = (location.state as { welcome?: boolean } | null)?.welcome || params.get('welcome') === '1';

  return (
    <main className="stack">
      {welcome && <p className="notice">Welcome! Your account is ready.</p>}
      <h1>Hello, {user?.displayName ?? user?.email}</h1>
      <p className="muted">You are signed in as {user?.email}.</p>
      {toConfirm > 0 && (
        <div className="notice stack">
          <p className="tight">
            <strong>You've been given someone to make for!</strong> Please look at who it is and confirm.
          </p>
          <Link className="button full" to="/makes">
            Confirm who you're making for ({toConfirm})
          </Link>
        </div>
      )}
      <SwapSection title="Swaps You've Joined" swaps={mine.joined} />
      <SwapSection title="Swaps You Own" swaps={mine.owned} />
      <p>
        <Link className="button secondary" to="/swaps">
          Browse swaps
        </Link>
      </p>
      <p>
        <Link className="button secondary" to="/makes">
          Who I'm making for
        </Link>
      </p>
      <p>
        <Link className="button secondary" to="/emails">
          Emails we've sent you
        </Link>
      </p>
      {hasRole(user, 'swap_manager') && (
        <p>
          <Link className="button secondary" to="/manage/swaps">
            Manage my swaps
          </Link>
        </p>
      )}
      {hasRole(user, 'admin') && (
        <p>
          <Link className="button secondary" to="/admin/users">
            Manage user roles
          </Link>
        </p>
      )}
      <button
        className="secondary"
        onClick={async () => {
          await logout();
          navigate('/login', { replace: true });
        }}
      >
        Sign out
      </button>
    </main>
  );
}
