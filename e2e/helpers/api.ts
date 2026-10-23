import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, request, type APIRequestContext } from '@playwright/test';
import { listEmailIds, uniqueEmail, waitForLoginEmail } from './mailpit';
import { uniqueHandle, US_ADDRESS } from './signup';

// Helpers for the data-*.spec.ts tests, which drive the API directly (no browser pages) so they
// stay fast and check what the database keeps.

export const ADMIN_EMAIL = 'admin@example.test';
export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';

export type Address = typeof US_ADDRESS;

/** A signed-in person: their own cookie jar, email and user id. */
export type User = { api: APIRequestContext; email: string; userId: string };

/** YYYY-MM-DD, `days` from today in UTC (the API compares against CURRENT_DATE() in UTC). */
export const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** A short id for this run, to keep names unique across runs (the emulator keeps data between them). */
export const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Asks for a sign-in email and returns its code (and link token). */
export async function requestCode(api: APIRequestContext, email: string) {
  const to = email.trim().toLowerCase();
  const excludeIds = await listEmailIds(to);
  const res = await api.post('/api/auth/email/request', { data: { email } });
  expect(res.status(), `sign-in request for ${email}`).toBe(200);
  return waitForLoginEmail(to, { excludeIds });
}

/** Signs in with the 6-digit code. The session cookie stays in `api`. */
export async function signInWithCode(api: APIRequestContext, email: string) {
  const mail = await requestCode(api, email);
  const res = await api.post('/api/auth/email/verify-code', { data: { email, code: mail.code } });
  expect(res.status(), `sign-in for ${email}`).toBe(200);
  return (await res.json()) as { user: { userId: string; email: string; roles: string[] }; isNewUser: boolean };
}

export const newContext = () => request.newContext({ baseURL: BASE_URL });

/** A brand-new user, signed in through the API. */
export async function newUser(prefix: string): Promise<User> {
  const email = uniqueEmail(prefix);
  const api = await newContext();
  const { user } = await signInWithCode(api, email);
  return { api, email, userId: user.userId };
}

// The admin's sign-in emails are rate limited, so the data-*.spec.ts files share one session per run.
const ADMIN_STATE = path.join(tmpdir(), 'sew-swap-e2e-admin-state.json');

export async function adminUser(): Promise<User> {
  if (existsSync(ADMIN_STATE)) {
    const api = await request.newContext({ baseURL: BASE_URL, storageState: ADMIN_STATE });
    const me = await api.get('/api/auth/me');
    if (me.ok()) return { api, email: ADMIN_EMAIL, userId: (await me.json()).user.userId };
    await api.dispose();
  }
  const api = await newContext();
  const { user } = await signInWithCode(api, ADMIN_EMAIL);
  writeFileSync(ADMIN_STATE, JSON.stringify(await api.storageState()));
  return { api, email: ADMIN_EMAIL, userId: user.userId };
}

/** The session cookie's value, to check it stops working after logging out. */
export async function sessionCookie(api: APIRequestContext) {
  return (await api.storageState()).cookies.find((c) => c.name === 'sid')?.value;
}

export type SwapDates = {
  signUpOpens: string;
  signUpCloses: string;
  partnersAnnounced: string;
  makingDeadline: string;
  shipBy: string;
};

/** Sign-up open from yesterday to five days from now. */
export const openDates = (): SwapDates => ({
  signUpOpens: day(-1),
  signUpCloses: day(5),
  partnersAnnounced: day(7),
  makingDeadline: day(30),
  shipBy: day(35),
});

export async function createSwap(api: APIRequestContext, title: string, dates: Partial<SwapDates> = {}) {
  const res = await api.post('/api/swaps', {
    data: { title, description: 'Made by the data tests.', ...openDates(), ...dates },
  });
  expect(res.status(), `create swap ${title}`).toBe(201);
  return (await res.json()).swap.swapId as string;
}

/** Passes the (fake) Instagram check with a public handle. Returns the handle. */
export async function checkInstagram(api: APIRequestContext, handle = uniqueHandle()) {
  const res = await api.post('/api/me/instagram/check', { data: { input: handle } });
  expect(res.status(), `Instagram check for ${handle}`).toBe(200);
  return handle;
}

/** Joins with `address`. Checks Instagram first unless `checked`. */
export async function join(user: User, swapId: string, address: Address, opts: { handle?: string; checked?: boolean } = {}) {
  if (!opts.checked) await checkInstagram(user.api, opts.handle);
  const res = await user.api.put(`/api/swaps/${swapId}/membership`, { data: { address } });
  expect(res.status(), `${user.email} joins ${swapId}`).toBe(200);
}

/** A valid public handle (the fake strategy says public) starting with `prefix`'s letters. */
export const handleFor = (prefix: string) => uniqueHandle(prefix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18));

/** A new user who has joined `swapId`, with a handle and a name on their address. */
export async function newMember(prefix: string, swapId: string, address: Address, handle = handleFor(prefix)) {
  const user = await newUser(prefix);
  await join(user, swapId, address, { handle });
  return { ...user, handle, name: address.name };
}

export const assign = (api: APIRequestContext, swapId: string, makerId: string, recipientId: string) =>
  api.put(`/api/swaps/${swapId}/assignments/${makerId}/${recipientId}`, { data: {} });

export const ALL_TICKED = { seenInstagram: true, reviewedAddress: true, canShip: true };

export async function getJson(api: APIRequestContext, path: string) {
  const res = await api.get(path);
  expect(res.status(), `GET ${path}`).toBe(200);
  return res.json();
}

export const ids = (list: { userId: string }[]) => list.map((m) => m.userId).sort();

/** Parses the export CSV: CRLF rows, quoted cells with "" for a quote, and a byte-order mark. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

export { US_ADDRESS, uniqueHandle };
