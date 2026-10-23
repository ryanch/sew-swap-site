import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openSignInLink, signIn } from '../helpers/auth';
import { emailSubjects, listEmailIds, uniqueEmail, waitForEmail, waitForLoginEmail } from '../helpers/mailpit';
import { nameFields, postLink, uniqueHandle, US_ADDRESS } from '../helpers/signup';

const ADMIN_EMAIL = 'admin@example.test';

test.describe.configure({ mode: 'serial' });

type Maker = { key: string; name: string; email: string; handle: string; userId: string; context: BrowserContext; page: Page };

let adminContext: BrowserContext;
let admin: Page;
let swapId: string;
const makers: Record<string, Maker> = {};
const run = Date.now().toString(36);
// Mail each maker had before publishing, so the tests only look at what publishing sent.
const mailBefore: Record<string, string[]> = {};

const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const SHIP_BY = day(35);
const shipByText = () => {
  const [y, m, d] = SHIP_BY.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};
const PUBLISHED = /see who you're making for/;

async function newMaker(browser: Browser, key: string): Promise<Maker> {
  const email = uniqueEmail(key.toLowerCase());
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await signIn(page, email);
  const handle = uniqueHandle(key.toLowerCase());
  expect((await page.request.post('/api/me/instagram/check', { data: { input: postLink(handle) } })).status()).toBe(200);
  const name = `${key} ${run}`;
  const joined = await page.request.put(`/api/swaps/${swapId}/membership`, { data: { address: { ...US_ADDRESS, ...nameFields(name) } } });
  expect(joined.status()).toBe(200);
  const userId = (await (await page.request.get('/api/auth/me')).json()).user.userId as string;
  return { key, name, email, handle, userId, context, page };
}

const assign = (maker: string, recipient: string) =>
  admin.request.put(`/api/swaps/${swapId}/assignments/${makers[maker].userId}/${makers[recipient].userId}`, { data: {} });
const confirm = (maker: string, recipient: string, data: object) =>
  makers[maker].page.request.post(`/api/swaps/${swapId}/makes/${makers[recipient].userId}/confirm`, { data });
const ALL_TICKED = { seenInstagram: true, reviewedAddress: true, canShip: true };
const member = async (key: string) =>
  (await (await admin.request.get(`/api/swaps/${swapId}/members/${makers[key].userId}`)).json()).member;

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({ locale: 'en-US' });
  admin = await adminContext.newPage();
  await signIn(admin, ADMIN_EMAIL);
  const res = await admin.request.post('/api/swaps', {
    data: {
      title: `Publish ${run}`,
      description: 'Make a tote bag.',
      signUpOpens: day(-1),
      signUpCloses: day(5),
      partnersAnnounced: day(7),
      makingDeadline: day(30),
      shipBy: SHIP_BY,
    },
  });
  swapId = (await res.json()).swap.swapId;
  for (const key of ['Amy', 'Ben', 'Cal']) makers[key] = await newMaker(browser, key);
  // Amy makes for two people, Ben and Cal. Ben makes for Cal. Cal makes for nobody, and nobody makes for Amy.
  expect((await assign('Amy', 'Ben')).status()).toBe(200);
  expect((await assign('Amy', 'Cal')).status()).toBe(200);
  expect((await assign('Ben', 'Cal')).status()).toBe(200);
});

test.afterAll(async () => {
  await adminContext.close();
  for (const m of Object.values(makers)) await m.context.close();
});

test("makers can't see who they make for until makers are published", async () => {
  const { page } = makers.Amy;
  expect((await (await page.request.get('/api/me/makes')).json()).makes).toEqual([]);
  expect((await confirm('Amy', 'Ben', ALL_TICKED)).status()).toBe(404);
  const detail = await (await page.request.get(`/api/swaps/${swapId}`)).json();
  expect(detail.swap.makersPublishedAt).toBeNull();
  expect(JSON.stringify(detail)).not.toContain(makers.Ben.userId);

  await page.goto('/');
  await expect(page.getByRole('link', { name: /Confirm who you're making for/ })).toHaveCount(0);
  await page.goto('/makes');
  await expect(page.getByText("There's nothing to confirm yet.")).toBeVisible();
  await expect(page.getByText(makers.Ben.name)).toHaveCount(0);

  // Only the swap's managers can publish.
  expect((await page.request.post(`/api/swaps/${swapId}/publish`, { data: { confirm: true } })).status()).toBe(403);
  expect((await page.request.get(`/api/swaps/${swapId}/publish`)).status()).toBe(403);
});

test('the admin is warned about unpaired people, confirms twice, and publishes', async () => {
  for (const key of Object.keys(makers)) mailBefore[key] = await listEmailIds(makers[key].email);
  await admin.goto(`/manage/swaps/${swapId}/members`);
  const panel = admin.getByRole('region', { name: 'Publish makers' });
  await expect(panel.getByRole('heading', { name: 'Makers are not published yet' })).toBeVisible();
  const warning = panel.getByRole('alert');
  await expect(warning).toContainText('Warning: not everyone is paired.');
  await expect(warning).toContainText("1 person isn't making for anyone.");
  await expect(warning).toContainText('1 person has nobody making for them.');

  // The first click only asks. Cancelling publishes nothing.
  await panel.getByRole('button', { name: 'Publish Makers' }).click();
  await expect(panel.getByText('Publish makers now?')).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  expect((await (await admin.request.get(`/api/swaps/${swapId}/publish`)).json()).publishedAt).toBeNull();

  // Dismissing the second question publishes nothing either.
  await panel.getByRole('button', { name: 'Publish Makers' }).click();
  admin.once('dialog', (d) => d.dismiss());
  await panel.getByRole('button', { name: 'Yes, publish makers' }).click();
  expect((await (await admin.request.get(`/api/swaps/${swapId}/publish`)).json()).publishedAt).toBeNull();

  admin.once('dialog', (d) => {
    expect(d.message()).toContain('This emails 2 people');
    d.accept();
  });
  await panel.getByRole('button', { name: 'Yes, publish makers' }).click();
  await expect(panel.getByText('Makers published. We emailed 2 people.')).toBeVisible();
  await expect(panel.getByText(/Makers were published on/)).toBeVisible();
  await expect(panel.getByText('0 of 2 makers have confirmed.')).toBeVisible();

  // Publishing twice is refused.
  expect((await admin.request.post(`/api/swaps/${swapId}/publish`, { data: { confirm: true } })).status()).toBe(409);
  // Both makers are now pending confirmation.
  const pending = await (await admin.request.get(`/api/swaps/${swapId}/members?needs=confirmation`)).json();
  expect(pending.members.map((m: { userId: string }) => m.userId).sort()).toEqual([makers.Amy.userId, makers.Ben.userId].sort());
});

test('every maker is emailed, and nobody else', async () => {
  for (const key of ['Amy', 'Ben']) {
    const mail = await waitForEmail(makers[key].email, PUBLISHED, { excludeIds: mailBefore[key] });
    expect(mail.text).toContain('/makes');
    expect(mail.text).toContain(`ship by ${shipByText()}`);
  }
  // Cal isn't making for anyone, so has nothing to confirm.
  expect((await emailSubjects(makers.Cal.email, { excludeIds: mailBefore.Cal })).filter((s) => PUBLISHED.test(s))).toEqual([]);

  // The email is kept in the app too.
  const { page } = makers.Amy;
  await page.goto('/emails');
  await expect(page.getByRole('listitem', { name: `Publish ${run}: see who you're making for` })).toBeVisible();
});

test("after publishing, one click from home shows who you make for, and confirming needs all three boxes", async () => {
  const { page } = makers.Amy;
  await page.goto('/');
  await page.getByRole('link', { name: "Confirm who you're making for (2)" }).click();
  const card = page.getByRole('listitem', { name: `Making for ${makers.Ben.name}` });
  await expect(card.getByRole('heading', { name: `You are making for ${makers.Ben.name}` })).toBeVisible();
  await expect(card.getByRole('link', { name: `@${makers.Ben.handle}` })).toHaveAttribute(
    'href',
    `https://www.instagram.com/${makers.Ben.handle}/`,
  );
  await expect(card.getByText(US_ADDRESS.line1)).toBeVisible();

  const button = card.getByRole('button', { name: 'Confirm' });
  const boxes = [
    card.getByLabel('I can see the Instagram of the person I am making for'),
    card.getByLabel('I have reviewed the address'),
    card.getByLabel(`I am able to make for this person, and ship on ${shipByText()}`),
  ];
  await expect(button).toBeDisabled();
  for (const box of boxes.slice(0, 2)) {
    await box.check();
    await expect(button).toBeDisabled();
  }
  // Any two of the three still isn't enough.
  await boxes[0].uncheck();
  await boxes[2].check();
  await expect(button).toBeDisabled();
  await boxes[0].check();
  await expect(button).toBeEnabled();

  // The API checks the boxes too.
  expect((await confirm('Amy', 'Ben', { seenInstagram: true, reviewedAddress: true })).status()).toBe(400);
  expect((await confirm('Amy', 'Ben', { seenInstagram: true, reviewedAddress: true, canShip: false })).status()).toBe(400);
  expect((await confirm('Amy', 'Ben', {})).status()).toBe(400);
  // Nobody can confirm a pairing that isn't theirs.
  expect((await confirm('Ben', 'Amy', ALL_TICKED)).status()).toBe(404);

  await button.click();
  await expect(card.getByText(/You confirmed on/)).toBeVisible();
});

test('a maker with two people gets one email, and confirms each person separately', async () => {
  const { page } = makers.Amy;
  // Publishing sent Amy one email, not one per person.
  const subjects = await emailSubjects(makers.Amy.email, { excludeIds: mailBefore.Amy });
  expect(subjects.filter((s) => PUBLISHED.test(s))).toHaveLength(1);

  // Confirming Ben (previous test) left Cal still to confirm.
  const ben = page.getByRole('listitem', { name: `Making for ${makers.Ben.name}` });
  const cal = page.getByRole('listitem', { name: `Making for ${makers.Cal.name}` });
  await expect(ben.getByText(/You confirmed on/)).toBeVisible();
  await expect(cal.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await expect(page.getByText('Please confirm this person below.')).toBeVisible();
  expect((await member('Amy')).makingFor).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: makers.Ben.userId, confirmed: true }),
      expect.objectContaining({ userId: makers.Cal.userId, confirmed: false }),
    ]),
  );
  // Amy is still pending, because one of her two isn't confirmed.
  await admin.goto(`/manage/swaps/${swapId}/members`);
  const amyRow = admin.getByRole('listitem', { name: makers.Amy.email });
  await expect(amyRow.getByText('✓ confirmed')).toHaveCount(1);
  await expect(amyRow.getByText('not confirmed yet')).toHaveCount(1);
  await expect(admin.getByText('0 of 2 makers have confirmed.')).toBeVisible();
  await page.goto('/');
  await page.getByRole('link', { name: "Confirm who you're making for (1)" }).click();

  for (const label of [
    'I can see the Instagram of the person I am making for',
    'I have reviewed the address',
    `I am able to make for this person, and ship on ${shipByText()}`,
  ]) {
    await cal.getByLabel(label).check();
  }
  await cal.getByRole('button', { name: 'Confirm' }).click();
  await expect(cal.getByText(/You confirmed on/)).toBeVisible();
  await expect(page.getByText("You've confirmed everyone. Thank you!")).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Confirm who you're making for/ })).toHaveCount(0);

  // The manager sees both confirmed, on the page and in the CSV.
  await admin.reload();
  await expect(amyRow.getByText('✓ confirmed')).toHaveCount(2);
  await expect(admin.getByRole('listitem', { name: makers.Ben.email }).getByText('not confirmed yet')).toBeVisible();
  await expect(admin.getByText('1 of 2 makers have confirmed.')).toBeVisible();
  const csv = await (await admin.request.get(`/api/swaps/${swapId}/export.csv`)).text();
  const rows = csv.replace(/^\uFEFF/, '').trim().split('\r\n').map((l) => l.split(','));
  const col = (name: string) => rows[0].indexOf(name);
  const amy = rows.find((r) => r[0] === makers.Amy.name)!;
  const confirmedFor = [1, 2].map((n) => {
    const suffix = n === 1 ? '' : ` ${n}`;
    return [amy[col(`Making For${suffix}`)].split(' (@')[0], amy[col(`Make${suffix} Confirmed`)]];
  });
  expect(confirmedFor.sort()).toEqual([[makers.Ben.name, 'Yes'], [makers.Cal.name, 'Yes']]);
  const benRow = rows.find((r) => r[0] === makers.Ben.name)!;
  expect([benRow[col('Making For')].split(' (@')[0], benRow[col('Make Confirmed')]]).toEqual([makers.Cal.name, 'No']);
});

test('the link in the email leads back to the makes page after signing in', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/makes');
  await expect(page).toHaveURL(/\/login$/);
  const excludeIds = await listEmailIds(makers.Ben.email);
  await page.getByLabel('Email address').fill(makers.Ben.email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  const mail = await waitForLoginEmail(makers.Ben.email, { excludeIds });
  await openSignInLink(page, mail.token);
  await expect(page.getByRole('heading', { name: "Who you're making for" })).toBeVisible();
  await expect(page.getByRole('listitem', { name: `Making for ${makers.Cal.name}` })).toBeVisible();
  await context.close();
});

test('the manager sees who has not confirmed and sends reminders in batches', async () => {
  await admin.goto(`/manage/swaps/${swapId}/members`);
  await admin.getByRole('button', { name: "Show who hasn't confirmed" }).click();
  await expect(admin).toHaveURL(/needs=confirmation/);
  await expect(admin.getByText('1 person.', { exact: true })).toBeVisible();
  const ben = admin.getByRole('listitem', { name: makers.Ben.email });
  await expect(ben.getByText('Never reminded')).toBeVisible();
  await expect(admin.getByRole('listitem', { name: makers.Amy.email })).toHaveCount(0);

  const send = admin.getByRole('button', { name: /^Send reminder to/ });
  await expect(send).toBeDisabled();
  await admin.getByRole('button', { name: 'Select all shown' }).click();
  await expect(ben.getByLabel(`Remind ${makers.Ben.name}`)).toBeChecked();
  const excludeIds = await listEmailIds(makers.Ben.email);
  admin.once('dialog', (d) => d.accept());
  await admin.getByRole('button', { name: 'Send reminder to 1 person' }).click();
  await expect(admin.getByText('Sent 1 reminder.')).toBeVisible();
  await expect(ben.getByText(/Last reminded/)).toBeVisible();
  const reminder = await waitForEmail(makers.Ben.email, /^Reminder: please confirm/, { excludeIds });
  expect(reminder.text).toContain('/makes');

  // Sending again right away skips Ben, and skips Amy who already confirmed.
  const again = await admin.request.post(`/api/swaps/${swapId}/reminders`, {
    data: { userIds: [makers.Amy.userId, makers.Ben.userId] },
  });
  expect(await again.json()).toEqual({ sent: 0, failed: 0, skippedRecent: 1, skippedConfirmed: 1 });
  // A batch has at most 50 people, and only managers can send.
  const tooMany = Array.from({ length: 51 }, (_, i) => `id-${i}`);
  expect((await admin.request.post(`/api/swaps/${swapId}/reminders`, { data: { userIds: tooMany } })).status()).toBe(400);
  expect(
    (await makers.Amy.page.request.post(`/api/swaps/${swapId}/reminders`, { data: { userIds: [makers.Ben.userId] } })).status(),
  ).toBe(403);
});

test('a pairing added after publishing emails the maker and needs confirming', async () => {
  const excludeIds = await listEmailIds(makers.Cal.email);
  expect((await assign('Cal', 'Amy')).status()).toBe(200);
  await waitForEmail(makers.Cal.email, /you have someone new to make for/, { excludeIds });
  const makes = (await (await makers.Cal.page.request.get('/api/me/makes')).json()).makes;
  expect(makes).toEqual([expect.objectContaining({ recipient: expect.objectContaining({ userId: makers.Amy.userId }), confirmedAt: null })]);
  expect((await member('Cal')).makingFor).toEqual([expect.objectContaining({ userId: makers.Amy.userId, confirmed: false })]);
  // Assigning the same pairing again doesn't email twice.
  const before = await listEmailIds(makers.Cal.email);
  expect((await assign('Cal', 'Amy')).status()).toBe(200);
  expect((await emailSubjects(makers.Cal.email, { excludeIds: before })).length).toBe(0);
});
