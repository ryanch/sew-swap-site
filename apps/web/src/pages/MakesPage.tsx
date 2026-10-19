import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Address } from '../swaps/address';
import { MailingAddress } from '../swaps/MailingAddress';
import { TrackingLink } from '../swaps/manage';
import { CARRIERS, formatDate, formatTimestamp, guessCarrier, instagramUrl, type Shipment } from '../swaps/swaps';

export type Make = {
  swap: { swapId: string; title: string; shipBy: string };
  recipient: { userId: string; name: string; instagramHandle: string | null; address: Address | null };
  confirmedAt: string | null;
  shipped: Shipment | null;
};

/** The tracking number and carrier, once the maker has sent the package. Sending again corrects them. */
function ShipForm({ make, onShipped, onCancel }: { make: Make; onShipped: () => void; onCancel?: () => void }) {
  const [trackingNumber, setTrackingNumber] = useState(make.shipped?.trackingNumber ?? '');
  const [carrier, setCarrier] = useState(make.shipped?.carrier ?? '');
  // The guess fills the carrier until the maker picks one themselves.
  const [picked, setPicked] = useState(Boolean(make.shipped));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = `ship-${make.swap.swapId}-${make.recipient.userId}`;

  function typeNumber(value: string) {
    setTrackingNumber(value);
    if (!picked) setCarrier(guessCarrier(value));
  }

  async function ship() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/swaps/${make.swap.swapId}/makes/${make.recipient.userId}/ship`, {
        method: 'POST',
        body: { carrier, trackingNumber },
      });
      onShipped();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = trackingNumber.trim() !== '' && carrier !== '';
  return (
    <fieldset className="stack">
      <legend>{make.shipped ? 'Fix the tracking number' : 'Have you shipped it?'}</legend>
      <p className="tight">When you've sent the package, enter the tracking number from your receipt. We'll send it to {make.recipient.name}.</p>
      <div>
        <label htmlFor={`${id}-number`}>Tracking number</label>
        <input id={`${id}-number`} value={trackingNumber} autoComplete="off" onChange={(e) => typeNumber(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${id}-carrier`}>Shipped with</label>
        <select
          id={`${id}-carrier`}
          value={carrier}
          onChange={(e) => {
            setCarrier(e.target.value);
            setPicked(true);
          }}
        >
          <option value="">Choose the carrier</option>
          {CARRIERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="full" disabled={busy || !ready} onClick={ship}>
        I've shipped it
      </button>
      {!ready && <p className="muted small">Enter the tracking number and choose the carrier.</p>}
      {onCancel && (
        <button className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      )}
    </fieldset>
  );
}

const CHECKS = ['seenInstagram', 'reviewedAddress', 'canShip'] as const;
type Check = (typeof CHECKS)[number];

/** One person the maker makes for. Confirming needs all three boxes ticked. */
function MakeCard({ make, onConfirmed }: { make: Make; onConfirmed: () => void }) {
  const { swap, recipient } = make;
  const [fixing, setFixing] = useState(false);
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
        <>
          <p className="notice">✓ You confirmed on {formatTimestamp(make.confirmedAt)}.</p>
          {make.shipped && !fixing && (
            <div className="notice stack">
              <p className="tight">
                📦 You shipped it on {formatTimestamp(make.shipped.shippedAt)}. Tracking: <TrackingLink shipment={make.shipped} />
              </p>
              <p className="tight">
                <button className="secondary" onClick={() => setFixing(true)}>
                  Fix tracking number
                </button>
              </p>
            </div>
          )}
          {(!make.shipped || fixing) && (
            <ShipForm
              make={make}
              onShipped={() => {
                setFixing(false);
                onConfirmed();
              }}
              onCancel={fixing ? () => setFixing(false) : undefined}
            />
          )}
        </>
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
  const toShip = makes?.filter((m) => m.confirmedAt && !m.shipped).length ?? 0;

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
        <p>
          {pending
            ? `Please confirm ${pending === 1 ? 'this person' : `these ${pending} people`} below.`
            : makes.every((m) => m.shipped)
              ? "You've shipped to everyone. Thank you!"
              : "You've confirmed everyone. Thank you!"}
          {toShip > 0 && ` When you've shipped, add the tracking number below (${toShip} to go).`}
        </p>
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
