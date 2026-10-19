import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatTimestamp } from '../swaps/swaps';

type LoggedEmail = { emailId: string; sentAt: string; kind: string; swapId: string | null; subject: string; body: string };

/** Copies of the emails we've sent the signed-in person (sign-in emails aren't kept). */
export default function EmailsPage() {
  const [emails, setEmails] = useState<LoggedEmail[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ emails: LoggedEmail[] }>('/api/me/emails')
      .then((r) => setEmails(r.emails))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <main className="stack">
      <p>
        <Link to="/">← Home</Link>
      </p>
      <h1>Emails we've sent you</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {emails && emails.length === 0 && <p>We haven't sent you any emails yet.</p>}
      {emails && emails.length > 0 && (
        <ul className="user-list">
          {emails.map((e) => (
            <li key={e.emailId} className="user-row" aria-label={e.subject}>
              <details>
                <summary>
                  <strong>{e.subject}</strong>
                  <div className="muted small">{formatTimestamp(e.sentAt)}</div>
                </summary>
                <p style={{ whiteSpace: 'pre-wrap' }}>{e.body}</p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
