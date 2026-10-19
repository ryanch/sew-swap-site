import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api';
import { podPath } from '../swaps/manage';
import type { Pod } from '../swaps/swaps';

/** A swap's pods. Everyone starts in Default; managers make more and move people into them. */
export default function SwapPodsPage() {
  const { swapId = '' } = useParams();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () =>
    api<{ pods: Pod[] }>(`/api/swaps/${swapId}/pods`)
      .then((r) => setPods(r.pods))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [swapId]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/swaps/${swapId}/pods`, { method: 'POST', body: { name } });
      setName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="stack wide">
      <p>
        <Link to={`/manage/swaps/${swapId}/members`}>← Who has joined</Link>
      </p>
      <h1>Pods</h1>
      <p className="muted">
        A pod is a group of makers who make for each other. Only you can see pods and skill levels.
      </p>
      {notice && <p className="notice">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pods && (
        <ul className="user-list">
          {pods.map((p) => (
            <li key={p.podId} className="user-row pod-card" aria-label={p.name}>
              <Link to={podPath(swapId, p.podId)}>
                <strong>{p.name}</strong>
              </Link>
              <span className="muted">{p.count === 1 ? '1 person' : `${p.count} people`}</span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create}>
        <label htmlFor="pod-name">New pod name</label>
        <div className="row">
          <input id="pod-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={busy || !name.trim()}>
            Create pod
          </button>
        </div>
      </form>
    </main>
  );
}
