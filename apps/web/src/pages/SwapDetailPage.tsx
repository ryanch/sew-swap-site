import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { PublishPanel, usePublishSummary } from '../swaps/manage';
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

  async function leave() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/swaps/${swapId}/membership`, { method: 'DELETE' });
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
              {data.swap.makersPublishedAt && (
                <p>
                  <Link className="button" to="/makes">
                    See who you're making for
                  </Link>
                </p>
              )}
              <p>
                {data.signUpStatus === 'open' && (
                  <>
                    <Link className="button secondary" to={`/swaps/${data.swap.swapId}/join`}>
                      Change my details
                    </Link>{' '}
                  </>
                )}
                <button className="secondary" disabled={busy} onClick={leave}>
                  Leave this swap
                </button>
              </p>
            </>
          ) : data.signUpStatus === 'open' ? (
            <p>
              <Link className="button" to={`/swaps/${data.swap.swapId}/join`}>
                Join this swap
              </Link>
            </p>
          ) : (
            <p className="muted">
              {data.signUpStatus === 'upcoming'
                ? `Sign-up opens on ${formatDate(data.swap.signUpOpens)}.`
                : 'Sign-up for this swap has closed.'}
            </p>
          )}
          {data.canEdit && <ManagerPublish swapId={data.swap.swapId} />}
          {data.canEdit && (
            <p>
              <Link className="button secondary" to={`/manage/swaps/${data.swap.swapId}/edit`}>
                Edit this swap
              </Link>{' '}
              <Link className="button secondary" to={`/manage/swaps/${data.swap.swapId}/members`}>
                See who's signed up
              </Link>{' '}
              <Link className="button secondary" to={`/manage/swaps/${data.swap.swapId}/pods`}>
                Pods and pairings
              </Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}

/** The publish panel for the swap's managers, linking to the members page to follow up. */
function ManagerPublish({ swapId }: { swapId: string }) {
  const { summary, reload } = usePublishSummary(swapId);
  if (!summary) return null;
  return (
    <PublishPanel
      swapId={swapId}
      summary={summary}
      onPublished={reload}
      pendingAction={
        <p>
          <Link className="button secondary" to={`/manage/swaps/${swapId}/members?needs=confirmation`}>
            Show who hasn't confirmed
          </Link>
        </p>
      }
    />
  );
}
