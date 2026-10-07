import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { hasRole, useAuth } from '../auth/AuthContext';

export default function HomePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const welcome = (location.state as { welcome?: boolean } | null)?.welcome || params.get('welcome') === '1';

  return (
    <main className="stack">
      {welcome && <p className="notice">Welcome! Your account is ready.</p>}
      <h1>Hello, {user?.displayName ?? user?.email}</h1>
      <p className="muted">You are signed in as {user?.email}.</p>
      <p>
        <Link className="button secondary" to="/swaps">
          Browse swaps
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
