import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { MemberRow, PublishPanel, usePublishSummary } from '../swaps/manage';
import {
  formatTimestamp,
  MAX_REMINDERS_PER_BATCH,
  membersUrl,
  people,
  type MembersPage,
  type SwapMember,
} from '../swaps/swaps';

type Needs = '' | 'maker' | 'recipient' | 'confirmation';
const NEEDS: Needs[] = ['', 'maker', 'recipient', 'confirmation'];

type ReminderResult = { sent: number; failed: number; skippedRecent: number; skippedConfirmed: number };

/** Who has joined a swap. The API only answers for that swap's managers and admins. */
export default function SwapMembersPage() {
  const { swapId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const needs: Needs = NEEDS.find((n) => n && n === params.get('needs')) ?? '';
  const setNeeds = (n: Needs) => setParams(n ? { needs: n } : {}, { replace: true });
  const [members, setMembers] = useState<SwapMember[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const publish = usePublishSummary(swapId);
  const published = Boolean(publish.summary?.publishedAt);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reminderNotice, setReminderNotice] = useState('');
  const [sending, setSending] = useState(false);
  // Reminders go out a batch at a time, so the pending list loads a batch at a time.
  const pageSize = needs === 'confirmation' ? MAX_REMINDERS_PER_BATCH : undefined;

  // Changing the filter while a page is loading must not let the older answer win.
  const latest = useRef(0);
  const load = (after?: string) => {
    const request = ++latest.current;
    return api<MembersPage>(membersUrl(swapId, { needs: needs || undefined, after, limit: pageSize }))
      .then((r) => {
        if (request !== latest.current) return;
        setMembers((prev) => (after ? [...prev, ...r.members] : r.members));
        setTotal(r.total);
        setCursor(r.nextCursor);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    setSelected(new Set());
    load();
  }, [swapId, needs]);

  const replace = (m: SwapMember) => setMembers((list) => list.map((x) => (x.userId === m.userId ? m : x)));

  const toggle = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else if (next.size < MAX_REMINDERS_PER_BATCH) next.add(userId);
      return next;
    });

  async function sendReminders() {
    if (!window.confirm(`Email a reminder to ${people(selected.size)}?`)) return;
    setSending(true);
    setError('');
    setReminderNotice('');
    try {
      const r = await api<ReminderResult>(`/api/swaps/${swapId}/reminders`, { method: 'POST', body: { userIds: [...selected] } });
      const parts = [`Sent ${r.sent} ${r.sent === 1 ? 'reminder' : 'reminders'}.`];
      if (r.skippedRecent) parts.push(`Skipped ${people(r.skippedRecent)} reminded in the last day.`);
      if (r.skippedConfirmed) parts.push(`Skipped ${people(r.skippedConfirmed)} who already confirmed.`);
      if (r.failed) parts.push(`${r.failed} could not be sent.`);
      setReminderNotice(parts.join(' '));
      setSelected(new Set());
      await Promise.all([load(), publish.reload()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const reminding = published && needs === 'confirmation';

  return (
    <main className="stack wide">
      <p>
        <Link to={`/swaps/${swapId}`}>← Back to the swap</Link>
      </p>
      <h1>Who has joined</h1>
      {publish.summary && (
        <PublishPanel
          swapId={swapId}
          summary={publish.summary}
          onPublished={() => {
            publish.reload();
            load();
          }}
          pendingAction={
            needs !== 'confirmation' && (
              <p>
                <button className="secondary" onClick={() => setNeeds('confirmation')}>
                  Show who hasn't confirmed
                </button>
              </p>
            )
          }
        />
      )}
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
          <option value="confirmation">Hasn't confirmed who they're making for</option>
        </select>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {reminderNotice && <p className="notice">{reminderNotice}</p>}
      {total !== null &&
        (needs ? (
          <p>{total === 1 ? '1 person.' : `${total} people.`}</p>
        ) : (
          <p>{total === 1 ? '1 person has joined.' : `${total} people have joined.`}</p>
        ))}
      {reminding && members.length > 0 && (
        <div className="toolbar" role="group" aria-label="Reminders">
          <button
            className="secondary"
            onClick={() => setSelected(new Set(members.slice(0, MAX_REMINDERS_PER_BATCH).map((m) => m.userId)))}
          >
            {members.length > MAX_REMINDERS_PER_BATCH ? `Select the first ${MAX_REMINDERS_PER_BATCH}` : 'Select all shown'}
          </button>
          {selected.size > 0 && (
            <button className="secondary" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
          <button disabled={sending || selected.size === 0} onClick={sendReminders}>
            Send reminder to {people(selected.size)}
          </button>
          <span className="muted small">Up to {MAX_REMINDERS_PER_BATCH} at a time.</span>
        </div>
      )}
      <ul className="user-list">
        {members.map((m) => (
          <MemberRow key={m.userId} swapId={swapId} member={m} onChange={replace} published={published}>
            {reminding && (
              <div className="toolbar">
                <label className="checkbox">
                  <input type="checkbox" checked={selected.has(m.userId)} onChange={() => toggle(m.userId)} />
                  Remind {m.name}
                </label>
                <span className="muted small">
                  {m.lastRemindedAt ? `Last reminded ${formatTimestamp(m.lastRemindedAt)}` : 'Never reminded'}
                </span>
              </div>
            )}
          </MemberRow>
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
