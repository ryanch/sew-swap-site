import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { CA_PROVINCES, COUNTRIES, EMPTY_ADDRESS, US_STATES, type Address } from '../swaps/address';
import { instagramUrl, type SignUpStatus, type Swap } from '../swaps/swaps';

type IgResult = 'public' | 'private' | 'not_found' | 'exists' | 'unknown';
type Check = { handle: string; result: IgResult; changed: boolean; input: string };
type Profile = {
  email: string;
  address: Address | null;
  instagram: { handle: string; result: IgResult; current: boolean } | null;
};
type SwapData = { swap: Swap; signUpStatus: SignUpStatus; membership: { joinedAt: string } | null };

const PASSING: IgResult[] = ['public', 'exists', 'unknown'];

/** Seconds left until `until`, re-rendering every second while it counts down. */
function useCountdown(until: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * Signing up for a swap: the account email, a mailing address, and an Instagram account
 * that the server has checked is real and (ideally) public. The server re-checks all of it.
 */
export default function SwapJoinPage() {
  const { swapId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<SwapData | null>(null);
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [igInput, setIgInput] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const [needsRecheck, setNeedsRecheck] = useState(false);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [checking, setChecking] = useState(false);
  const [igError, setIgError] = useState('');
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const waitSeconds = useCountdown(cooldownUntil);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // A load that finishes after cleanup (StrictMode runs effects twice) must not overwrite what was typed.
    let stale = false;
    Promise.all([api<SwapData>(`/api/swaps/${swapId}`), api<Profile>('/api/me/profile')])
      .then(([swapData, profile]) => {
        if (stale) return;
        setData(swapData);
        setEmail(profile.email);
        if (profile.address) setAddress(profile.address);
        if (profile.instagram) {
          setIgInput(profile.instagram.handle);
          if (profile.instagram.current) {
            const { handle, result } = profile.instagram;
            setCheck({ handle, result, changed: false, input: handle });
          } else {
            setNeedsRecheck(true);
          }
        }
      })
      .catch((e) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [swapId]);

  const set = (key: keyof Address) => (value: string) =>
    setAddress((a) => ({ ...a, [key]: value, ...(key === 'country' ? { region: '' } : {}) }));

  // A result only counts for the name it was about; typing something new needs a new check.
  const current = check && check.handle === igInput.trim() ? check : null;
  const igOk = !!current && PASSING.includes(current.result) && (current.result === 'public' || confirmPublic);

  async function checkInstagram() {
    setChecking(true);
    setIgError('');
    setNeedsRecheck(false);
    try {
      const r = await api<Check & { retryAfterSeconds: number }>('/api/me/instagram/check', {
        method: 'POST',
        body: { input: igInput },
      });
      setIgInput(r.handle);
      setCheck(r);
      setConfirmPublic(false);
      setCooldownUntil(Date.now() + r.retryAfterSeconds * 1000);
    } catch (e) {
      setCheck(null);
      setIgError((e as Error).message);
      const retry = e instanceof ApiError ? Number(e.data.retryAfterSeconds) : NaN;
      if (retry > 0) setCooldownUntil(Date.now() + retry * 1000);
    } finally {
      setChecking(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/swaps/${swapId}/membership`, {
        method: 'PUT',
        body: { address, instagramPublicConfirmed: current?.result !== 'public' ? confirmPublic : undefined },
      });
      navigate(`/swaps/${swapId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <p>
      <Link to={`/swaps/${swapId}`}>← Back to the swap</Link>
    </p>
  );
  if (!data) {
    return (
      <main className="stack wide">
        {back}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
    );
  }
  if (data.signUpStatus !== 'open') {
    return (
      <main className="stack wide">
        {back}
        <h1>{data.swap.title}</h1>
        <p>Sign-up for this swap is not open.</p>
      </main>
    );
  }

  const regions = address.country === 'US' ? US_STATES : address.country === 'CA' ? CA_PROVINCES : null;
  const checkLabel = checking
    ? 'Checking…'
    : waitSeconds > 0
      ? `Try again in ${waitSeconds}s`
      : check && !PASSING.includes(check.result)
        ? 'Try again'
        : 'Check my Instagram';

  return (
    <main className="stack wide">
      {back}
      <h1>Sign up for {data.swap.title}</h1>
      <p>We need a few details before you can join. We'll keep them for your next swap.</p>
      <form className="stack" onSubmit={submit}>
        <fieldset className="stack">
          <legend>Email</legend>
          <p>
            We'll email you at <strong>{email}</strong>.
          </p>
        </fieldset>

        <fieldset className="stack">
          <legend>Mailing address</legend>
          <p className="muted small">Where your swap partner will mail your package.</p>
          <div>
            <label htmlFor="country">Country</label>
            <select id="country" value={address.country} onChange={(e) => set('country')(e.target.value)}>
              {COUNTRIES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="name">Name on the package</label>
            <input id="name" required maxLength={200} autoComplete="name" value={address.name} onChange={(e) => set('name')(e.target.value)} />
          </div>
          <div>
            <label htmlFor="line1">Street address</label>
            <input id="line1" required maxLength={200} autoComplete="address-line1" value={address.line1} onChange={(e) => set('line1')(e.target.value)} />
          </div>
          <div>
            <label htmlFor="line2">Apartment, suite, or unit (if you have one)</label>
            <input id="line2" maxLength={200} autoComplete="address-line2" value={address.line2} onChange={(e) => set('line2')(e.target.value)} />
          </div>
          <div>
            <label htmlFor="city">City</label>
            <input id="city" required maxLength={100} autoComplete="address-level2" value={address.city} onChange={(e) => set('city')(e.target.value)} />
          </div>
          <div>
            <label htmlFor="region">
              {address.country === 'US' ? 'State' : address.country === 'CA' ? 'Province or territory' : 'State, province, or region'}
            </label>
            {regions ? (
              <select id="region" required value={address.region} onChange={(e) => set('region')(e.target.value)}>
                <option value="">Choose one</option>
                {regions.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <input id="region" maxLength={100} autoComplete="address-level1" value={address.region} onChange={(e) => set('region')(e.target.value)} />
            )}
          </div>
          <div>
            <label htmlFor="postalCode">{address.country === 'US' ? 'ZIP code' : 'Postal code'}</label>
            <input
              id="postalCode"
              required={!!regions}
              maxLength={address.country === 'US' ? 10 : 20}
              autoComplete="postal-code"
              inputMode={address.country === 'US' ? 'numeric' : undefined}
              value={address.postalCode}
              onChange={(e) => set('postalCode')(e.target.value)}
            />
          </div>
        </fieldset>

        <fieldset className="stack">
          <legend>Instagram</legend>
          <p className="muted small">
            Your swap partner will look at your Instagram for ideas about what you'd like, so it needs to be a public account.
          </p>
          <div>
            <label htmlFor="instagram">Your Instagram name</label>
            <div className="row">
              <input
                id="instagram"
                maxLength={300}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="yourname"
                value={igInput}
                onChange={(e) => setIgInput(e.target.value)}
              />
              <button
                type="button"
                className="secondary"
                disabled={checking || waitSeconds > 0 || !igInput.trim()}
                onClick={checkInstagram}
              >
                {checkLabel}
              </button>
            </div>
          </div>
          {needsRecheck && !current && <p className="muted">It's been a while, so please check your Instagram again.</p>}
          {igError && (
            <p className="error" role="alert">
              {igError}
            </p>
          )}
          {current && <InstagramResult check={current} confirmPublic={confirmPublic} setConfirmPublic={setConfirmPublic} />}
        </fieldset>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !igOk}>
          {data.membership ? 'Save my details' : 'Join this swap'}
        </button>
        {!igOk && <p className="muted small">Check your Instagram above to finish signing up.</p>}
      </form>
    </main>
  );
}

function InstagramResult({
  check,
  confirmPublic,
  setConfirmPublic,
}: {
  check: Check;
  confirmPublic: boolean;
  setConfirmPublic: (v: boolean) => void;
}) {
  const link = (
    <a href={instagramUrl(check.handle)} target="_blank" rel="noreferrer">
      @{check.handle}
    </a>
  );
  return (
    <>
      {check.changed && (
        <p className="notice" role="status">
          We changed what you typed to <strong>{check.handle}</strong>, which is the name Instagram uses.
        </p>
      )}
      {check.result === 'public' && (
        <p className="notice" role="status">
          ✓ We found {link} and it's public.
        </p>
      )}
      {(check.result === 'not_found' || check.result === 'private') && (
        <div className="warning" role="alert">
          <p>
            <strong>
              {check.result === 'private'
                ? `@${check.handle} is a private account.`
                : `We couldn't find a public Instagram account called @${check.handle}.`}
            </strong>
          </p>
          <ul>
            <li>
              Check the spelling of your Instagram name. In the Instagram app, tap your picture at the bottom right; your
              name is at the top of the screen.
            </li>
            <li>
              Your swap partner will look at your Instagram for inspiration, so your account needs to be public. In
              Instagram, go to Settings, then Account privacy, and turn off Private account.
            </li>
          </ul>
          <p>When you've fixed it, press Try again.</p>
        </div>
      )}
      {(check.result === 'exists' || check.result === 'unknown') && (
        <div className="warning" role="status">
          <p>
            We couldn't confirm that {link} is public. Please open it to make sure it's the right account and that
            your account isn't set to private.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={confirmPublic} onChange={(e) => setConfirmPublic(e.target.checked)} />
            I've checked that my Instagram account is public
          </label>
        </div>
      )}
    </>
  );
}
