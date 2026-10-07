import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth, type User } from '../auth/AuthContext';

export default function LoginPage() {
  const { user, googleEnabled, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(params.get('error') === 'google' ? 'Google sign-in did not work. Please try again or use your email.' : '');
  const [resent, setResent] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const requestLink = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/email/request', { method: 'POST', body: { email } });
      if (step === 'code') setResent(true);
      setStep('code');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ user: User; isNewUser: boolean }>('/api/auth/email/verify-code', {
        method: 'POST',
        body: { email, code },
      });
      await refresh();
      navigate('/', { replace: true, state: { welcome: res.isNewUser } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'code') {
    return (
      <main className="stack">
        <h1>Check your email</h1>
        <p>
          We sent a sign-in link to <strong>{email}</strong>. Click the button in that email to sign in.
        </p>
        <p className="muted">Reading your email on another device? Type the 6-digit code from the email here instead:</p>
        <form onSubmit={submitCode} className="stack">
          <div>
            <label htmlFor="code">6-digit code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="full" disabled={busy || code.length !== 6}>
            Sign in
          </button>
        </form>
        {resent && <p className="notice">We sent you a new email.</p>}
        <p>
          <button type="button" className="secondary" onClick={() => requestLink()} disabled={busy}>
            Send the email again
          </button>{' '}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setStep('email');
              setCode('');
              setError('');
              setResent(false);
            }}
          >
            Use a different email
          </button>
        </p>
      </main>
    );
  }

  return (
    <main className="stack">
      <h1>Sign in to Sew Swap</h1>
      <p>Enter your email address and we'll send you a link to sign in. No password needed.</p>
      <form onSubmit={requestLink} className="stack">
        <div>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="full" disabled={busy}>
          Email me a sign-in link
        </button>
      </form>
      {googleEnabled && (
        <>
          <p className="divider">or</p>
          <a className="button secondary full" href="/api/auth/google/start" style={{ boxSizing: 'border-box' }}>
            Sign in with Google
          </a>
        </>
      )}
    </main>
  );
}
