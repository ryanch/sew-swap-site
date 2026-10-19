import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatDate, type Swap } from '../swaps/swaps';

/** Lists swaps. `mine` shows only the swaps the signed-in manager runs, with edit links. */
export default function SwapsPage({ mine = false }: { mine?: boolean }) {
  const [swaps, setSwaps] = useState<Swap[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ swaps: Swap[] }>(mine ? '/api/swaps/mine' : '/api/swaps')
      .then((r) => setSwaps(r.swaps))
      .catch((e) => setError(e.message));
  }, [mine]);

  return (
    <main className="stack wide">
      <p>
        <Link to="/">← Home</Link>
      </p>
      <h1>{mine ? 'My swaps' : 'Swaps'}</h1>
      {mine && (
        <p>
          <Link className="button" to="/manage/swaps/new">
            Create a swap
          </Link>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {swaps && swaps.length === 0 && (
        <p className="muted">{mine ? "You aren't running any swaps yet." : 'There are no swaps yet. Check back soon!'}</p>
      )}
      <ul className="user-list">
        {swaps?.map((s) => (
          <li key={s.swapId} className="user-row" aria-label={s.title}>
            <h2 style={{ margin: 0 }}>{s.title}</h2>
            <p className="muted">
              Sign-up: {formatDate(s.signUpOpens)} to {formatDate(s.signUpCloses)}
            </p>
            {s.swapperCount !== undefined && <p>Swappers: {s.swapperCount}</p>}
            <p className="row">
              <Link className="button secondary" to={`/swaps/${s.swapId}`}>
                View details
              </Link>
              {mine && (
                <Link className="button secondary" to={`/manage/swaps/${s.swapId}/edit`}>
                  Edit
                </Link>
              )}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
