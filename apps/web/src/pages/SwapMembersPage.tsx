import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { formatDate, type SwapMember } from '../swaps/swaps';

type Page = { members: SwapMember[]; total: number; nextCursor: string | null };

/** Who has joined a swap. The API only answers for that swap's managers and admins. */
export default function SwapMembersPage() {
  const { swapId } = useParams();
  const [members, setMembers] = useState<SwapMember[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = (after?: string) =>
    api<Page>(`/api/swaps/${swapId}/members${after ? `?after=${encodeURIComponent(after)}` : ''}`)
      .then((r) => {
        setMembers((prev) => (after ? [...prev, ...r.members] : r.members));
        setTotal(r.total);
        setCursor(r.nextCursor);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [swapId]);

  return (
    <main className="stack wide">
      <p>
        <Link to={`/swaps/${swapId}`}>← Back to the swap</Link>
      </p>
      <h1>Who has joined</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {total !== null && <p>{total === 1 ? '1 person has joined.' : `${total} people have joined.`}</p>}
      <ul className="user-list">
        {members.map((m) => (
          <li key={m.userId} className="user-row" aria-label={m.email}>
            <div>
              <strong>{m.displayName || m.email}</strong>
              <div className="muted small">
                {m.email} · joined {formatDate(m.joinedAt.slice(0, 10))}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {cursor && (
        <p>
          <button className="secondary" onClick={() => load(cursor)}>
            Show more
          </button>
        </p>
      )}
    </main>
  );
}
