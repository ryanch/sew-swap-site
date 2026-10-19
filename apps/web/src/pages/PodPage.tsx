import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { CA_PROVINCES, COUNTRIES, US_STATES } from '../swaps/address';
import { InstagramLink, MemberRow, PersonPicker } from '../swaps/manage';
import { DEFAULT_POD, membersUrl, SKILL_LEVELS, type MemberFilters, type MembersPage, type Pod, type SwapMember } from '../swaps/swaps';

/** Sizes of the pods a split makes, as even as possible: 10 by 4 → 4, 3, 3. Mirrors the API. */
function splitSizes(total: number, size: number): number[] {
  if (size < 2 || total <= size) return [];
  const count = Math.ceil(total / size);
  return Array.from({ length: count }, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0));
}

async function allMembers(swapId: string, filters: MemberFilters) {
  const all: SwapMember[] = [];
  let after: string | undefined;
  do {
    const page = await api<MembersPage>(membersUrl(swapId, { ...filters, after, limit: 500 }));
    all.push(...page.members);
    after = page.nextCursor ?? undefined;
  } while (after);
  return all;
}

export default function PodPage() {
  const { swapId = '', podId = '' } = useParams();
  const navigate = useNavigate();
  const [pod, setPod] = useState<Pod | null>(null);
  const [members, setMembers] = useState<SwapMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; problems?: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isDefault = podId === DEFAULT_POD;

  const loadPod = () =>
    api<{ pods: Pod[] }>(`/api/swaps/${swapId}/pods`).then((r) => {
      const found = r.pods.find((p) => p.podId === podId);
      if (!found) setError('That pod was not found.');
      setPod(found ?? null);
    });
  const loadMembers = (after?: string) =>
    api<MembersPage>(membersUrl(swapId, { pod: podId, after })).then((r) => {
      setMembers((prev) => (after ? [...prev, ...r.members] : r.members));
      setCursor(r.nextCursor);
    });
  const reload = () => Promise.all([loadPod(), loadMembers()]).catch((e) => setError(e.message));

  useEffect(() => {
    setNotice(null);
    setError('');
    reload();
  }, [swapId, podId]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const addPeople = (userIds: string[], what: string) =>
    run(async () => {
      for (let i = 0; i < userIds.length; i += 500) {
        await api(`/api/swaps/${swapId}/pods/${podId}/members`, { method: 'PUT', body: { userIds: userIds.slice(i, i + 500) } });
      }
      setNotice({ text: what });
      await reload();
    });

  const moveToDefault = (m: SwapMember) =>
    run(async () => {
      await api(`/api/swaps/${swapId}/pods/${DEFAULT_POD}/members`, { method: 'PUT', body: { userIds: [m.userId] } });
      setNotice({ text: `Moved ${m.name} to Default.` });
      await reload();
    });

  const autoAssign = () =>
    run(async () => {
      const r = await api<{ added: { maker: string; recipient: string }[]; problems: string[] }>(
        `/api/swaps/${swapId}/pods/${podId}/auto-assign`,
        { method: 'POST', body: {} },
      );
      setNotice({
        text: r.added.length
          ? `Added ${r.added.length === 1 ? '1 pairing' : `${r.added.length} pairings`}. Pairings you made before are unchanged.`
          : 'Nothing to add: everyone in this pod already makes for someone and has a maker.',
        problems: r.problems,
      });
      await loadMembers();
    });

  const remove = () =>
    run(async () => {
      if (!window.confirm(`Delete the pod "${pod?.name}"? The people in it go back to Default. Who they make for doesn't change.`)) return;
      await api(`/api/swaps/${swapId}/pods/${podId}`, { method: 'DELETE' });
      navigate(`/manage/swaps/${swapId}/pods`, { state: { notice: `Deleted the pod "${pod?.name}".` } });
    });

  const replace = (m: SwapMember) => setMembers((list) => list.map((x) => (x.userId === m.userId ? m : x)));

  return (
    <main className="stack wide">
      <p>
        <Link to={`/manage/swaps/${swapId}/pods`}>← All pods</Link>
      </p>
      {pod && (
        <>
          <h1>{pod.name}</h1>
          <p>{pod.count === 1 ? '1 person in this pod.' : `${pod.count} people in this pod.`}</p>
        </>
      )}
      {notice && (
        <div className="notice" role="status">
          <p className="tight">{notice.text}</p>
          {notice.problems && notice.problems.length > 0 && (
            <div className="warning">
              <p>Still to sort out:</p>
              <ul>
                {notice.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pod && (
        <>
          <section className="panel">
            <PersonPicker
              swapId={swapId}
              label="Find a person to add to this pod"
              action={(m, done) =>
                m.pod.podId === podId ? (
                  <span className="muted">Already in this pod</span>
                ) : (
                  <button disabled={busy} onClick={() => addPeople([m.userId], `Added ${m.name} to ${pod.name}.`).then(done)}>
                    Add to this pod
                  </button>
                )
              }
            />
          </section>

          <BulkAdd swapId={swapId} pod={pod} busy={busy} onAdd={addPeople} />

          <section className="panel stack">
            <h2>Pairings</h2>
            <p className="muted">
              Auto-assign gives everyone in this pod one person to make for, in a loop. It never changes or removes pairings
              you've already made.
            </p>
            <p className="toolbar">
              <button disabled={busy || members.length === 0} onClick={autoAssign}>
                Auto-assign makers
              </button>
              <SplitButton
                swapId={swapId}
                pod={pod}
                busy={busy}
                onSplit={(text) => navigate(`/manage/swaps/${swapId}/pods`, { state: { notice: text } })}
                onError={setError}
              />
            </p>
          </section>

          {!isDefault && <RenameForm swapId={swapId} pod={pod} onRenamed={reload} onDelete={remove} busy={busy} />}

          <section className="stack" aria-label="People in this pod">
            <h2>People in this pod</h2>
            {members.length === 0 && <p>No one is in this pod yet.</p>}
            <ul className="user-list">
              {members.map((m) => (
                <MemberRow key={m.userId} swapId={swapId} member={m} onChange={replace}>
                  {!isDefault && (
                    <button className="secondary" disabled={busy} onClick={() => moveToDefault(m)}>
                      Move to Default
                    </button>
                  )}
                </MemberRow>
              ))}
            </ul>
            {cursor && (
              <p>
                <button className="secondary" onClick={() => loadMembers(cursor).catch((e) => setError(e.message))}>
                  Show more
                </button>
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

/** Find everyone matching a country, state and skill level, and add them all at once. */
function BulkAdd({
  swapId,
  pod,
  busy,
  onAdd,
}: {
  swapId: string;
  pod: Pod;
  busy: boolean;
  onAdd: (userIds: string[], what: string) => Promise<void>;
}) {
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [skill, setSkill] = useState('');
  const [includeOtherPods, setIncludeOtherPods] = useState(false);
  const [matches, setMatches] = useState<SwapMember[] | null>(null);
  const [error, setError] = useState('');
  const isDefault = pod.podId === DEFAULT_POD;
  const regions = country === 'US' ? US_STATES : country === 'CA' ? CA_PROVINCES : null;
  const regionLabel = country === 'CA' ? 'Province' : 'State or region';

  async function find(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      // People already in another pod are left alone unless asked; adding to Default always takes them out of one.
      const fromDefault = !isDefault && !includeOtherPods;
      setMatches(await allMembers(swapId, { exceptPod: pod.podId, pod: fromDefault ? DEFAULT_POD : undefined, country, region, skill }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const add = async () => {
    if (!matches) return;
    await onAdd(
      matches.map((m) => m.userId),
      `Added ${matches.length === 1 ? '1 person' : `${matches.length} people`} to ${pod.name}.`,
    );
    setMatches(null);
  };

  return (
    <section className="panel">
      <form className="stack" onSubmit={find}>
        <h2>Add many people</h2>
        <p className="muted">Pick any of these. Leave one on "Any" to match everyone.</p>
        <div className="filters">
          <div>
            <label htmlFor="bulk-country">Country</label>
            <select
              id="bulk-country"
              value={country}
              onChange={(e) => {
                setCountry(e.target.value);
                setRegion('');
              }}
            >
              <option value="">Any country</option>
              {COUNTRIES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bulk-region">{regionLabel}</label>
            {regions ? (
              <select id="bulk-region" value={region} onChange={(e) => setRegion(e.target.value)}>
                <option value="">Any</option>
                {regions.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <input id="bulk-region" value={region} placeholder="Any" onChange={(e) => setRegion(e.target.value)} />
            )}
          </div>
          <div>
            <label htmlFor="bulk-skill">Skill level</label>
            <select id="bulk-skill" value={skill} onChange={(e) => setSkill(e.target.value)}>
              <option value="">Any skill level</option>
              <option value="none">Not rated</option>
              {SKILL_LEVELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!isDefault && (
          <label className="checkbox">
            <input type="checkbox" checked={includeOtherPods} onChange={(e) => setIncludeOtherPods(e.target.checked)} />
            Also take people who are already in another pod
          </label>
        )}
        <p>
          <button type="submit" className="secondary">
            Find people
          </button>
        </p>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {matches && (
        <div className="stack">
          <p>{matches.length === 0 ? 'No one matches.' : matches.length === 1 ? '1 person matches.' : `${matches.length} people match.`}</p>
          {matches.length > 0 && (
            <>
              <ul className="match-list">
                {matches.slice(0, 50).map((m) => (
                  <li key={m.userId}>
                    {m.name} <InstagramLink handle={m.instagramHandle} />{' '}
                    <span className="muted small">
                      ({[m.region, m.country].filter(Boolean).join(', ')} · {m.pod.name})
                    </span>
                  </li>
                ))}
                {matches.length > 50 && <li className="muted">and {matches.length - 50} more</li>}
              </ul>
              <button disabled={busy} onClick={add}>
                Add {matches.length === 1 ? 'this person' : `these ${matches.length} people`}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SplitButton({
  swapId,
  pod,
  busy,
  onSplit,
  onError,
}: {
  swapId: string;
  pod: Pod;
  busy: boolean;
  onSplit: (notice: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState('4');
  const [working, setWorking] = useState(false);
  const sizes = splitSizes(pod.count, Number(size));

  async function split(e: FormEvent) {
    e.preventDefault();
    setWorking(true);
    onError('');
    try {
      const r = await api<{ pods: Pod[] }>(`/api/swaps/${swapId}/pods/${pod.podId}/split`, {
        method: 'POST',
        body: { size: Number(size) },
      });
      onSplit(`Split ${pod.name} into ${r.pods.length} pods: ${r.pods.map((p) => `${p.name} (${p.count})`).join(', ')}.`);
    } catch (err) {
      onError((err as Error).message);
      setWorking(false);
    }
  }

  if (!open) {
    return (
      <button className="secondary" disabled={busy || pod.count < 3} onClick={() => setOpen(true)}>
        Split into smaller pods
      </button>
    );
  }
  return (
    <form className="split-form stack" onSubmit={split}>
      <div>
        <label htmlFor="split-size">How many people in each pod?</label>
        <input id="split-size" type="number" min={2} value={size} onChange={(e) => setSize(e.target.value)} />
      </div>
      <p className="muted small">
        {sizes.length
          ? `This makes ${sizes.length} pods with ${sizes.join(', ')} people, grouped by skill and then where they live.`
          : `Pick a number from 2 to ${pod.count - 1}.`}
      </p>
      <p className="toolbar">
        <button type="submit" disabled={working || sizes.length === 0}>
          Split
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </p>
    </form>
  );
}

function RenameForm({
  swapId,
  pod,
  busy,
  onRenamed,
  onDelete,
}: {
  swapId: string;
  pod: Pod;
  busy: boolean;
  onRenamed: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(pod.name);
  const [error, setError] = useState('');

  useEffect(() => setName(pod.name), [pod.name]);

  async function rename(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/swaps/${swapId}/pods/${pod.podId}`, { method: 'PATCH', body: { name } });
      onRenamed();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="panel stack">
      <form onSubmit={rename}>
        <label htmlFor="rename">Pod name</label>
        <div className="row">
          <input id="rename" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="secondary" disabled={busy || !name.trim() || name.trim() === pod.name}>
            Rename
          </button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p>
        <button className="secondary danger" disabled={busy} onClick={onDelete}>
          Delete this pod
        </button>
      </p>
    </section>
  );
}
