import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from '../helpers/auth';
import { emailSubjects, listEmailIds, uniqueEmail, waitForEmail } from '../helpers/mailpit';
import { uniqueHandle, US_ADDRESS } from '../helpers/signup';

const ADMIN_EMAIL = 'admin@example.test';

test.describe.configure({ mode: 'serial' });

type Maker = { key: string; name: string; email: string; userId: string; context: BrowserContext; page: Page };

let adminContext: BrowserContext;
let admin: Page;
let swapId: string;
const makers: Record<string, Maker> = {};
const run = Date.now().toString(36);
// Ben's mail before Amy ships to him, so the test only looks at the shipped email.
let benMailBefore: string[] = [];

const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const SHIP_BY = day(35);
const shipByText = () => {
  const [y, m, d] = SHIP_BY.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};
const UPS_NUMBER = '1Z999AA10123456784';
const CANADA_POST_NUMBER = 'EE123456789CA';
const SHIPPED = /your package is on its way/;
const SHIP_REMINDER = /^Reminder: please ship your package/;

async function newMaker(browser: Browser, key: string): Promise<Maker> {
  const email = uniqueEmail(key.toLowerCase());
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await signIn(page, email);
  expect((await page.request.post('/api/me/instagram/check', { data: { input: uniqueHandle(key.toLowerCase()) } })).status()).toBe(200);
  const name = `${key} ${run}`;
  const joined = await page.request.put(`/api/swaps/${swapId}/membership`, { data: { address: { ...US_ADDRESS, name } } });
  expect(joined.status()).toBe(200);
  const userId = (await (await page.request.get('/api/auth/me')).json()).user.userId as string;
  return { key, name, email, userId, context, page };
}

const assign = (maker: string, recipient: string) =>
  admin.request.put(`/api/swaps/${swapId}/assignments/${makers[maker].userId}/${makers[recipient].userId}`, { data: {} });
const confirm = (maker: string, recipient: string) =>
  makers[maker].page.request.post(`/api/swaps/${swapId}/makes/${makers[recipient].userId}/confirm`, {
    data: { seenInstagram: true, reviewedAddress: true, canShip: true },
  });
const ship = (maker: string, recipient: string, data: object) =>
  makers[maker].page.request.post(`/api/swaps/${swapId}/makes/${makers[recipient].userId}/ship`, { data });
const summary = async () => (await admin.request.get(`/api/swaps/${swapId}/publish`)).json();
const needsShipping = async () =>
  ((await (await admin.request.get(`/api/swaps/${swapId}/members?needs=shipping`)).json()).members as { userId: string }[])
    .map((m) => m.userId)
    .sort();
const ids = (...keys: string[]) => keys.map((k) => makers[k].userId).sort();

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({ locale: 'en-US' });
  admin = await adminContext.newPage();
  await signIn(admin, ADMIN_EMAIL);
  const res = await admin.request.post('/api/swaps', {
    data: {
      title: `Shipping ${run}`,
      description: 'Make a pincushion.',
      signUpOpens: day(-1),
      signUpCloses: day(5),
      partnersAnnounced: day(7),
      makingDeadline: day(30),
      shipBy: SHIP_BY,
    },
  });
  swapId = (await res.json()).swap.swapId;
  for (const key of ['Amy', 'Ben', 'Cal', 'Dee']) makers[key] = await newMaker(browser, key);
  // Amy makes for Ben and Cal, Ben makes for Cal, and Dee makes for Amy.
  for (const [m, r] of [['Amy', 'Ben'], ['Amy', 'Cal'], ['Ben', 'Cal'], ['Dee', 'Amy']]) expect((await assign(m, r)).status()).toBe(200);
});

test.afterAll(async () => {
  await adminContext.close();
  for (const m of Object.values(makers)) await m.context.close();
});

test("nobody can ship before makers are published, or before confirming", async () => {
  expect((await ship('Amy', 'Ben', { carrier: 'ups', trackingNumber: UPS_NUMBER })).status()).toBe(404);
  // Reminders need publishing too.
  expect(
    (await admin.request.post(`/api/swaps/${swapId}/reminders`, { data: { userIds: [makers.Amy.userId], kind: 'ship' } })).status(),
  ).toBe(409);

  expect((await admin.request.post(`/api/swaps/${swapId}/publish`, { data: { confirm: true } })).status()).toBe(200);
  // Published, but Amy hasn't confirmed Ben yet.
  const early = await ship('Amy', 'Ben', { carrier: 'ups', trackingNumber: UPS_NUMBER });
  expect(early.status()).toBe(409);
  expect((await early.json()).error).toContain('confirm');
  // Nobody can ship a pairing that isn't theirs.
  expect((await ship('Ben', 'Amy', { carrier: 'ups', trackingNumber: UPS_NUMBER })).status()).toBe(404);

  // Amy and Ben confirm. Dee doesn't, so her page only offers confirming.
  for (const [m, r] of [['Amy', 'Ben'], ['Amy', 'Cal'], ['Ben', 'Cal']]) expect((await confirm(m, r)).status()).toBe(200);
  await makers.Dee.page.goto('/makes');
  const card = makers.Dee.page.getByRole('listitem', { name: `Making for ${makers.Amy.name}` });
  await expect(card.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await expect(card.getByRole('button', { name: "I've shipped it" })).toHaveCount(0);
  expect(await needsShipping()).toEqual(ids('Amy', 'Ben', 'Dee'));
});

test('a maker clicks a button to say they shipped, and must give a tracking number', async () => {
  const { page } = makers.Amy;
  benMailBefore = await listEmailIds(makers.Ben.email);
  await page.goto('/');
  await page.getByRole('link', { name: 'Add your tracking number (2)' }).click();
  const card = page.getByRole('listitem', { name: `Making for ${makers.Ben.name}` });
  const button = card.getByRole('button', { name: "I've shipped it" });
  await expect(button).toBeDisabled();
  await card.getByLabel('Shipped with').selectOption('usps');
  await expect(button).toBeDisabled();

  // The API needs a real-looking number and a carrier too.
  for (const data of [
    { carrier: 'ups', trackingNumber: '' },
    { carrier: 'ups', trackingNumber: 'abc' },
    { carrier: 'ups', trackingNumber: 'https://ups.com/x' },
    { carrier: 'pigeon', trackingNumber: UPS_NUMBER },
    { carrier: 'ups' },
    {},
  ]) {
    expect((await ship('Amy', 'Ben', data)).status(), JSON.stringify(data)).toBe(400);
  }

  // Typing a UPS number doesn't change a carrier the maker picked themselves.
  await card.getByLabel('Tracking number').fill('1z999aa1 0123 4567 84');
  await expect(card.getByLabel('Shipped with')).toHaveValue('usps');
  await card.getByLabel('Shipped with').selectOption('ups');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(card.getByText(/You shipped it on/)).toBeVisible();
  // Stored without spaces, uppercased, and linked to UPS.
  await expect(card.getByRole('link', { name: UPS_NUMBER })).toHaveAttribute('href', `https://www.ups.com/track?tracknum=${UPS_NUMBER}`);
});

test('the carrier is guessed from the tracking number', async () => {
  const { page } = makers.Amy;
  const card = page.getByRole('listitem', { name: `Making for ${makers.Cal.name}` });
  await card.getByLabel('Tracking number').fill(CANADA_POST_NUMBER);
  await expect(card.getByLabel('Shipped with')).toHaveValue('canadapost');
  await card.getByLabel('Tracking number').fill(UPS_NUMBER);
  await expect(card.getByLabel('Shipped with')).toHaveValue('ups');
  // Not shipped yet: Amy still has Cal to ship.
  await expect(card.getByRole('button', { name: "I've shipped it" })).toBeEnabled();
});

test('the recipient is emailed the tracking number and sees it on the swap page, without the maker', async () => {
  const mail = await waitForEmail(makers.Ben.email, SHIPPED, { excludeIds: benMailBefore });
  expect(mail.text).toContain(`UPS tracking number: ${UPS_NUMBER}`);
  expect(mail.text).toContain(`https://www.ups.com/track?tracknum=${UPS_NUMBER}`);
  expect(mail.text).toContain(`/swaps/${swapId}`);
  expect(mail.text).not.toContain(makers.Amy.name);
  expect(mail.text).not.toContain(makers.Amy.email);

  const { page } = makers.Ben;
  const detail = await (await page.request.get(`/api/swaps/${swapId}`)).json();
  expect(JSON.stringify(detail)).not.toContain(makers.Amy.userId);
  await page.goto(`/swaps/${swapId}`);
  const section = page.getByRole('region', { name: 'Your package' });
  await expect(section.getByText(UPS_NUMBER)).toBeVisible();
  await expect(section.getByText(/with UPS/)).toBeVisible();
  await expect(section.getByRole('link', { name: 'Track my package' })).toHaveAttribute(
    'href',
    `https://www.ups.com/track?tracknum=${UPS_NUMBER}`,
  );
  await expect(section).not.toContainText(makers.Amy.name);

  // Cal's package hasn't shipped yet.
  await makers.Cal.page.goto(`/swaps/${swapId}`);
  await expect(makers.Cal.page.getByRole('region', { name: 'Your package' }).getByText('Not shipped yet.')).toBeVisible();

  // Sending the same number again doesn't email Ben twice.
  const before = await listEmailIds(makers.Ben.email);
  expect((await ship('Amy', 'Ben', { carrier: 'ups', trackingNumber: UPS_NUMBER })).status()).toBe(200);
  expect((await emailSubjects(makers.Ben.email, { excludeIds: before })).filter((s) => SHIPPED.test(s))).toEqual([]);
});

test('a maker making for two people has to ship to both', async () => {
  expect(await needsShipping()).toEqual(ids('Amy', 'Ben', 'Dee'));
  let s = await summary();
  expect([s.makersShipped, s.pairingsShipped, s.makers, s.pairings]).toEqual([0, 1, 3, 4]);
  expect(
    (await (await makers.Amy.page.request.get('/api/me/makes')).json()).makes.map((m: { shipped: unknown }) => Boolean(m.shipped)).sort(),
  ).toEqual([false, true]);
  await makers.Amy.page.goto('/');
  await expect(makers.Amy.page.getByRole('link', { name: 'Add your tracking number (1)' })).toBeVisible();

  expect((await ship('Amy', 'Cal', { carrier: 'canadapost', trackingNumber: CANADA_POST_NUMBER })).status()).toBe(200);
  expect(await needsShipping()).toEqual(ids('Ben', 'Dee'));
  s = await summary();
  expect([s.makersShipped, s.pairingsShipped]).toEqual([1, 2]);
  await makers.Amy.page.goto('/makes');
  await expect(makers.Amy.page.getByText("You've shipped to everyone. Thank you!")).toBeVisible();
  await makers.Amy.page.goto('/');
  await expect(makers.Amy.page.getByRole('link', { name: /Add your tracking number/ })).toHaveCount(0);
});

test('the admin sees who has shipped, with tracking links', async () => {
  await admin.goto(`/manage/swaps/${swapId}/members`);
  await expect(admin.getByText('1 of 3 makers have shipped everything.')).toBeVisible();
  await expect(admin.getByText('(2 of 4 packages)')).toBeVisible();
  const amy = admin.getByRole('listitem', { name: makers.Amy.email });
  await expect(amy.getByText(/📦 shipped/)).toHaveCount(2);
  await expect(amy.getByRole('link', { name: UPS_NUMBER })).toHaveAttribute('href', `https://www.ups.com/track?tracknum=${UPS_NUMBER}`);
  await expect(amy.getByRole('link', { name: CANADA_POST_NUMBER })).toHaveAttribute('href', new RegExp(`canadapost.*${CANADA_POST_NUMBER}$`));
  const ben = admin.getByRole('listitem', { name: makers.Ben.email });
  await expect(ben.getByText('not shipped yet')).toBeVisible();

  // The person page shows it too.
  await admin.goto(`/manage/swaps/${swapId}/members/${makers.Amy.userId}`);
  await expect(admin.getByRole('link', { name: UPS_NUMBER })).toBeVisible();
});

test('the CSV shows ship status and tracking for everyone they make for', async () => {
  const csv = await (await admin.request.get(`/api/swaps/${swapId}/export.csv`)).text();
  const rows = csv.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
  const col = (name: string) => rows[0].indexOf(name);
  for (const name of ['Make Shipped', 'Make Tracking', 'Make Tracking link', 'Make 5 Shipped', 'Make 5 Tracking link']) {
    expect(col(name), name).toBeGreaterThan(-1);
  }
  const amy = rows.find((r) => r[0] === makers.Amy.name)!;
  const makes = [1, 2].map((n) => {
    const suffix = n === 1 ? '' : ` ${n}`;
    return [
      amy[col(`Making For${suffix}`)].split(' (@')[0],
      amy[col(`Make${suffix} Shipped`)],
      amy[col(`Make${suffix} Tracking`)],
      amy[col(`Make${suffix} Tracking link`)],
    ];
  });
  expect(makes.sort()).toEqual([
    [makers.Ben.name, 'Yes', `UPS ${UPS_NUMBER}`, `https://www.ups.com/track?tracknum=${UPS_NUMBER}`],
    [makers.Cal.name, 'Yes', `Canada Post ${CANADA_POST_NUMBER}`, expect.stringContaining(CANADA_POST_NUMBER)],
  ]);
  const ben = rows.find((r) => r[0] === makers.Ben.name)!;
  expect([ben[col('Making For')].split(' (@')[0], ben[col('Make Shipped')], ben[col('Make Tracking')]]).toEqual([makers.Cal.name, 'No', '']);
});

test('the admin sends shipping reminders in bulk, with the ship date', async () => {
  const before = { Ben: await listEmailIds(makers.Ben.email), Dee: await listEmailIds(makers.Dee.email) };
  await admin.goto(`/manage/swaps/${swapId}/members`);
  await admin.getByRole('button', { name: "Show who hasn't shipped" }).click();
  await expect(admin).toHaveURL(/needs=shipping/);
  await expect(admin.getByText('2 people.', { exact: true })).toBeVisible();
  await expect(admin.getByRole('listitem', { name: makers.Amy.email })).toHaveCount(0);
  const ben = admin.getByRole('listitem', { name: makers.Ben.email });
  await expect(ben.getByText('Never reminded')).toBeVisible();

  await admin.getByRole('button', { name: 'Select all shown' }).click();
  admin.once('dialog', (d) => {
    expect(d.message()).toContain('shipping reminder to 2 people');
    d.accept();
  });
  await admin.getByRole('button', { name: 'Send shipping reminder to 2 people' }).click();
  await expect(admin.getByText('Sent 2 shipping reminders.')).toBeVisible();
  await expect(ben.getByText(/Last reminded/)).toBeVisible();

  // Dee hasn't confirmed yet, and is reminded too: the email asks for both.
  for (const key of ['Ben', 'Dee'] as const) {
    const mail = await waitForEmail(makers[key].email, SHIP_REMINDER, { excludeIds: before[key] });
    expect(mail.text).toContain(`Please ship by ${shipByText()}`);
    expect(mail.text).toContain('/makes');
  }

  // Sending again right away skips them, and skips Amy who shipped everything.
  const again = await admin.request.post(`/api/swaps/${swapId}/reminders`, {
    data: { userIds: ids('Amy', 'Ben', 'Dee'), kind: 'ship' },
  });
  expect(await again.json()).toEqual({ sent: 0, failed: 0, skippedRecent: 2, skippedShipped: 1 });
  // A shipping reminder doesn't hold back a confirmation reminder.
  const confirmReminder = await admin.request.post(`/api/swaps/${swapId}/reminders`, { data: { userIds: ids('Dee') } });
  expect((await confirmReminder.json()).sent).toBe(1);
  // Only managers can send.
  expect(
    (await makers.Amy.page.request.post(`/api/swaps/${swapId}/reminders`, { data: { userIds: ids('Ben'), kind: 'ship' } })).status(),
  ).toBe(403);
});

test('removing a shipped pairing shows a stern warning first', async () => {
  await admin.goto(`/manage/swaps/${swapId}/members/${makers.Amy.userId}`);
  const ben = admin.getByRole('listitem', { name: makers.Ben.name });
  await ben.getByRole('button', { name: `Stop making for ${makers.Ben.name}` }).click();
  const warning = ben.getByRole('alert');
  await expect(warning).toContainText('Stop! This package has already been shipped.');
  await expect(warning).toContainText(UPS_NUMBER);

  // Keeping it, or dismissing the second question, removes nothing.
  await warning.getByRole('button', { name: 'Keep the pairing' }).click();
  await expect(ben.getByRole('alert')).toHaveCount(0);
  await ben.getByRole('button', { name: `Stop making for ${makers.Ben.name}` }).click();
  admin.once('dialog', (d) => d.dismiss());
  await ben.getByRole('button', { name: 'Yes, remove it and delete the tracking' }).click();
  expect((await (await admin.request.get(`/api/swaps/${swapId}/members/${makers.Amy.userId}`)).json()).member.makingFor).toHaveLength(2);

  // A pairing that hasn't shipped is removed without the warning.
  const dee = admin.getByRole('listitem', { name: makers.Dee.name });
  await dee.getByRole('button', { name: `${makers.Dee.name} stops making for them` }).click();
  await expect(dee).toHaveCount(0);

  // Saying yes twice removes it.
  admin.once('dialog', (d) => {
    expect(d.message()).toContain('already shipped');
    d.accept();
  });
  await ben.getByRole('button', { name: 'Yes, remove it and delete the tracking' }).click();
  await expect(ben).toHaveCount(0);
});
