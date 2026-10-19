import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { currentUser, signIn } from '../helpers/auth';
import { uniqueEmail } from '../helpers/mailpit';
import { joinSwap, joinThroughPage } from '../helpers/signup';

const ADMIN_EMAIL = 'admin@example.test';

test.describe.configure({ mode: 'serial' });

let adminContext: BrowserContext;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext();
  admin = await adminContext.newPage();
  await signIn(admin, ADMIN_EMAIL);
});

test.afterAll(async () => {
  await adminContext.close();
});

async function newSignedInUser(browser: Browser, prefix: string) {
  const email = uniqueEmail(prefix);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { email, context, page };
}

async function makeSwapManager(email: string) {
  await admin.goto('/admin/users');
  await admin.getByLabel('Find a person by email or name').fill(email);
  await admin.getByRole('button', { name: 'Search' }).click();
  const box = admin.getByRole('listitem', { name: email }).getByRole('checkbox', { name: 'Swap Manager' });
  await box.click();
  await expect(box).toBeChecked();
}

const swapBody = (title: string) => ({
  title,
  description: 'Make something small.',
  signUpOpens: '2099-11-01',
  signUpCloses: '2099-11-15',
  partnersAnnounced: '2099-11-20',
  makingDeadline: '2099-12-10',
  shipBy: '2099-12-15',
});

test('swap managers create and edit swaps, and users browse them', async ({ browser }) => {
  const plain = await newSignedInUser(browser, 'plain');
  const mgr = await newSignedInUser(browser, 'swapmgr');
  const title = `Spring Swap ${Date.now()}`;

  // A regular user can't create swaps or see the manage link.
  expect((await plain.page.request.post('/api/swaps', { data: swapBody('Nope') })).status()).toBe(403);
  await plain.page.goto('/');
  await expect(plain.page.getByRole('link', { name: 'Manage my swaps' })).toHaveCount(0);

  await makeSwapManager(mgr.email);

  // Create through the form.
  await mgr.page.goto('/');
  await mgr.page.getByRole('link', { name: 'Manage my swaps' }).click();
  await mgr.page.getByRole('link', { name: 'Create a swap' }).click();
  await mgr.page.getByLabel('Title').fill(title);
  await mgr.page.getByLabel('Description').fill('Make something small.');
  await mgr.page.getByLabel('Sign-up opens').fill('2099-11-01');
  await mgr.page.getByLabel('Sign-up closes').fill('2099-11-15');
  await mgr.page.getByLabel('Partners announced').fill('2099-11-20');
  await mgr.page.getByLabel('Making deadline').fill('2099-12-10');
  await mgr.page.getByLabel('Ship by').fill('2099-12-15');
  await mgr.page.getByRole('button', { name: 'Create swap' }).click();
  await expect(mgr.page.getByRole('heading', { name: title })).toBeVisible();
  const swapId = mgr.page.url().split('/').pop()!;

  // A regular user browses to it and sees no Join button (sign-up hasn't opened) and no Edit link.
  await plain.page.goto('/');
  await plain.page.getByRole('link', { name: 'Browse swaps' }).click();
  await plain.page.getByRole('listitem', { name: title }).getByRole('link', { name: 'View details' }).click();
  await expect(plain.page.getByRole('heading', { name: title })).toBeVisible();
  await expect(plain.page.getByText('December 15, 2099')).toBeVisible();
  await expect(plain.page.getByRole('link', { name: 'Join this swap' })).toHaveCount(0);
  await expect(plain.page.getByText('Sign-up opens on November 1, 2099.')).toBeVisible();
  await expect(plain.page.getByRole('link', { name: 'Edit this swap' })).toHaveCount(0);
  expect((await plain.page.request.put(`/api/swaps/${swapId}`, { data: swapBody('Hijack') })).status()).toBe(403);

  // The manager edits it.
  await mgr.page.getByRole('link', { name: 'Edit this swap' }).click();
  await mgr.page.getByLabel('Title').fill(`${title} (updated)`);
  await mgr.page.getByLabel('Ship by').fill('2099-12-20');
  await mgr.page.getByRole('button', { name: 'Save changes' }).click();
  await expect(mgr.page.getByRole('heading', { name: `${title} (updated)` })).toBeVisible();
  await expect(mgr.page.getByText('December 20, 2099')).toBeVisible();

  // Appears under "My swaps".
  await mgr.page.goto('/manage/swaps');
  await expect(mgr.page.getByRole('listitem', { name: `${title} (updated)` })).toBeVisible();

  // Another swap manager can't edit it, but an admin can.
  const other = await newSignedInUser(browser, 'othermgr');
  await makeSwapManager(other.email);
  expect((await other.page.request.put(`/api/swaps/${swapId}`, { data: swapBody('Hijack') })).status()).toBe(403);
  await other.page.goto('/manage/swaps');
  await expect(other.page.getByRole('listitem', { name: `${title} (updated)` })).toHaveCount(0);
  const byAdmin = await admin.request.put(`/api/swaps/${swapId}`, { data: swapBody('Admin edit') });
  expect(byAdmin.status()).toBe(200);

  // Validation.
  const bad = await mgr.page.request.post('/api/swaps', {
    data: { ...swapBody('Backwards'), signUpOpens: '2099-11-15', signUpCloses: '2099-11-01' },
  });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatch(/close/);
  expect((await mgr.page.request.post('/api/swaps', { data: { ...swapBody(''), title: '' } })).status()).toBe(400);
  expect((await currentUser(mgr.page)).body.user.roles).toEqual(['swap_manager']);

  for (const u of [plain, mgr, other]) await u.context.close();
});

/** YYYY-MM-DD, `days` from today in UTC (the API compares against CURRENT_DATE() in UTC). */
function day(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const swapWithWindow = (title: string, opens: number, closes: number) => ({
  ...swapBody(title),
  signUpOpens: day(opens),
  signUpCloses: day(closes),
});

async function members(page: Page, swapId: string) {
  const res = await page.request.get(`/api/swaps/${swapId}/members`);
  return { status: res.status(), body: res.ok() ? await res.json() : null };
}

test('users join and leave a swap while sign-up is open', async ({ browser }) => {
  const mgr = await newSignedInUser(browser, 'joinmgr');
  const joiner = await newSignedInUser(browser, 'joiner');
  const second = await newSignedInUser(browser, 'joiner2');
  await makeSwapManager(mgr.email);

  const create = async (body: object) => (await (await mgr.page.request.post('/api/swaps', { data: body })).json()).swap.swapId as string;
  const openId = await create(swapWithWindow(`Open ${Date.now()}`, -1, 5));
  const upcomingId = await create(swapWithWindow(`Upcoming ${Date.now()}`, 3, 9));
  const closedId = await create(swapWithWindow(`Closed ${Date.now()}`, -9, -2));

  // Join through the page, then leave.
  await joinThroughPage(joiner.page, openId);
  await joiner.page.reload();
  await expect(joiner.page.getByRole('button', { name: 'Leave this swap' })).toBeVisible();

  // Joining twice doesn't add a second row.
  expect((await joinSwap(joiner.page, openId)).status()).toBe(200);
  expect((await joinSwap(second.page, openId)).status()).toBe(200);
  const listed = await members(mgr.page, openId);
  expect(listed.body.total).toBe(2);
  expect(listed.body.members.map((m: { email: string }) => m.email).sort()).toEqual([joiner.email, second.email].sort());

  // The manager sees them on the page too; a regular user can't list members.
  await mgr.page.goto(`/swaps/${openId}`);
  await mgr.page.getByRole('link', { name: "See who's signed up" }).click();
  await expect(mgr.page.getByText('2 people have joined.')).toBeVisible();
  await expect(mgr.page.getByRole('listitem', { name: joiner.email })).toBeVisible();
  expect((await members(joiner.page, openId)).status).toBe(403);

  // Pagination: one at a time.
  const first = await (await mgr.page.request.get(`/api/swaps/${openId}/members?limit=1`)).json();
  expect(first.members).toHaveLength(1);
  const rest = await (await mgr.page.request.get(`/api/swaps/${openId}/members?limit=1&after=${first.nextCursor}`)).json();
  expect(rest.members).toHaveLength(1);
  expect(rest.nextCursor).toBeNull();

  // Leaving removes them (twice is fine) and the page offers Join again.
  await joiner.page.getByRole('button', { name: 'Leave this swap' }).click();
  await expect(joiner.page.getByRole('link', { name: 'Join this swap' })).toBeVisible();
  expect((await joiner.page.request.delete(`/api/swaps/${openId}/membership`)).status()).toBe(204);
  expect((await members(mgr.page, openId)).body.total).toBe(1);

  // Not open yet, already closed, or missing: no joining. Closed swaps still let people leave.
  expect((await joiner.page.request.put(`/api/swaps/${upcomingId}/membership`)).status()).toBe(403);
  expect((await joiner.page.request.put(`/api/swaps/${closedId}/membership`)).status()).toBe(403);
  expect((await joiner.page.request.put('/api/swaps/nope/membership')).status()).toBe(404);
  await joiner.page.goto(`/swaps/${closedId}`);
  await expect(joiner.page.getByText('Sign-up for this swap has closed.')).toBeVisible();
  await joiner.page.goto(`/swaps/${upcomingId}`);
  await expect(joiner.page.getByRole('link', { name: 'Join this swap' })).toHaveCount(0);

  for (const u of [mgr, joiner, second]) await u.context.close();
});

test('any signed-in user can join a swap, including its manager and admins', async ({ browser }) => {
  const mgr = await newSignedInUser(browser, 'anymgr');
  const plain = await newSignedInUser(browser, 'anyplain');
  await makeSwapManager(mgr.email);
  const title = `Everyone ${Date.now()}`;
  const swapId = (await (await mgr.page.request.post('/api/swaps', { data: swapWithWindow(title, -1, 5) })).json()).swap.swapId;

  // A plain user, the swap's own manager, and an admin all join.
  expect((await joinSwap(plain.page, swapId)).status()).toBe(200);
  await joinThroughPage(mgr.page, swapId);
  expect((await joinSwap(admin, swapId)).status()).toBe(200);

  const listed = await members(mgr.page, swapId);
  expect(listed.body.members.map((m: { email: string }) => m.email).sort()).toEqual([ADMIN_EMAIL, mgr.email, plain.email].sort());

  // The manager still manages the swap, and it is still under "My swaps".
  await mgr.page.reload();
  await expect(mgr.page.getByRole('link', { name: 'Edit this swap' })).toBeVisible();
  expect((await mgr.page.request.put(`/api/swaps/${swapId}`, { data: swapWithWindow(`${title} (edited)`, -1, 5) })).status()).toBe(200);
  await mgr.page.goto('/manage/swaps');
  await expect(mgr.page.getByRole('listitem', { name: `${title} (edited)` })).toBeVisible();

  // Leaving drops only the participant row: the manager keeps managing, and the admin is unaffected.
  await mgr.page.goto(`/swaps/${swapId}`);
  await mgr.page.getByRole('button', { name: 'Leave this swap' }).click();
  await expect(mgr.page.getByRole('link', { name: 'Join this swap' })).toBeVisible();
  await expect(mgr.page.getByRole('link', { name: 'Edit this swap' })).toBeVisible();
  expect((await members(mgr.page, swapId)).body.total).toBe(2);
  await admin.request.delete(`/api/swaps/${swapId}/membership`);

  for (const u of [mgr, plain]) await u.context.close();
});

test('the home page shows "Swaps You\'ve Joined" and "Swaps You Own" only when they have swaps', async ({ browser }) => {
  const mgr = await newSignedInUser(browser, 'homemgr');
  const plain = await newSignedInUser(browser, 'homeplain');
  await makeSwapManager(mgr.email);
  const title = `Home ${Date.now()}`;
  const swapId = (await (await mgr.page.request.post('/api/swaps', { data: swapWithWindow(title, -1, 5) })).json()).swap.swapId;

  const joinedHeading = plain.page.getByRole('heading', { name: "Swaps You've Joined" });
  const ownHeading = (p: Page) => p.getByRole('heading', { name: 'Swaps You Own' });

  // A new user has neither section.
  await plain.page.goto('/');
  await expect(plain.page.getByRole('heading', { name: /^Hello, / })).toBeVisible();
  await expect(joinedHeading).toHaveCount(0);
  await expect(ownHeading(plain.page)).toHaveCount(0);

  // Joining adds the joined section only.
  expect((await joinSwap(plain.page, swapId)).status()).toBe(200);
  await plain.page.goto('/');
  await expect(joinedHeading).toBeVisible();
  await expect(plain.page.getByRole('listitem', { name: `Swaps You've Joined: ${title}` })).toBeVisible();
  await expect(ownHeading(plain.page)).toHaveCount(0);

  // The owner sees "Swaps You Own" but no joined section until they join their own swap.
  await mgr.page.goto('/');
  await expect(ownHeading(mgr.page)).toBeVisible();
  await expect(mgr.page.getByRole('listitem', { name: `Swaps You Own: ${title}` })).toBeVisible();
  await expect(mgr.page.getByRole('heading', { name: "Swaps You've Joined" })).toHaveCount(0);
  expect((await joinSwap(mgr.page, swapId)).status()).toBe(200);
  await mgr.page.goto('/');
  await expect(mgr.page.getByRole('heading', { name: "Swaps You've Joined" })).toBeVisible();
  await expect(ownHeading(mgr.page)).toBeVisible();

  // Leaving hides the joined section again.
  expect((await plain.page.request.delete(`/api/swaps/${swapId}/membership`)).status()).toBe(204);
  await plain.page.goto('/');
  await expect(plain.page.getByRole('heading', { name: /^Hello, / })).toBeVisible();
  await expect(joinedHeading).toHaveCount(0);

  for (const u of [mgr, plain]) await u.context.close();
});
