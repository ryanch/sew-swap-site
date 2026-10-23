import { expect, type Page } from '@playwright/test';

// The API runs the `fakePost` Instagram strategy locally: a post's shortcode is its owner's name.
// Shortcodes starting with "nosuch" or "private" can't be read, and "exists" or "unknown" act as if
// Instagram is blocking us, so the person types their name and the `fake` strategy answers by its prefix.
export const US_ADDRESS = {
  firstName: 'Pat',
  lastName: 'Maker',
  name: 'Pat Maker',
  line1: '1 Main St',
  line2: '',
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US',
};

/** First, last and full name fields for an address. One word gets a last name of "Sew". */
export function nameFields(full: string) {
  const [firstName, ...rest] = full.split(' ');
  const lastName = rest.join(' ') || 'Sew';
  return { firstName, lastName, name: `${firstName} ${lastName}` };
}

export const uniqueHandle = (prefix = 'maker') => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** A link to a post owned by `handle` (to the fake strategy). */
export const postLink = (handle: string) => `https://www.instagram.com/p/${handle}/?utm_source=ig_web_copy_link`;

/**
 * Joins through the API with a public Instagram and a US address. Skips the Instagram check
 * when the person already has a current one, since checks are rate limited.
 */
export async function joinSwap(page: Page, swapId: string) {
  const profile = await (await page.request.get('/api/me/profile')).json();
  if (!profile.instagram?.current || profile.instagram.result !== 'public') {
    const check = await page.request.post('/api/me/instagram/check', { data: { input: postLink(uniqueHandle()) } });
    expect(check.status()).toBe(200);
  }
  return page.request.put(`/api/swaps/${swapId}/membership`, { data: { address: US_ADDRESS } });
}

/** Fills the US address fields on the sign-up page. */
export async function fillUsAddress(page: Page) {
  await page.getByLabel('Country').selectOption('US');
  await page.getByLabel('First name').fill(US_ADDRESS.firstName);
  await page.getByLabel('Last name').fill(US_ADDRESS.lastName);
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
  await page.getByLabel('A link to one of your Instagram posts').fill(postLink(uniqueHandle()));
  // A recent check (from an earlier join) makes the button count down first.
  await expect(checkButton(page)).toBeEnabled({ timeout: 15_000 });
  await checkButton(page).click();
  await expect(page.getByText(/and the account is public/)).toBeVisible();
  await page.getByRole('button', { name: 'Join this swap' }).click();
  await expect(page.getByText("You've joined this swap.")).toBeVisible();
}
