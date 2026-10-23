import { expect, test } from '@playwright/test';
import { adminUser, ALL_TICKED, assign, createSwap, day, getJson, join, newMember, runId, US_ADDRESS, type User } from '../helpers/api';

// Publishing, confirming, shipping and the email log, as stored. Across three swaps so the
// per-swap and per-person queries are tested: two published, one not.
// The pages and most single-swap flows are in publish.spec.ts and shipping.spec.ts.

test.describe.configure({ mode: 'serial' });

type Person = User & { handle: string; name: string };

let admin: User;
let late: string; // ships last, published first
let early: string; // ships first, published second
let unpublished: string;
const run = runId();
let maker: Person;
let zed: Person;
let abe: Person;
let cy: Person;

const UPS_NUMBER = '1Z999AA10123456784';
const USPS_NUMBER = '9400100000000000000000';

// Times are shown to the second, so the tests wait a second between emails whose dates they compare.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

const summary = async (swapId: string) => getJson(admin.api, `/api/swaps/${swapId}/publish`);
const publish = (swapId: string) => admin.api.post(`/api/swaps/${swapId}/publish`, { data: { confirm: true } });
const confirm = (from: User, swapId: string, to: User) =>
  from.api.post(`/api/swaps/${swapId}/makes/${to.userId}/confirm`, { data: ALL_TICKED });
const ship = (from: User, swapId: string, to: User, carrier: string, trackingNumber: string) =>
  from.api.post(`/api/swaps/${swapId}/makes/${to.userId}/ship`, { data: { carrier, trackingNumber } });
const remind = (swapId: string, users: User[], kind?: 'confirm' | 'ship') =>
  admin.api.post(`/api/swaps/${swapId}/reminders`, { data: { userIds: users.map((u) => u.userId), ...(kind ? { kind } : {}) } });
const member = async (swapId: string, u: User) => (await getJson(admin.api, `/api/swaps/${swapId}/members/${u.userId}`)).member;
type LoggedEmail = { emailId: string; sentAt: string; kind: string; swapId: string | null; subject: string; body: string };
const emails = async (u: User) => (await getJson(u.api, '/api/me/emails')).emails as LoggedEmail[];

test.beforeAll(async () => {
  admin = await adminUser();
  late = await createSwap(admin.api, `Makes late ${run}`, { shipBy: day(40) });
  early = await createSwap(admin.api, `Makes early ${run}`, { shipBy: day(35) });
  unpublished = await createSwap(admin.api, `Makes unpublished ${run}`, { shipBy: day(30) });

  const person = (name: string) => ({ ...US_ADDRESS, name: `${name} ${run}` });
  maker = await newMember('makesmaker', late, person('Maker'));
  zed = await newMember('makeszed', late, { ...person('Zed'), line2: 'Apt 9' });
  abe = await newMember('makesabe', late, person('Abe'));
  cy = await newMember('makescy', early, person('Cy'));
  await join(maker, early, person('Maker'), { checked: true });
  for (const u of [maker, zed]) await join(u, unpublished, u === maker ? person('Maker') : { ...person('Zed'), line2: 'Apt 9' }, { checked: true });

  // Late: Maker makes for Zed and Abe, Abe makes for Maker. Early: Maker and Cy make for each other.
  // Unpublished: Maker makes for Zed.
  for (const [swapId, m, r] of [
    [late, maker, zed],
    [late, maker, abe],
    [late, abe, maker],
    [early, maker, cy],
    [early, cy, maker],
    [unpublished, maker, zed],
  ] as [string, User, User][]) {
    expect((await assign(admin.api, swapId, m.userId, r.userId)).status()).toBe(200);
  }
});

test.afterAll(async () => {
  await Promise.all([admin.api.dispose(), ...[maker, zed, abe, cy].map((u) => u.api.dispose())]);
});

test('the publish summary counts people and pairings, and publishing happens once', async () => {
  expect(await summary(late)).toEqual({
    publishedAt: null,
    partnersAnnounced: day(7),
    participants: 3,
    withoutRecipient: 1, // Zed
    withoutMaker: 0,
    pairings: 3,
    pairingsConfirmed: 0,
    makers: 2,
    makersConfirmed: 0,
    pairingsShipped: 0,
    makersShipped: 0,
  });

  const res = await publish(late);
  expect(res.status()).toBe(200);
  const published = await res.json();
  expect(published).toEqual({ publishedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/), emailed: 2, failed: 0 });

  // Publishing again is refused and changes nothing.
  expect((await publish(late)).status()).toBe(409);
  expect((await summary(late)).publishedAt).toBe(published.publishedAt);
  expect((await getJson(maker.api, `/api/swaps/${late}`)).swap.makersPublishedAt).toBe(published.publishedAt);
  // Other swaps aren't published.
  expect((await summary(early)).publishedAt).toBeNull();
  await nextSecond();
  expect((await publish(early)).status()).toBe(200);
  expect((await summary(unpublished)).publishedAt).toBeNull();
});

test('a maker sees who they make for in every published swap, by ship date, then name', async () => {
  const { makes } = await getJson(maker.api, '/api/me/makes');
  expect(makes.map((m: { swap: { title: string }; recipient: { name: string } }) => [m.swap.title, m.recipient.name])).toEqual([
    [`Makes early ${run}`, `Cy ${run}`],
    [`Makes late ${run}`, `Abe ${run}`],
    [`Makes late ${run}`, `Zed ${run}`],
  ]);
  expect(makes[2]).toEqual({
    swap: { swapId: late, title: `Makes late ${run}`, shipBy: day(40) },
    recipient: {
      userId: zed.userId,
      name: `Zed ${run}`,
      instagramHandle: zed.handle,
      address: { ...US_ADDRESS, name: `Zed ${run}`, line2: 'Apt 9' },
    },
    confirmedAt: null,
    shipped: null,
  });
  // Zed makes for nobody; in the unpublished swap nothing shows or can be confirmed.
  expect((await getJson(zed.api, '/api/me/makes')).makes).toEqual([]);
  expect((await confirm(maker, unpublished, zed)).status()).toBe(404);
});

test('confirming is stored once, and the summary counts makers who confirmed everyone', async () => {
  expect(await (await confirm(maker, late, abe)).json()).toEqual({ confirmed: true });
  const first = (await getJson(maker.api, '/api/me/makes')).makes.find((m: { recipient: { userId: string } }) => m.recipient.userId === abe.userId);
  expect(first.confirmedAt).toMatch(/Z$/);

  // Confirming again keeps the first time.
  expect((await confirm(maker, late, abe)).status()).toBe(200);
  const again = (await getJson(maker.api, '/api/me/makes')).makes.find((m: { recipient: { userId: string } }) => m.recipient.userId === abe.userId);
  expect(again.confirmedAt).toBe(first.confirmedAt);

  let s = await summary(late);
  expect([s.pairingsConfirmed, s.makersConfirmed, s.makers]).toEqual([1, 0, 2]);
  expect((await confirm(maker, late, zed)).status()).toBe(200);
  s = await summary(late);
  expect([s.pairingsConfirmed, s.makersConfirmed]).toEqual([2, 1]);
  // The same people in the other swap aren't confirmed.
  expect((await summary(early)).pairingsConfirmed).toBe(0);
  expect((await member(early, maker)).makingFor).toEqual([expect.objectContaining({ userId: cy.userId, confirmed: false })]);
});

test('sending a new tracking number replaces the old one', async () => {
  expect((await ship(maker, late, abe, 'ups', UPS_NUMBER)).status()).toBe(200);
  await nextSecond();
  const res = await ship(maker, late, abe, 'usps', '9400 1000 0000 0000 0000 00');
  expect(await res.json()).toEqual({ shipped: true, trackingNumber: USPS_NUMBER });

  const expected = {
    shippedAt: expect.stringMatching(/Z$/),
    carrier: 'usps',
    trackingNumber: USPS_NUMBER,
    trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${USPS_NUMBER}`,
  };
  const make = (await getJson(maker.api, '/api/me/makes')).makes.find((m: { recipient: { userId: string } }) => m.recipient.userId === abe.userId);
  expect(make.shipped).toEqual(expected);
  // One package on its way to Abe, with the new number.
  expect((await getJson(abe.api, `/api/swaps/${late}`)).membership.packages).toEqual([expected]);
  expect((await member(late, maker)).makingFor.find((x: { userId: string }) => x.userId === abe.userId).shipped).toEqual(expected);
  const s = await summary(late);
  expect([s.pairingsShipped, s.makersShipped]).toEqual([1, 0]);

  // Sending the same number again changes nothing.
  expect((await ship(maker, late, abe, 'usps', USPS_NUMBER)).status()).toBe(200);
  expect((await emails(abe)).filter((e) => e.kind === 'package_shipped')).toHaveLength(2);
});

test('confirm and shipping reminders each skip people reminded in the last day, separately', async () => {
  // Abe hasn't confirmed making for Maker; Maker and Zed have nothing to confirm (Zed makes for nobody).
  const confirm1 = await remind(late, [maker, abe, zed, abe]);
  expect(await confirm1.json()).toEqual({ sent: 1, failed: 0, skippedRecent: 0, skippedConfirmed: 2 });
  await nextSecond();

  // A confirm reminder doesn't hold back a shipping one. Maker still has Zed to ship.
  const ship1 = await remind(late, [maker, abe, zed], 'ship');
  expect(await ship1.json()).toEqual({ sent: 2, failed: 0, skippedRecent: 0, skippedShipped: 1 });

  expect(await (await remind(late, [maker, abe])).json()).toEqual({ sent: 0, failed: 0, skippedRecent: 1, skippedConfirmed: 1 });
  expect(await (await remind(late, [maker, abe], 'ship')).json()).toEqual({ sent: 0, failed: 0, skippedRecent: 2, skippedShipped: 0 });

  // Being reminded in one swap doesn't count in another: Maker hasn't shipped to Cy in Early.
  await nextSecond();
  expect(await (await remind(early, [maker], 'ship')).json()).toEqual({ sent: 1, failed: 0, skippedRecent: 0, skippedShipped: 0 });

  // The members list shows when each kind was last sent.
  const [m, a, z] = [await member(late, maker), await member(late, abe), await member(late, zed)];
  expect([m.lastRemindedAt, typeof m.lastShipRemindedAt]).toEqual([null, 'string']);
  expect([typeof a.lastRemindedAt, typeof a.lastShipRemindedAt]).toEqual(['string', 'string']);
  expect([z.lastRemindedAt, z.lastShipRemindedAt]).toEqual([null, null]);
  expect((await member(early, maker)).lastShipRemindedAt).toMatch(/Z$/);

  // Bad batches.
  expect((await admin.api.post(`/api/swaps/${late}/reminders`, { data: { userIds: [] } })).status()).toBe(400);
  expect((await admin.api.post(`/api/swaps/${late}/reminders`, { data: { userIds: [abe.userId], kind: 'thanks' } })).status()).toBe(400);
});

test('the email log shows each person only their own sent emails, newest first', async () => {
  const kinds = async (u: User) => (await emails(u)).map((e) => [e.kind, e.swapId]);
  // Sign-in emails aren't logged.
  expect(await kinds(abe)).toEqual([
    ['ship_reminder', late],
    ['confirm_reminder', late],
    ['package_shipped', late],
    ['package_shipped', late],
    ['makers_published', late],
  ]);
  expect(await kinds(maker)).toEqual([
    ['ship_reminder', early],
    ['ship_reminder', late],
    ['makers_published', early],
    ['makers_published', late],
  ]);
  expect(await emails(zed)).toEqual([]);

  const log = await emails(abe);
  const times = log.map((e) => e.sentAt);
  expect([...times].sort().reverse()).toEqual(times);
  expect(new Set(log.map((e) => e.emailId)).size).toBe(log.length);
  for (const e of log) {
    expect(e.sentAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(e.subject).toContain(`Makes late ${run}`);
    expect(e.body.length).toBeGreaterThan(20);
  }
  expect(log[2].body).toContain(USPS_NUMBER);
  expect(log[3].body).toContain(UPS_NUMBER);
  expect(log[2].body).not.toContain(`Maker ${run}`);
});

// GET /api/me/emails sorts on the stored timestamp, not the whole-second string it sends.
test('emails sent within the same second are still newest first', async () => {
  const swapId = await createSwap(admin.api, `Same second ${run}`);
  const a = await newMember('makessame', swapId, { ...US_ADDRESS, name: `Same ${run}` });
  await join(maker, swapId, US_ADDRESS, { checked: true });
  await assign(admin.api, swapId, a.userId, maker.userId);
  await publish(swapId);
  await remind(swapId, [a]);
  await remind(swapId, [a], 'ship');
  expect((await emails(a)).map((e) => e.kind)).toEqual(['ship_reminder', 'confirm_reminder', 'makers_published']);
  await a.api.dispose();
});

// Every time the API sends is UTC. (On Spanner, FORMAT_TIMESTAMP used Los Angeles time but said "Z".)
test('times the API sends are in UTC', async () => {
  const near = (iso: string | null, label: string) =>
    expect(Math.abs(Date.parse(iso ?? '') - Date.now()), `${label}: ${iso}`).toBeLessThan(10 * 60_000);
  near((await summary(late)).publishedAt, 'publishedAt');
  near((await getJson(abe.api, `/api/swaps/${late}`)).membership.joinedAt, 'joinedAt');
  const make = (await getJson(maker.api, '/api/me/makes')).makes.find((m: { recipient: { userId: string } }) => m.recipient.userId === abe.userId);
  near(make.confirmedAt, 'confirmedAt');
  near(make.shipped.shippedAt, 'shippedAt');
  near((await emails(abe))[0].sentAt, 'email sentAt');
  near((await member(late, abe)).lastRemindedAt, 'lastRemindedAt');
  near((await getJson(abe.api, '/api/me/profile')).instagram.checkedAt, 'Instagram checkedAt');
});

test('leaving after publishing takes the pairing off the maker\'s list', async () => {
  expect((await cy.api.delete(`/api/swaps/${early}/membership`)).status()).toBe(204);
  const { makes } = await getJson(maker.api, '/api/me/makes');
  expect(makes.map((m: { swap: { swapId: string } }) => m.swap.swapId)).toEqual([late, late]);
  expect((await getJson(cy.api, '/api/me/makes')).makes).toEqual([]);
  const s = await summary(early);
  expect([s.participants, s.pairings, s.makers]).toEqual([1, 0, 0]);
});
