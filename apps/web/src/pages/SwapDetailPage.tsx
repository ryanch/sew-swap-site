import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { DATE_FIELDS, formatDate, type Swap } from '../swaps/swaps';

export default function SwapDetailPage() {
  const { swapId } = useParams();
  const [data, setData] = useState<{ swap: Swap; canEdit: boolean } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ swap: Swap; canEdit: boolean }>(`/api/swaps/${swapId}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [swapId]);

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
          <p>
            <button disabled>Join this swap</button>
          </p>
          <p className="muted small">Joining isn't open yet.</p>
          {data.canEdit && (
            <p>
              <Link className="button secondary" to={`/manage/swaps/${data.swap.swapId}/edit`}>
                Edit this swap
              </Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}
