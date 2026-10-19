import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Address } from '../swaps/address';
import { MailingAddress } from '../swaps/MailingAddress';
import { formatDate, formatTimestamp, instagramUrl } from '../swaps/swaps';

export type Make = {
  swap: { swapId: string; title: string; shipBy: string };
  recipient: { userId: string; name: string; instagramHandle: string | null; address: Address | null };
  confirmedAt: string | null;
};

const CHECKS = ['seenInstagram', 'reviewedAddress', 'canShip'] as const;
type Check = (typeof CHECKS)[number];

/** One person the maker makes for. Confirming needs all three boxes ticked. */
function MakeCard({ make, onConfirmed }: { make: Make; onConfirmed: () => void }) {
  const { swap, recipient } = make;
  const [ticked, setTicked] = useState<Record<Check, boolean>>({ seenInstagram: false, reviewedAddress: false, canShip: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allTicked = CHECKS.every((c) => ticked[c]);
  const labels: Record<Check, string> = {
    seenInstagram: 'I can see the Instagram of the person I am making for',
    reviewedAddress: 'I have reviewed the address',
    canShip: `I am able to make for this person, and ship on ${formatDate(swap.shipBy)}`,
  };

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/swaps/${swap.swapId}/makes/${recipient.userId}/confirm`, { method: 'POST', body: ticked });
      onConfirmed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="user-row stack" aria-label={`Making for ${recipient.name}`}>
      <p className="muted small">{swap.title}</p>
      <h2>You are making for {recipient.name}</h2>
      <p>
        Instagram:{' '}
        {recipient.instagramHandle ? (
          <a href={instagramUrl(recipient.instagramHandle)} target="_blank" rel="noreferrer">
            @{recipient.instagramHandle}
          </a>
        ) : (
          <span className="muted">No Instagram</span>
        )}
      </p>
      {recipient.address && (
        <div>
          <strong>Mail it to:</strong>
          <MailingAddress address={recipient.address} />
        </div>
      )}
      <p>
        Ship by: <strong>{formatDate(swap.shipBy)}</strong>
      </p>
      {make.confirmedAt ? (
        <p className="notice">✓ You confirmed on {formatTimestamp(make.confirmedAt)}.</p>
      ) : (
        <fieldset className="stack">
          <legend>Please confirm</legend>
          {CHECKS.map((c) => (
            <label key={c} className="checkbox">
              <input type="checkbox" checked={ticked[c]} onChange={(e) => setTicked({ ...ticked, [c]: e.target.checked })} />
              {labels[c]}
            </label>
          ))}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="full" disabled={busy || !allTicked} onClick={confirm}>
            Confirm
          </button>
          {!allTicked && <p className="muted small">Tick all three boxes to confirm.</p>}
        </fieldset>
      )}
    </li>
  );
}

/** Who the signed-in person makes for, in swaps whose makers have been published. */
export default function MakesPage() {
  const [makes, setMakes] = useState<Make[] | null>(null);
  const [error, setError] = useState('');

  const load = () =>
    api<{ makes: Make[] }>('/api/me/makes')
      .then((r) => setMakes(r.makes))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const pending = makes?.filter((m) => !m.confirmedAt).length ?? 0;

  return (
    <main className="stack">
      <p>
        <Link to="/">← Home</Link>
      </p>
      <h1>Who you're making for</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {makes && makes.length === 0 && (
        <p>There's nothing to confirm yet. We'll email you when the organizer announces who you're making for.</p>
      )}
      {makes && makes.length > 0 && (
        <p>{pending ? `Please confirm ${pending === 1 ? 'this person' : `these ${pending} people`} below.` : "You've confirmed everyone. Thank you!"}</p>
      )}
      {makes && (
        <ul className="user-list">
          {makes.map((m) => (
            <MakeCard key={`${m.swap.swapId}/${m.recipient.userId}`} make={m} onConfirmed={load} />
          ))}
        </ul>
      )}
    </main>
  );
}
