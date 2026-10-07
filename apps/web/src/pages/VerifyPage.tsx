import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth, type User } from '../auth/AuthContext';

/**
 * Landing page for the email link. The token is redeemed with a POST from here
 * (not by the link itself) so email security scanners that pre-open links
 * don't use it up before the person clicks.
 */
export default function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;
    const token = params.get('token');
    if (!token) {
      setError('This link has expired or was already used.');
      return;
    }
    api<{ user: User; isNewUser: boolean }>('/api/auth/email/verify-link', { method: 'POST', body: { token } })
      .then(async (res) => {
        await refresh();
        navigate('/', { replace: true, state: { welcome: res.isNewUser } });
      })
      .catch((err: Error) => setError(err.message));
  }, [params, navigate, refresh]);

  if (error) {
    return (
      <main className="stack">
        <h1>We couldn't sign you in</h1>
        <p className="error" role="alert">{error}</p>
        <p>Sign-in links work once and expire after 15 minutes.</p>
        <Link className="button" to="/login">
          Get a new sign-in link
        </Link>
      </main>
    );
  }
  return (
    <main>
      <p>Signing you in…</p>
    </main>
  );
}
