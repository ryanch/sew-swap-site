import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  formatDate,
  formatTimestamp,
  instagramUrl,
  membersUrl,
  people as peopleCount,
  SKILL_LEVELS,
  type MemberFilters,
  type MembersPage,
  type Paired,
  type Person,
  type PublishSummary,
  type SwapMember,
} from './swaps';

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

/**
 * A comma-separated list of people, each linked to their page and their Instagram.
 * With `showConfirmed` (once makers are published), each says whether the maker has confirmed.
 */
export function PeopleLinks({ swapId, people, showConfirmed }: { swapId: string; people: (Person | Paired)[]; showConfirmed?: boolean }) {
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
          {showConfirmed &&
            'confirmed' in p &&
            (p.confirmed ? (
              <span className="confirmed"> ✓ confirmed</span>
            ) : (
              <>
                {' '}
                <span className="badge">not confirmed yet</span>
              </>
            ))}
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
  published,
  children,
}: {
  swapId: string;
  member: SwapMember;
  onChange: (m: SwapMember) => void;
  /** Makers are published, so show who has confirmed. */
  published?: boolean;
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
          <PeopleLinks swapId={swapId} people={member.makingFor} showConfirmed={published} />
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

/** The swap's publish status, from GET …/publish. Managers only. */
export function usePublishSummary(swapId: string) {
  const [summary, setSummary] = useState<PublishSummary | null>(null);
  const [error, setError] = useState('');
  const reload = () =>
    api<PublishSummary>(`/api/swaps/${swapId}/publish`)
      .then(setSummary)
      .catch((e) => setError(e.message));
  useEffect(() => {
    reload();
  }, [swapId]);
  return { summary, error, reload };
}

/** The gaps a manager should know about before publishing, in plain words. */
function gapLines(s: PublishSummary) {
  const lines: string[] = [];
  if (s.withoutRecipient) {
    lines.push(`${peopleCount(s.withoutRecipient)} ${s.withoutRecipient === 1 ? "isn't" : "aren't"} making for anyone.`);
  }
  if (s.withoutMaker) lines.push(`${peopleCount(s.withoutMaker)} ${s.withoutMaker === 1 ? 'has' : 'have'} nobody making for them.`);
  return lines;
}

/**
 * Publishing who makes for whom. The manager decides when ("Partners announced" is only a guide).
 * Publishing emails every maker, so it asks twice, and warns first if anyone is left unpaired.
 * After publishing it tracks how many makers have confirmed.
 */
export function PublishPanel({
  swapId,
  summary,
  onPublished,
  pendingAction,
}: {
  swapId: string;
  summary: PublishSummary;
  onPublished: () => void;
  /** "Show who hasn't confirmed", once published. */
  pendingAction?: ReactNode;
}) {
  const [step, setStep] = useState<'idle' | 'confirming'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const gaps = gapLines(summary);
  const gapWarning = gaps.length > 0 && (
    <div className="warning big-warning" role="alert">
      <p>
        <strong>Warning: not everyone is paired.</strong>
      </p>
      <ul>
        {gaps.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
      <p>
        <Link to={`/manage/swaps/${swapId}/members?needs=${summary.withoutMaker ? 'maker' : 'recipient'}`}>See who needs attention</Link>.
        You can still publish, and pair them later.
      </p>
    </div>
  );

  async function publish() {
    if (!window.confirm(`Are you sure? This emails ${peopleCount(summary.makers)} now, and emails can't be unsent.`)) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ emailed: number; failed: number }>(`/api/swaps/${swapId}/publish`, {
        method: 'POST',
        body: { confirm: true },
      });
      setNotice(`Makers published. We emailed ${peopleCount(r.emailed)}.${r.failed ? ` ${r.failed} emails could not be sent. Send them a reminder to try again.` : ''}`);
      setStep('idle');
      onPublished();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (summary.publishedAt) {
    return (
      <section className="panel stack" aria-label="Publish makers">
        <h2>Makers published</h2>
        {notice && <p className="notice">{notice}</p>}
        <p>Makers were published on {formatTimestamp(summary.publishedAt)}.</p>
        <p>
          <strong>
            {summary.makersConfirmed} of {summary.makers} makers have confirmed.
          </strong>{' '}
          <span className="muted">
            ({summary.pairingsConfirmed} of {summary.pairings} pairings)
          </span>
        </p>
        {gapWarning}
        {summary.makersConfirmed < summary.makers && pendingAction}
      </section>
    );
  }

  return (
    <section className="panel stack" aria-label="Publish makers">
      <h2>Makers are not published yet</h2>
      <p>
        Makers can't see who they are making for until you publish. Partners announced:{' '}
        {formatDate(summary.partnersAnnounced)} (a guide only, nothing is published automatically).
      </p>
      <p>
        {summary.pairings === 1 ? '1 pairing' : `${summary.pairings} pairings`} so far, for{' '}
        {peopleCount(summary.makers)} making.
      </p>
      {gapWarning}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {step === 'idle' ? (
        <p>
          <button disabled={summary.makers === 0} onClick={() => setStep('confirming')}>
            Publish Makers
          </button>
        </p>
      ) : (
        <div className="warning stack">
          <p>
            <strong>Publish makers now?</strong> We will email all {peopleCount(summary.makers)} making something, asking
            them to sign in and confirm who they are making for.
          </p>
          {gaps.length > 0 && <p>{gaps.join(' ')}</p>}
          <p className="toolbar">
            <button disabled={busy} onClick={publish}>
              Yes, publish makers
            </button>
            <button className="secondary" disabled={busy} onClick={() => setStep('idle')}>
              Cancel
            </button>
          </p>
        </div>
      )}
    </section>
  );
}
