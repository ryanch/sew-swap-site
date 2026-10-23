import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { CA_PROVINCES, COUNTRIES, EMPTY_ADDRESS, US_STATES, type Address } from '../swaps/address';
import { instagramUrl, type SignUpStatus, type Swap } from '../swaps/swaps';

type IgResult = 'public' | 'private' | 'not_found' | 'exists' | 'unknown' | 'needs_handle';
/** A check of a post link. `typed` is true when the person also typed their name because Instagram wouldn't show us the post. */
type Check = { input: string; handle: string | null; result: IgResult; typed: boolean };
type Profile = {
  email: string;
  address: Address | null;
  instagram: { handle: string; postUrl: string | null; result: IgResult; current: boolean } | null;
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
  const [handleInput, setHandleInput] = useState('');
  const [askHandle, setAskHandle] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
          const { handle, postUrl, result, current } = profile.instagram;
          // Profiles from before post links have only a name, so they need a new check with a link.
          if (postUrl && current) {
            const typed = result !== 'public';
            setIgInput(postUrl);
            setCheck({ input: postUrl, handle, result, typed });
            if (typed) {
              setAskHandle(true);
              setHandleInput(handle);
            }
          } else {
            if (postUrl) setIgInput(postUrl);
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

  // A result only counts for the link (and typed name) it was about; changing either needs a new check.
  const current =
    check && check.input === igInput.trim() && (!check.typed || check.handle === handleInput.trim()) ? check : null;
  const igOk = !!current && PASSING.includes(current.result) && (current.result === 'public' || confirmPublic);

  async function checkInstagram() {
    setChecking(true);
    setIgError('');
    setNeedsRecheck(false);
    const input = igInput.trim();
    const typed = askHandle && !!handleInput.trim();
    try {
      const r = await api<{ handle: string | null; result: IgResult; retryAfterSeconds: number }>('/api/me/instagram/check', {
        method: 'POST',
        body: typed ? { input, handle: handleInput } : { input },
      });
      setIgInput(input);
      if (typed && r.handle) setHandleInput(r.handle);
      setCheck({ input, handle: r.handle, result: r.result, typed });
      if (r.result === 'needs_handle') setAskHandle(true);
      if (r.result === 'not_found') setHelpOpen(true);
      setConfirmPublic(false);
      setCooldownUntil(Date.now() + r.retryAfterSeconds * 1000);
    } catch (e) {
      setCheck(null);
      setIgError((e as Error).message);
      if (e instanceof ApiError && e.status === 400) setHelpOpen(true);
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
      : check && !PASSING.includes(check.result) && check.result !== 'needs_handle'
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
            <label htmlFor="firstName">First name</label>
            <input id="firstName" required maxLength={100} autoComplete="given-name" value={address.firstName} onChange={(e) => set('firstName')(e.target.value)} />
          </div>
          <div>
            <label htmlFor="lastName">Last name</label>
            <input id="lastName" required maxLength={100} autoComplete="family-name" value={address.lastName} onChange={(e) => set('lastName')(e.target.value)} />
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
            Your swap partner will look at your Instagram for ideas about what you'd like, so it needs to be a public
            account. To show us which account is yours, paste a link to any one of your posts.
          </p>
          <div>
            <label htmlFor="instagramPost">A link to one of your Instagram posts</label>
            <button
              type="button"
              className="link-button"
              aria-expanded={helpOpen}
              aria-controls="instagram-help"
              onClick={() => setHelpOpen((open) => !open)}
            >
              {helpOpen ? 'Hide help' : 'How do I copy a post link?'}
            </button>
            {helpOpen && <InstagramHelp onClose={() => setHelpOpen(false)} />}
            <div className="row wrap">
              <input
                id="instagramPost"
                inputMode="url"
                maxLength={300}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://www.instagram.com/p/…"
                value={igInput}
                onChange={(e) => setIgInput(e.target.value)}
              />
              <button
                type="button"
                className="secondary"
                disabled={checking || waitSeconds > 0 || !igInput.trim() || (askHandle && !handleInput.trim())}
                onClick={checkInstagram}
              >
                {checkLabel}
              </button>
            </div>
          </div>
          {askHandle && (
            <div>
              <label htmlFor="instagramName">Your Instagram name</label>
              <p className="muted small">
                Instagram isn't letting us look at posts right now, so please type your Instagram name too, then press
                Check my Instagram.
              </p>
              <input
                id="instagramName"
                maxLength={300}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="yourname"
                value={handleInput}
                onChange={(e) => setHandleInput(e.target.value)}
              />
            </div>
          )}
          {needsRecheck && !current && <p className="muted">It's been a while, so please check your Instagram again.</p>}
          {igError && (
            <p className="error" role="alert">
              {igError}
            </p>
          )}
          {current && (
            <InstagramResult
              check={current}
              confirmPublic={confirmPublic}
              setConfirmPublic={setConfirmPublic}
              showHelp={() => setHelpOpen(true)}
            />
          )}
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

/** Step-by-step directions for copying a post link, on a phone and on a computer. */
function InstagramHelp({ onClose }: { onClose: () => void }) {
  return (
    <div id="instagram-help" className="help-panel" role="region" aria-label="How to copy a post link">
      <h3>On a phone, in the Instagram app</h3>
      <ol>
        <li>Open Instagram and tap your picture at the bottom right.</li>
        <li>Tap any one of your posts.</li>
        <li>
          Tap the <strong>paper airplane</strong> (Share) button under the photo.
        </li>
        <li>
          In the row of options that appears, tap <strong>Copy link</strong>. You may need to slide the row to find it.
        </li>
        <li>
          Come back to this page. Press and hold in the box below, then tap <strong>Paste</strong>.
        </li>
      </ol>
      <h3>On a computer</h3>
      <ol>
        <li>Go to instagram.com and click your picture to open your profile.</li>
        <li>Click any one of your posts.</li>
        <li>
          Click the <strong>paper airplane</strong> or the <strong>⋯</strong> button, then <strong>Copy link</strong>.
          Or copy the address at the top of the browser.
        </li>
        <li>
          Click in the box below and paste: press <strong>Ctrl+V</strong>, or <strong>⌘+V</strong> on a Mac.
        </li>
      </ol>
      <p>The link will look like this: https://www.instagram.com/p/ABC123xyz/</p>
      <ul>
        <li>Any post from your own account works, including a reel.</li>
        <li>
          Your account needs to be public. In Instagram, go to Settings, then Account privacy, and turn off Private
          account.
        </li>
      </ul>
      <button type="button" className="secondary" onClick={onClose}>
        Close help
      </button>
    </div>
  );
}

function InstagramResult({
  check,
  confirmPublic,
  setConfirmPublic,
  showHelp,
}: {
  check: Check;
  confirmPublic: boolean;
  setConfirmPublic: (v: boolean) => void;
  showHelp: () => void;
}) {
  const link = check.handle && (
    <a href={instagramUrl(check.handle)} target="_blank" rel="noreferrer">
      @{check.handle}
    </a>
  );
  return (
    <>
      {check.result === 'public' && (
        <p className="notice" role="status">
          ✓ This post belongs to {link}, and the account is public. Not you? Paste a link to one of your own posts.
        </p>
      )}
      {check.result === 'needs_handle' && (
        <p className="warning" role="status">
          Instagram isn't answering right now. Please type your Instagram name below the link.
        </p>
      )}
      {(check.result === 'not_found' || check.result === 'private') && (
        <div className="warning" role="alert">
          <p>
            <strong>
              {check.typed && check.result === 'private'
                ? `@${check.handle} is a private account.`
                : check.typed
                  ? `We couldn't find a public Instagram account called @${check.handle}.`
                  : "We couldn't open that post."}
            </strong>
          </p>
          <ul>
            {check.typed ? (
              <li>
                Check the spelling of your Instagram name. In the Instagram app, tap your picture at the bottom right;
                your name is at the top of the screen.
              </li>
            ) : (
              <li>
                Copy the link again, the whole thing, from one of your own posts.{' '}
                <button type="button" className="link-button" onClick={showHelp}>
                  Show me how
                </button>
              </li>
            )}
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
