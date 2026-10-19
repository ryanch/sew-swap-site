import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { Address } from '../swaps/address';
import { MailingAddress } from '../swaps/MailingAddress';
import { InstagramLink, memberPath, PersonPicker, SkillSelect } from '../swaps/manage';
import { MAX_RECIPIENTS, type Person, type Pod, type SwapMember } from '../swaps/swaps';

type Detail = SwapMember & { address: Address | null };

/** Everything the manager knows about one participant, and where they fix who makes for whom. */
export default function SwapMemberPage() {
  const { swapId = '', userId = '' } = useParams();
  const [member, setMember] = useState<Detail | null>(null);
  const [pods, setPods] = useState<Pod[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ member: Detail }>(`/api/swaps/${swapId}/members/${userId}`)
      .then((r) => setMember(r.member))
      .catch((e) => setError(e.message));

  useEffect(() => {
    setError('');
    load();
    api<{ pods: Pod[] }>(`/api/swaps/${swapId}/pods`)
      .then((r) => setPods(r.pods))
      .catch(() => {});
  }, [swapId, userId]);

  async function change(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const assign = (makerId: string, recipientId: string, on: boolean) =>
    change(() => api(`/api/swaps/${swapId}/assignments/${makerId}/${recipientId}`, { method: on ? 'PUT' : 'DELETE', body: {} }));
  const movePod = (podId: string) =>
    change(() => api(`/api/swaps/${swapId}/pods/${podId}/members`, { method: 'PUT', body: { userIds: [userId] } }));


  return (
    <main className="stack wide">
      <p>
        <Link to={`/manage/swaps/${swapId}/members`}>← Who has joined</Link>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {member && (
        <>
          <h1>{member.name}</h1>
          <p className="muted">{member.email}</p>
          <div className="member-tools">
            <InstagramLink handle={member.instagramHandle} confirmed={member.instagramConfirmed} />
            <SkillSelect swapId={swapId} member={member} onSaved={(skillLevel) => setMember({ ...member, skillLevel })} />
          </div>
          <div>
            <label htmlFor="pod">Pod</label>
            <select id="pod" value={member.pod.podId} disabled={busy} onChange={(e) => movePod(e.target.value)}>
              {pods.map((p) => (
                <option key={p.podId} value={p.podId}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {member.address && (
            <section>
              <h2>Mailing address</h2>
              <MailingAddress address={member.address} />
            </section>
          )}

          <section className="stack">
            <h2>Making for</h2>
            {member.makingFor.length === 0 && <p className="badge">Not making for anyone yet</p>}
            <PairList
              swapId={swapId}
              people={member.makingFor}
              busy={busy}
              removeLabel={(p) => `Stop making for ${p.name}`}
              onRemove={(p) => assign(userId, p.userId, false)}
            />
            {member.makingFor.length < MAX_RECIPIENTS ? (
              <PersonPicker
                swapId={swapId}
                label={`Find someone for ${member.name} to make for`}
                action={(m) =>
                  m.userId === userId ? (
                    <span className="muted">This is {member.name}</span>
                  ) : member.makingFor.some((p) => p.userId === m.userId) ? (
                    <span className="muted">Already making for them</span>
                  ) : (
                    <button disabled={busy} onClick={() => assign(userId, m.userId, true)}>
                      Make for {m.name}
                    </button>
                  )
                }
              />
            ) : (
              <p className="muted">
                {member.name} is making for {MAX_RECIPIENTS} people, which is the most one person can.
              </p>
            )}
          </section>

          <section className="stack">
            <h2>Made by</h2>
            {member.madeBy.length === 0 && <p className="badge">Nobody is making for {member.name} yet</p>}
            <PairList
              swapId={swapId}
              people={member.madeBy}
              busy={busy}
              removeLabel={(p) => `${p.name} stops making for them`}
              onRemove={(p) => assign(p.userId, userId, false)}
            />
          </section>
        </>
      )}
    </main>
  );
}

function PairList({
  swapId,
  people,
  busy,
  removeLabel,
  onRemove,
}: {
  swapId: string;
  people: Person[];
  busy: boolean;
  removeLabel: (p: Person) => string;
  onRemove: (p: Person) => void;
}) {
  if (people.length === 0) return null;
  return (
    <ul className="user-list">
      {people.map((p) => (
        <li key={p.userId} className="user-row picker-result" aria-label={p.name}>
          <div>
            <Link to={memberPath(swapId, p.userId)}>{p.name}</Link> <InstagramLink handle={p.instagramHandle} />
          </div>
          <button className="secondary" disabled={busy} onClick={() => onRemove(p)}>
            {removeLabel(p)}
          </button>
        </li>
      ))}
    </ul>
  );
}
