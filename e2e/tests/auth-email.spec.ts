import { expect, test } from '@playwright/test';
import { currentUser, openSignInLink, requestSignInLink } from '../helpers/auth';
import { uniqueEmail, waitForLoginEmail } from '../helpers/mailpit';

test('signup: a new email address gets an account via the email link', async ({ page }) => {
  const email = uniqueEmail('signup');

  // Signed-out visitors are sent to the login page.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await requestSignInLink(page, email);
  const mail = await waitForLoginEmail(email);
  expect(mail.text).toContain('/login/verify?token=');

  await openSignInLink(page, mail.token);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Welcome! Your account is ready.')).toBeVisible();
  await expect(page.getByRole('heading', { name: `Hello, ${email}` })).toBeVisible();

  const me = await currentUser(page);
  expect(me.status).toBe(200);
  expect(me.body.user.email).toBe(email);

  // Session survives a reload; the one-time welcome banner does not.
  await page.reload();
  await expect(page.getByRole('heading', { name: `Hello, ${email}` })).toBeVisible();
});

test('login: a returning user signs in with a new email link and keeps the same account', async ({ page }) => {
  const email = uniqueEmail('login');

  // Sign up first.
  await requestSignInLink(page, email);
  const first = await waitForLoginEmail(email);
  await openSignInLink(page, first.token);
  await expect(page.getByRole('heading', { name: `Hello, ${email}` })).toBeVisible();
  const { body: signedUp } = await currentUser(page);

  // Sign out.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await currentUser(page)).status).toBe(401);

  // Log back in with a fresh link.
  await requestSignInLink(page, email);
  const second = await waitForLoginEmail(email, { excludeIds: [first.id] });
  expect(second.token).not.toBe(first.token);
  await openSignInLink(page, second.token);

  await expect(page.getByRole('heading', { name: `Hello, ${email}` })).toBeVisible();
  await expect(page.getByText('Welcome! Your account is ready.')).toHaveCount(0);
  const { body: loggedIn } = await currentUser(page);
  expect(loggedIn.user.userId).toBe(signedUp.user.userId);
});

test('login: an email link only works once', async ({ page, browser }) => {
  const email = uniqueEmail('reuse');
  await requestSignInLink(page, email);
  const mail = await waitForLoginEmail(email);
  await openSignInLink(page, mail.token);
  await expect(page.getByRole('heading', { name: `Hello, ${email}` })).toBeVisible();

  // Same link in a fresh browser (no session cookie) is rejected.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await openSignInLink(otherPage, mail.token);
  await expect(otherPage.getByRole('alert')).toHaveText('This link has expired or was already used.');
  await expect(otherPage.getByRole('link', { name: 'Get a new sign-in link' })).toHaveAttribute('href', '/login');
  expect((await currentUser(otherPage)).status).toBe(401);
  await other.close();
});
