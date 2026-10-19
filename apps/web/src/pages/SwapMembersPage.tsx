import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { MemberRow } from '../swaps/manage';
import { membersUrl, type MembersPage, type SwapMember } from '../swaps/swaps';

type Needs = '' | 'maker' | 'recipient';

/** Who has joined a swap. The API only answers for that swap's managers and admins. */
export default function SwapMembersPage() {
  const { swapId = '' } = useParams();
  const [members, setMembers] = useState<SwapMember[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [needs, setNeeds] = useState<Needs>('');
  const [error, setError] = useState('');

  // Changing the filter while a page is loading must not let the older answer win.
  const latest = useRef(0);
  const load = (after?: string) => {
    const request = ++latest.current;
    return api<MembersPage>(membersUrl(swapId, { needs: needs || undefined, after }))
      .then((r) => {
        if (request !== latest.current) return;
        setMembers((prev) => (after ? [...prev, ...r.members] : r.members));
        setTotal(r.total);
        setCursor(r.nextCursor);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
  }, [swapId, needs]);

  const replace = (m: SwapMember) => setMembers((list) => list.map((x) => (x.userId === m.userId ? m : x)));

  return (
    <main className="stack wide">
      <p>
        <Link to={`/swaps/${swapId}`}>← Back to the swap</Link>
      </p>
      <h1>Who has joined</h1>
      <p className="toolbar">
        <Link className="button secondary" to={`/manage/swaps/${swapId}/pods`}>
          Pods and pairings
        </Link>
        <a className="button secondary" href={`/api/swaps/${swapId}/export.csv`} download>
          Download CSV
        </a>
      </p>
      <div>
        <label htmlFor="needs">Show</label>
        <select id="needs" value={needs} onChange={(e) => setNeeds(e.target.value as Needs)}>
          <option value="">Everyone</option>
          <option value="maker">Needs attention: nobody is making for them</option>
          <option value="recipient">Needs attention: not making for anyone</option>
        </select>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {total !== null &&
        (needs ? (
          <p>{total === 1 ? '1 person.' : `${total} people.`}</p>
        ) : (
          <p>{total === 1 ? '1 person has joined.' : `${total} people have joined.`}</p>
        ))}
      <ul className="user-list">
        {members.map((m) => (
          <MemberRow key={m.userId} swapId={swapId} member={m} onChange={replace} />
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
