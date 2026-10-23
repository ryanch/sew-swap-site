import { expect, test } from '@playwright/test';
import {
  adminUser,
  assign,
  createSwap,
  day,
  getJson,
  join,
  newMember,
  newUser,
  runId,
  US_ADDRESS,
  type User,
} from '../helpers/api';

// What the swap lists and swap pages read back from the database: order, counts, status, and
// what joining, re-joining and leaving store. The UI flows are in swaps.spec.ts.

test.describe.configure({ mode: 'serial' });

let admin: User;
let mgr: User;
let plain: User;
const run = runId();
const opened: string[] = [];

type ListedSwap = { swapId: string; title: string; signUpOpens: string; swapperCount?: number };
const listed = async (u: User, path = '/api/swaps') => (await getJson(u.api, path)).swaps as ListedSwap[];
/** Only the swaps this file made, in the order the API gave them. */
const ours = (swaps: ListedSwap[], swapIds: string[]) => swaps.filter((s) => swapIds.includes(s.swapId));

test.beforeAll(async () => {
  admin = await adminUser();
  mgr = await newUser('swapdata-mgr');
  plain = await newUser('swapdata-plain');
  expect((await admin.api.put(`/api/admin/users/${mgr.userId}/roles/swap_manager`, { data: {} })).status()).toBe(200);
});

test.afterAll(async () => {
  await Promise.all([admin.api.dispose(), mgr.api.dispose(), plain.api.dispose()]);
});

test('swaps are listed newest sign-up first, then by title', async () => {
  // Far-future dates so they sort above everything else, whatever other runs left behind.
  const far = (opens: string) => ({ signUpOpens: opens, signUpCloses: '2999-12-31', partnersAnnounced: '2999-12-31', makingDeadline: '2999-12-31', shipBy: '2999-12-31' });
  const b = await createSwap(mgr.api, `B order ${run}`, far('2998-06-01'));
  const c = await createSwap(mgr.api, `C order ${run}`, far('2997-06-01'));
  const a = await createSwap(mgr.api, `A order ${run}`, far('2998-06-01'));
  opened.push(a, b, c);

  const expected = [`A order ${run}`, `B order ${run}`, `C order ${run}`];
  for (const [who, path] of [[plain, '/api/swaps'], [mgr, '/api/swaps'], [mgr, '/api/swaps/mine'], [admin, '/api/swaps/mine']] as const) {
    expect(ours(await listed(who, path), opened).map((s) => s.title), `${who.email} ${path}`).toEqual(expected);
  }
  // The whole list is in that order too.
  const all = await listed(plain);
  const sorted = [...all].sort((x, y) => (x.signUpOpens === y.signUpOpens ? (x.title < y.title ? -1 : x.title > y.title ? 1 : 0) : x.signUpOpens < y.signUpOpens ? 1 : -1));
  expect(all.map((s) => s.swapId)).toEqual(sorted.map((s) => s.swapId));

  // Dates come back as YYYY-MM-DD.
  const detail = await getJson(plain.api, `/api/swaps/${a}`);
  expect(detail.swap).toMatchObject({ swapId: a, signUpOpens: '2998-06-01', shipBy: '2999-12-31', makersPublishedAt: null });
});

test("a manager's list shows only their swaps, with how many have joined", async () => {
  const other = await newUser('swapdata-other');
  await admin.api.put(`/api/admin/users/${other.userId}/roles/swap_manager`, { data: {} });
  const theirs = await createSwap(other.api, `Theirs ${run}`, { signUpOpens: day(-1) });
  const mine = await createSwap(mgr.api, `Mine ${run}`);

  // Two people join; the manager's own row isn't counted.
  await join(plain, mine, US_ADDRESS);
  const second = await newMember('swapdata-second', mine, US_ADDRESS);

  expect(ours(await listed(mgr, '/api/swaps/mine'), [theirs, mine]).map((s) => s.swapId)).toEqual([mine]);
  const count = async (u: User, path: string, swapId: string) => (await listed(u, path)).find((s) => s.swapId === swapId)?.swapperCount;
  expect(await count(mgr, '/api/swaps', mine)).toBe(2);
  expect(await count(mgr, '/api/swaps/mine', mine)).toBe(2);
  expect(await count(admin, '/api/swaps', mine)).toBe(2);
  // Only managers see the count.
  expect(await count(mgr, '/api/swaps', theirs)).toBeUndefined();
  expect(await count(plain, '/api/swaps', mine)).toBeUndefined();
  expect(await count(other, '/api/swaps', theirs)).toBe(0);
  // Regular users can't ask for "mine".
  expect((await plain.api.get('/api/swaps/mine')).status()).toBe(403);

  // Leaving lowers the count.
  expect((await second.api.delete(`/api/swaps/${mine}/membership`)).status()).toBe(204);
  expect(await count(mgr, '/api/swaps', mine)).toBe(1);
  await Promise.all([other.api.dispose(), second.api.dispose()]);
});

test('/api/me/swaps lists joined and owned swaps separately, in list order', async () => {
  const user = await newUser('swapdata-mine');
  await admin.api.put(`/api/admin/users/${user.userId}/roles/swap_manager`, { data: {} });
  expect(await getJson(user.api, '/api/me/swaps')).toEqual({ joined: [], owned: [] });

  const later = await createSwap(mgr.api, `Z joined ${run}`, { signUpOpens: day(-1) });
  const earlier = await createSwap(mgr.api, `A joined ${run}`, { signUpOpens: day(-3) });
  const sameDay = await createSwap(mgr.api, `B joined ${run}`, { signUpOpens: day(-3) });
  const owned = await createSwap(user.api, `Owned ${run}`);
  await join(user, earlier, US_ADDRESS);
  await join(user, later, US_ADDRESS, { checked: true });
  await join(user, sameDay, US_ADDRESS, { checked: true });

  const mine = await getJson(user.api, '/api/me/swaps');
  expect(mine.joined.map((s: ListedSwap) => s.swapId)).toEqual([later, earlier, sameDay]);
  expect(mine.owned.map((s: ListedSwap) => s.swapId)).toEqual([owned]);
  // Joining their own swap puts it in both lists.
  await join(user, owned, US_ADDRESS, { checked: true });
  const both = await getJson(user.api, '/api/me/swaps');
  expect(both.joined.map((s: ListedSwap) => s.swapId)).toContain(owned);
  expect(both.owned.map((s: ListedSwap) => s.swapId)).toEqual([owned]);
  // Leaving takes it out of joined only.
  await user.api.delete(`/api/swaps/${owned}/membership`);
  const left = await getJson(user.api, '/api/me/swaps');
  expect(left.joined.map((s: ListedSwap) => s.swapId)).toEqual([later, earlier, sameDay]);
  expect(left.owned.map((s: ListedSwap) => s.swapId)).toEqual([owned]);
  await user.api.dispose();
});

type StatusCase = [label: string, opens: number, closes: number, status: string, joinStatus: number];

/** Creates a swap for each case and checks its status and whether a complete, valid join gets in. */
async function checkStatuses(cases: StatusCase[]) {
  for (const [label, opens, closes, status, joinStatus] of cases) {
    const swapId = await createSwap(mgr.api, `Status ${label} ${run}`, { signUpOpens: day(opens), signUpCloses: day(closes) });
    expect((await getJson(plain.api, `/api/swaps/${swapId}`)).signUpStatus, label).toBe(status);
    const res = await plain.api.put(`/api/swaps/${swapId}/membership`, { data: { address: US_ADDRESS } });
    expect(res.status(), label).toBe(joinStatus);
    expect((await getJson(plain.api, `/api/swaps/${swapId}`)).membership === null, label).toBe(joinStatus !== 200);
  }
}

test('sign-up status is upcoming, open or closed, and only open swaps can be joined', async () => {
  await checkStatuses([
    ['upcoming', 2, 5, 'upcoming', 403],
    ['open', -2, 2, 'open', 200],
    ['closed', -5, -2, 'closed', 403],
  ]);
  // Editing the dates opens a swap that was closed.
  const swapId = await createSwap(mgr.api, `Reopened ${run}`, { signUpOpens: day(-5), signUpCloses: day(-2) });
  const body = { title: `Reopened ${run}`, description: '', signUpOpens: day(-5), signUpCloses: day(2), partnersAnnounced: day(7), makingDeadline: day(30), shipBy: day(35) };
  expect((await mgr.api.put(`/api/swaps/${swapId}`, { data: body })).status()).toBe(200);
  expect((await getJson(plain.api, `/api/swaps/${swapId}`)).signUpStatus).toBe('open');
  expect((await getJson(plain.api, `/api/swaps/${swapId}`)).swap).toMatchObject({ signUpCloses: day(2), description: '' });
  expect((await plain.api.get('/api/swaps/00000000-0000-0000-0000-000000000000')).status()).toBe(404);
});

test('sign-up opens and closes on UTC days, both end days included', async () => {
  // Suspected app bug: Spanner's CURRENT_DATE() uses America/Los_Angeles unless given a time zone,
  // not UTC as CLAUDE.md says. Between midnight UTC and midnight in Los Angeles, a swap opening
  // "today" (UTC) is still upcoming and one that closed "yesterday" is still open.
  const utcDay = new Date().toISOString().slice(0, 10);
  const laDay = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  test.fixme(utcDay !== laDay, `UTC (${utcDay}) and Los Angeles (${laDay}) are on different days; the API uses Los Angeles`);
  await checkStatuses([
    ['opens tomorrow', 1, 5, 'upcoming', 403],
    ['opens today', 0, 3, 'open', 200],
    ['closes today', -3, 0, 'open', 200],
    ['one day', 0, 0, 'open', 200],
    ['closed yesterday', -5, -1, 'closed', 403],
  ]);
});

test('joining again updates the address and keeps one membership', async () => {
  const swapId = await createSwap(mgr.api, `Rejoin ${run}`);
  const user = await newMember('swapdata-rejoin', swapId, { ...US_ADDRESS, name: `Rejoin ${run}` });
  const first = await getJson(admin.api, `/api/swaps/${swapId}/members/${user.userId}`);
  const joinedAt = (await getJson(user.api, `/api/swaps/${swapId}`)).membership.joinedAt;
  expect(joinedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(first.member.joinedAt).toBe(joinedAt);

  const moved = { name: `Moved ${run}`, line1: '9 Elm St', line2: 'Apt 4', city: 'Portland', region: 'or', postalCode: '97201', country: 'us' };
  expect((await user.api.put(`/api/swaps/${swapId}/membership`, { data: { address: moved } })).status()).toBe(200);

  const list = await getJson(admin.api, `/api/swaps/${swapId}/members`);
  expect(list.total).toBe(1);
  expect(list.members.map((m: { userId: string }) => m.userId)).toEqual([user.userId]);
  const { member } = await getJson(admin.api, `/api/swaps/${swapId}/members/${user.userId}`);
  // Region and country are stored upper case; the name shown is the new name on the package.
  expect(member.address).toEqual({ ...moved, region: 'OR', country: 'US' });
  expect(member).toMatchObject({ name: `Moved ${run}`, city: 'Portland', region: 'OR', country: 'US', joinedAt });
  // The profile has it too, ready for the next swap.
  expect((await getJson(user.api, '/api/me/profile')).address).toEqual({ ...moved, region: 'OR', country: 'US' });
  await user.api.dispose();
});

test('leaving removes their pairings both ways, and only in that swap', async () => {
  const swapId = await createSwap(mgr.api, `Leave ${run}`);
  const otherSwap = await createSwap(mgr.api, `Leave other ${run}`);
  const [a, b, c] = [
    await newMember('swapdata-a', swapId, { ...US_ADDRESS, name: `A ${run}` }),
    await newMember('swapdata-b', swapId, { ...US_ADDRESS, name: `B ${run}` }),
    await newMember('swapdata-c', swapId, { ...US_ADDRESS, name: `C ${run}` }),
  ];
  for (const u of [a, b]) await join(u, otherSwap, US_ADDRESS, { checked: true });
  // A makes for B, B for C and A, C for A; in the other swap B makes for A.
  for (const [m, r] of [[a, b], [b, c], [b, a], [c, a]]) expect((await assign(mgr.api, swapId, m.userId, r.userId)).status()).toBe(200);
  expect((await assign(mgr.api, otherSwap, b.userId, a.userId)).status()).toBe(200);

  expect((await b.api.delete(`/api/swaps/${swapId}/membership`)).status()).toBe(204);

  const member = async (sid: string, u: User) => (await getJson(mgr.api, `/api/swaps/${sid}/members/${u.userId}`)).member;
  const pairs = async (sid: string, u: User) => {
    const m = await member(sid, u);
    return [m.makingFor.map((p: { userId: string }) => p.userId), m.madeBy.map((p: { userId: string }) => p.userId)];
  };
  expect(await pairs(swapId, a)).toEqual([[], [c.userId]]);
  expect(await pairs(swapId, c)).toEqual([[a.userId], []]);
  expect((await mgr.api.get(`/api/swaps/${swapId}/members/${b.userId}`)).status()).toBe(404);
  expect(await pairs(otherSwap, a)).toEqual([[], [b.userId]]);
  expect(await pairs(otherSwap, b)).toEqual([[a.userId], []]);

  // Coming back starts with no pairings.
  await join(b, swapId, US_ADDRESS, { checked: true });
  expect(await pairs(swapId, b)).toEqual([[], []]);
  for (const u of [a, b, c]) await u.api.dispose();
});
