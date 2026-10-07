import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { currentUser, signIn } from '../helpers/auth';
import { uniqueEmail } from '../helpers/mailpit';

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
  signUpOpens: '2026-11-01',
  signUpCloses: '2026-11-15',
  partnersAnnounced: '2026-11-20',
  makingDeadline: '2026-12-10',
  shipBy: '2026-12-15',
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
  await mgr.page.getByLabel('Sign-up opens').fill('2026-11-01');
  await mgr.page.getByLabel('Sign-up closes').fill('2026-11-15');
  await mgr.page.getByLabel('Partners announced').fill('2026-11-20');
  await mgr.page.getByLabel('Making deadline').fill('2026-12-10');
  await mgr.page.getByLabel('Ship by').fill('2026-12-15');
  await mgr.page.getByRole('button', { name: 'Create swap' }).click();
  await expect(mgr.page.getByRole('heading', { name: title })).toBeVisible();
  const swapId = mgr.page.url().split('/').pop()!;

  // A regular user browses to it and sees a disabled Join button and no Edit link.
  await plain.page.goto('/');
  await plain.page.getByRole('link', { name: 'Browse swaps' }).click();
  await plain.page.getByRole('listitem', { name: title }).getByRole('link', { name: 'View details' }).click();
  await expect(plain.page.getByRole('heading', { name: title })).toBeVisible();
  await expect(plain.page.getByText('December 15, 2026')).toBeVisible();
  await expect(plain.page.getByRole('button', { name: 'Join this swap' })).toBeDisabled();
  await expect(plain.page.getByRole('link', { name: 'Edit this swap' })).toHaveCount(0);
  expect((await plain.page.request.put(`/api/swaps/${swapId}`, { data: swapBody('Hijack') })).status()).toBe(403);

  // The manager edits it.
  await mgr.page.getByRole('link', { name: 'Edit this swap' }).click();
  await mgr.page.getByLabel('Title').fill(`${title} (updated)`);
  await mgr.page.getByLabel('Ship by').fill('2026-12-20');
  await mgr.page.getByRole('button', { name: 'Save changes' }).click();
  await expect(mgr.page.getByRole('heading', { name: `${title} (updated)` })).toBeVisible();
  await expect(mgr.page.getByText('December 20, 2026')).toBeVisible();

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
    data: { ...swapBody('Backwards'), signUpOpens: '2026-11-15', signUpCloses: '2026-11-01' },
  });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatch(/close/);
  expect((await mgr.page.request.post('/api/swaps', { data: { ...swapBody(''), title: '' } })).status()).toBe(400);
  expect((await currentUser(mgr.page)).body.user.roles).toEqual(['swap_manager']);

  for (const u of [plain, mgr, other]) await u.context.close();
});
