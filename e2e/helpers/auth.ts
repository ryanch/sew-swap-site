import { expect, type Page } from '@playwright/test';
import { listEmailIds, waitForLoginEmail } from './mailpit';

export async function requestSignInLink(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

/** The email's link points at APP_BASE_URL (localhost:5173), so open the same path on our baseURL. */
export async function openSignInLink(page: Page, token: string) {
  await page.goto(`/login/verify?token=${encodeURIComponent(token)}`);
}

export async function currentUser(page: Page) {
  const res = await page.request.get('/api/auth/me');
  return { status: res.status(), body: res.ok() ? await res.json() : null };
}

/** Full email-link sign-in. Ignores older mail, so it works for addresses reused across runs. */
export async function signIn(page: Page, email: string) {
  const excludeIds = await listEmailIds(email);
  await requestSignInLink(page, email);
  const mail = await waitForLoginEmail(email, { excludeIds });
  await openSignInLink(page, mail.token);
  await expect(page.getByRole('heading', { name: /^Hello, / })).toBeVisible();
}
