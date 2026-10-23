import { expect, test } from '@playwright/test';
import { adminUser, checkInstagram, createSwap, getJson, newUser, runId, US_ADDRESS, uniqueHandle, type User } from '../helpers/api';

// What's saved per person (UserProfiles and InstagramChecks): the profile shared by every swap,
// and the Instagram check rate limits. The sign-up page is in swap-signup.spec.ts.

// Compose sets INSTAGRAM_CHECK_MIN_SECONDS to 2; 15 checks an hour is fixed.
const MIN_GAP_MS = 2_100;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (u: User, input: string) => u.api.post('/api/me/instagram/check', { data: { input } });
const profile = async (u: User) => getJson(u.api, '/api/me/profile');

let admin: User;
const run = runId();

test.beforeAll(async () => {
  admin = await adminUser();
});

test.afterAll(async () => {
  await admin.api.dispose();
});

test('a new person has an empty profile; a passing check saves the cleaned-up handle', async () => {
  const user = await newUser('profile-new');
  expect(await profile(user)).toEqual({ email: user.email, address: null, instagram: null });

  const handle = uniqueHandle('jo');
  const res = await check(user, `https://instagram.com/${handle.toUpperCase()}/`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({
    input: `https://instagram.com/${handle.toUpperCase()}/`,
    handle,
    changed: true,
    result: 'public',
    retryAfterSeconds: 2,
  });
  const saved = await profile(user);
  expect(saved.address).toBeNull();
  expect(saved.instagram).toEqual({ handle, result: 'public', checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/), current: true });
  await user.api.dispose();
});

test('checks must be a couple of seconds apart, and a name that is not valid is not counted', async () => {
  const user = await newUser('profile-gap');
  await checkInstagram(user.api);

  const tooSoon = await check(user, uniqueHandle());
  expect(tooSoon.status()).toBe(429);
  const body = await tooSoon.json();
  expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  expect(body.retryAfterSeconds).toBeLessThanOrEqual(2);
  expect(tooSoon.headers()['retry-after']).toBe(String(body.retryAfterSeconds));
  // An invalid name is refused before the rate limit, and doesn't use up a check.
  expect((await check(user, 'not a handle!')).status()).toBe(400);

  await wait(MIN_GAP_MS);
  const handle = uniqueHandle('later');
  expect((await check(user, handle)).status()).toBe(200);
  // The refused check didn't change what's saved.
  expect((await profile(user)).instagram.handle).toBe(handle);
  await user.api.dispose();
});

test('each result is saved: a failed check clears the handle but keeps the address', async () => {
  const user = await newUser('profile-results');
  const swapId = await createSwap(admin.api, `Profile results ${run}`);
  await checkInstagram(user.api);
  expect((await user.api.put(`/api/swaps/${swapId}/membership`, { data: { address: US_ADDRESS } })).status()).toBe(200);

  const results: [string, { handle: string; result: string } | null][] = [];
  for (const prefix of ['exists', 'unknown', 'private', 'public', 'nosuch']) {
    await wait(MIN_GAP_MS);
    const handle = uniqueHandle(prefix);
    const res = await check(user, handle);
    expect(res.status()).toBe(200);
    expect((await res.json()).result).toBe(prefix === 'public' ? 'public' : prefix === 'nosuch' ? 'not_found' : prefix);
    const { instagram, address } = await profile(user);
    expect(address).toEqual(US_ADDRESS);
    results.push([prefix, instagram && { handle: instagram.handle === handle ? 'same' : instagram.handle, result: instagram.result }]);
  }
  expect(results).toEqual([
    ['exists', { handle: 'same', result: 'exists' }],
    ['unknown', { handle: 'same', result: 'unknown' }],
    ['private', null],
    ['public', { handle: 'same', result: 'public' }],
    ['nosuch', null],
  ]);
  // The manager sees the handle cleared too.
  const { member } = await getJson(admin.api, `/api/swaps/${swapId}/members/${user.userId}`);
  expect([member.instagramHandle, member.instagramConfirmed]).toEqual([null, false]);
  await user.api.dispose();
});

test('one profile is shared by every swap: it prefills the next sign-up, and changing it changes it everywhere', async () => {
  const user = await newUser('profile-shared');
  const first = await createSwap(admin.api, `Profile first ${run}`);
  const second = await createSwap(admin.api, `Profile second ${run}`);
  const handle = await checkInstagram(user.api, uniqueHandle('shared'));
  const home = { ...US_ADDRESS, name: `Shared ${run}`, line2: 'Unit 1' };
  expect((await user.api.put(`/api/swaps/${first}/membership`, { data: { address: home } })).status()).toBe(200);

  // The sign-up page for the next swap gets everything back, and joining needs no new check.
  const saved = await profile(user);
  expect(saved).toEqual({
    email: user.email,
    address: home,
    instagram: { handle, result: 'public', checkedAt: expect.any(String), current: true },
  });
  expect((await user.api.put(`/api/swaps/${second}/membership`, { data: { address: saved.address } })).status()).toBe(200);

  // A new address given when joining (or re-joining) one swap is what every swap's manager sees.
  const moved = { name: `Moved ${run}`, line1: '2 Rue Neuve', line2: '', city: 'Paris', region: '', postalCode: '75001', country: 'FR' };
  expect((await user.api.put(`/api/swaps/${second}/membership`, { data: { address: moved } })).status()).toBe(200);
  for (const swapId of [first, second]) {
    const { member } = await getJson(admin.api, `/api/swaps/${swapId}/members/${user.userId}`);
    expect(member.address, swapId).toEqual(moved);
    expect(member.name).toBe(`Moved ${run}`);
    expect(member.instagramHandle).toBe(handle);
  }
  expect((await getJson(admin.api, `/api/swaps/${first}/members?country=FR`)).total).toBe(1);
  await user.api.dispose();
});

test('at most 15 checks an hour, passing or not', async () => {
  test.setTimeout(120_000);
  const user = await newUser('profile-hourly');
  for (let i = 0; i < 15; i++) {
    if (i) await wait(MIN_GAP_MS);
    const res = await check(user, uniqueHandle(i % 3 === 0 ? 'nosuch' : 'hourly'));
    expect(res.status(), `check ${i + 1}`).toBe(200);
  }
  await wait(MIN_GAP_MS);
  const limited = await check(user, uniqueHandle('hourly'));
  expect(limited.status()).toBe(429);
  const { retryAfterSeconds } = await limited.json();
  // About an hour from the first check.
  expect(retryAfterSeconds).toBeGreaterThan(3500);
  expect(retryAfterSeconds).toBeLessThanOrEqual(3600);
  // Someone else isn't affected.
  const other = await newUser('profile-hourly-other');
  expect((await check(other, uniqueHandle())).status()).toBe(200);
  await Promise.all([user.api.dispose(), other.api.dispose()]);
});
