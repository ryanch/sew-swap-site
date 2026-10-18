import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { DATE_FIELDS, formatDate, type SignUpStatus, type Swap } from '../swaps/swaps';

type SwapData = {
  swap: Swap;
  canEdit: boolean;
  signUpStatus: SignUpStatus;
  membership: { joinedAt: string } | null;
};

export default function SwapDetailPage() {
  const { swapId } = useParams();
  const [data, setData] = useState<SwapData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<SwapData>(`/api/swaps/${swapId}`)
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [swapId]);

  async function changeMembership(method: 'PUT' | 'DELETE') {
    setBusy(true);
    setError('');
    try {
      await api(`/api/swaps/${swapId}/membership`, { method });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="stack wide">
      <p>
        <Link to="/swaps">← All swaps</Link>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <h1>{data.swap.title}</h1>
          {data.swap.description && <p style={{ whiteSpace: 'pre-wrap' }}>{data.swap.description}</p>}
          <dl className="dates">
            {DATE_FIELDS.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{formatDate(data.swap[key])}</dd>
              </div>
            ))}
          </dl>
          {data.membership ? (
            <>
              <p>You've joined this swap.</p>
              <p>
                <button className="secondary" disabled={busy} onClick={() => changeMembership('DELETE')}>
                  Leave this swap
                </button>
              </p>
            </>
          ) : data.signUpStatus === 'open' ? (
            <p>
              <button disabled={busy} onClick={() => changeMembership('PUT')}>
                Join this swap
              </button>
            </p>
          ) : (
            <p className="muted">
              {data.signUpStatus === 'upcoming'
                ? `Sign-up opens on ${formatDate(data.swap.signUpOpens)}.`
                : 'Sign-up for this swap has closed.'}
            </p>
          )}
          {data.canEdit && (
            <p>
              <Link className="button secondary" to={`/manage/swaps/${data.swap.swapId}/edit`}>
                Edit this swap
              </Link>{' '}
              <Link className="button secondary" to={`/manage/swaps/${data.swap.swapId}/members`}>
                See who's signed up
              </Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}
