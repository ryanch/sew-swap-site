import { expect, type Page } from '@playwright/test';

// The API runs the `fake` Instagram strategy locally: names starting with "private", "nosuch",
// "exists" or "unknown" get that answer, and anything else is public.
export const US_ADDRESS = {
  name: 'Pat Maker',
  line1: '1 Main St',
  line2: '',
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US',
};

export const uniqueHandle = (prefix = 'maker') => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Joins through the API with a public Instagram and a US address. Skips the Instagram check
 * when the person already has a current one, since checks are rate limited.
 */
export async function joinSwap(page: Page, swapId: string) {
  const profile = await (await page.request.get('/api/me/profile')).json();
  if (!profile.instagram?.current || profile.instagram.result !== 'public') {
    const check = await page.request.post('/api/me/instagram/check', { data: { input: uniqueHandle() } });
    expect(check.status()).toBe(200);
  }
  return page.request.put(`/api/swaps/${swapId}/membership`, { data: { address: US_ADDRESS } });
}

/** Fills the US address fields on the sign-up page. */
export async function fillUsAddress(page: Page) {
  await page.getByLabel('Country').selectOption('US');
  await page.getByLabel('Name on the package').fill(US_ADDRESS.name);
  await page.getByLabel('Street address').fill(US_ADDRESS.line1);
  await page.getByLabel('City').fill(US_ADDRESS.city);
  await page.getByLabel('State').selectOption(US_ADDRESS.region);
  await page.getByLabel('ZIP code').fill(US_ADDRESS.postalCode);
}

export const checkButton = (page: Page) => page.getByRole('button', { name: /Check my Instagram|Try again/ });

/** Signs up from the swap's page: Join, fill in the form, check Instagram, and join. */
export async function joinThroughPage(page: Page, swapId: string) {
  await page.goto(`/swaps/${swapId}`);
  await page.getByRole('link', { name: 'Join this swap' }).click();
  await fillUsAddress(page);
  await page.getByLabel('Your Instagram name').fill(uniqueHandle());
  // A recent check (from an earlier join) makes the button count down first.
  await expect(checkButton(page)).toBeEnabled({ timeout: 15_000 });
  await checkButton(page).click();
  await expect(page.getByText(/and it's public/)).toBeVisible();
  await page.getByRole('button', { name: 'Join this swap' }).click();
  await expect(page.getByText("You've joined this swap.")).toBeVisible();
}
