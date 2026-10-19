import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { instagramUrl, membersUrl, SKILL_LEVELS, type MemberFilters, type MembersPage, type Person, type SwapMember } from './swaps';

// Pieces shared by the manager's pages: members list, pods and a person's page.
// Managers judge skill from Instagram, so a person's @handle is always a link, next to the skill picker.

export const memberPath = (swapId: string, userId: string) => `/manage/swaps/${swapId}/members/${userId}`;
export const podPath = (swapId: string, podId: string) => `/manage/swaps/${swapId}/pods/${podId}`;

export function InstagramLink({ handle, confirmed }: { handle: string | null; confirmed?: boolean }) {
  return (
    <>
      {handle ? (
        <a href={instagramUrl(handle)} target="_blank" rel="noreferrer">
          @{handle}
        </a>
      ) : (
        <span className="muted">No Instagram</span>
      )}
      {confirmed === false && (
        <>
          {' '}
          <span className="badge" title="We couldn't confirm this Instagram account is public">
            Instagram unconfirmed
          </span>
        </>
      )}
    </>
  );
}

/** Picks a skill level and saves it right away. */
export function SkillSelect({
  swapId,
  member,
  onSaved,
}: {
  swapId: string;
  member: Pick<SwapMember, 'userId' | 'name' | 'skillLevel'>;
  onSaved: (skillLevel: number | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(value: string) {
    const skillLevel = value ? Number(value) : null;
    setBusy(true);
    setError('');
    try {
      await api(`/api/swaps/${swapId}/members/${member.userId}`, { method: 'PATCH', body: { skillLevel } });
      onSaved(skillLevel);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="skill">
      <select
        className="compact"
        aria-label={`Skill level for ${member.name}`}
        value={member.skillLevel ?? ''}
        disabled={busy}
        onChange={(e) => save(e.target.value)}
      >
        <option value="">Skill: not rated</option>
        {SKILL_LEVELS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {error && (
        <span className="error" role="alert">
          {' '}
          {error}
        </span>
      )}
    </span>
  );
}

/** A comma-separated list of people, each linked to their page and their Instagram. */
export function PeopleLinks({ swapId, people }: { swapId: string; people: Person[] }) {
  return (
    <>
      {people.map((p, i) => (
        <span key={p.userId}>
          {i > 0 && ', '}
          <Link to={memberPath(swapId, p.userId)}>{p.name}</Link>
          {p.instagramHandle && (
            <>
              {' ('}
              <InstagramLink handle={p.instagramHandle} />
              {')'}
            </>
          )}
        </span>
      ))}
    </>
  );
}

/** One participant, as listed on the members and pod pages. `children` adds buttons. */
export function MemberRow({
  swapId,
  member,
  onChange,
  children,
}: {
  swapId: string;
  member: SwapMember;
  onChange: (m: SwapMember) => void;
  children?: ReactNode;
}) {
  const place = [member.city, member.region, member.country].filter(Boolean).join(', ');
  return (
    <li className="user-row" aria-label={member.email}>
      <div>
        <strong>
          <Link to={memberPath(swapId, member.userId)}>{member.name}</Link>
        </strong>
        <div className="muted small">
          {member.email}
          {place && ` · ${place}`}
        </div>
      </div>
      <div className="member-tools">
        <InstagramLink handle={member.instagramHandle} confirmed={member.instagramConfirmed} />
        <SkillSelect swapId={swapId} member={member} onSaved={(skillLevel) => onChange({ ...member, skillLevel })} />
        <span>
          Pod: <Link to={podPath(swapId, member.pod.podId)}>{member.pod.name}</Link>
        </span>
      </div>
      <div className="small">
        Makes for:{' '}
        {member.makingFor.length ? (
          <PeopleLinks swapId={swapId} people={member.makingFor} />
        ) : (
          <span className="badge">Not making for anyone</span>
        )}
      </div>
      <div className="small">
        Made by:{' '}
        {member.madeBy.length ? (
          <PeopleLinks swapId={swapId} people={member.madeBy} />
        ) : (
          <span className="badge">Nobody is making for them</span>
        )}
      </div>
      {children && <div className="row-actions">{children}</div>}
    </li>
  );
}

/** Search the swap's participants by name, email or Instagram, and act on one of them. */
export function PersonPicker({
  swapId,
  label,
  filters = {},
  action,
}: {
  swapId: string;
  label: string;
  filters?: MemberFilters;
  action: (m: SwapMember, done: () => void) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SwapMember[] | null>(null);
  const [error, setError] = useState('');
  const id = `picker-${label.replace(/\W+/g, '-').toLowerCase()}`;

  async function search(e?: FormEvent) {
    e?.preventDefault();
    setError('');
    try {
      const page = await api<MembersPage>(membersUrl(swapId, { ...filters, q: query, limit: 20 }));
      setResults(page.members);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <form onSubmit={search} role="search">
        <label htmlFor={id}>{label}</label>
        <div className="row">
          <input
            id={id}
            type="search"
            placeholder="Name, email or Instagram"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">Search</button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {results && results.length === 0 && <p>No one matches that search.</p>}
      {results && results.length > 0 && (
        <ul className="user-list">
          {results.map((m) => (
            <li key={m.userId} className="user-row" aria-label={m.email}>
              <div className="picker-result">
                <div>
                  <strong>{m.name}</strong> <InstagramLink handle={m.instagramHandle} confirmed={m.instagramConfirmed} />
                  <div className="muted small">
                    {m.email} · Pod: {m.pod.name}
                  </div>
                </div>
                <div>{action(m, () => search())}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
