import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { currentUser, signIn } from '../helpers/auth';
import { uniqueEmail } from '../helpers/mailpit';

// Listed in ADMIN_EMAILS by docker-compose.yml.
const ADMIN_EMAIL = 'admin@example.test';

test.describe.configure({ mode: 'serial' });

let adminContext: BrowserContext;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  // Sign the admin in once per run (sign-in emails are rate limited per address).
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

async function findUserRow(page: Page, email: string) {
  await page.getByLabel('Find a person by email or name').fill(email);
  await page.getByRole('button', { name: 'Search' }).click();
  const row = page.getByRole('listitem', { name: email });
  await expect(row).toHaveCount(1);
  return row;
}

test('a regular user cannot reach the admin page or API', async ({ browser }) => {
  const { page, context } = await newSignedInUser(browser, 'plain');
  expect((await currentUser(page)).body.user.roles).toEqual([]);
  await expect(page.getByRole('link', { name: 'Manage user roles' })).toHaveCount(0);

  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  const grant = await page.request.put(`/api/admin/users/${(await currentUser(page)).body.user.userId}/roles/admin`, {
    data: {},
  });
  expect(grant.status()).toBe(403);

  await page.goto('/admin/users');
  await expect(page.getByText("You don't have access to this page.")).toBeVisible();
  await context.close();
});

test('an ADMIN_EMAILS user is an admin and can grant and remove Swap Manager', async ({ browser }) => {
  expect((await currentUser(admin)).body.user.roles).toEqual(['admin']);

  const member = await newSignedInUser(browser, 'manager');

  await admin.goto('/');
  await admin.getByRole('link', { name: 'Manage user roles' }).click();
  await expect(admin.getByRole('heading', { name: 'User roles' })).toBeVisible();

  const row = await findUserRow(admin, member.email);
  const swapManager = row.getByRole('checkbox', { name: 'Swap Manager' });
  await expect(swapManager).not.toBeChecked();

  await swapManager.click(); // the box updates once the server confirms
  await expect(swapManager).toBeChecked();
  expect((await currentUser(member.page)).body.user.roles).toEqual(['swap_manager']);

  // Survives a reload (it was saved, not just toggled in the page).
  await admin.reload();
  await expect((await findUserRow(admin, member.email)).getByRole('checkbox', { name: 'Swap Manager' })).toBeChecked();

  const again = (await findUserRow(admin, member.email)).getByRole('checkbox', { name: 'Swap Manager' });
  await again.click();
  await expect(again).not.toBeChecked();
  expect((await currentUser(member.page)).body.user.roles).toEqual([]);

  await member.context.close();
});

test('an admin cannot remove their own Admin role', async () => {
  await admin.goto('/admin/users');
  const row = await findUserRow(admin, ADMIN_EMAIL);
  await expect(row.getByRole('checkbox', { name: 'Admin', exact: true })).toBeDisabled();
  await expect(row.getByText('Admin is set by the ADMIN_EMAILS setting.')).toBeVisible();

  const { userId } = (await currentUser(admin)).body.user;
  const res = await admin.request.delete(`/api/admin/users/${userId}/roles/admin`, { data: {} });
  expect(res.status()).toBe(400);
  expect((await currentUser(admin)).body.user.roles).toEqual(['admin']);
});
