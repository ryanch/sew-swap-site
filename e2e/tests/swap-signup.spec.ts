import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from '../helpers/auth';
import { uniqueEmail } from '../helpers/mailpit';
import { checkButton, fillUsAddress, uniqueHandle, US_ADDRESS } from '../helpers/signup';

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

const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** An open swap, created by the admin (who manages every swap). */
async function openSwap(title: string) {
  const res = await admin.request.post('/api/swaps', {
    data: {
      title,
      description: 'Make something small.',
      signUpOpens: day(-1),
      signUpCloses: day(5),
      partnersAnnounced: day(7),
      makingDeadline: day(30),
      shipBy: day(35),
    },
  });
  return (await res.json()).swap.swapId as string;
}

const check = (page: Page, input: string) => page.request.post('/api/me/instagram/check', { data: { input } });
const join = (page: Page, swapId: string, data: object) => page.request.put(`/api/swaps/${swapId}/membership`, { data });

test('signing up cleans up the Instagram name and makes the person fix a bad one', async ({ browser }) => {
  const user = await newSignedInUser(browser, 'signup');
  const title = `Sign-up ${Date.now()}`;
  const swapId = await openSwap(title);
  const { page } = user;

  await page.goto(`/swaps/${swapId}`);
  await page.getByRole('link', { name: 'Join this swap' }).click();
  await expect(page.getByRole('heading', { name: `Sign up for ${title}` })).toBeVisible();
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
  const joinButton = page.getByRole('button', { name: 'Join this swap' });
  await expect(joinButton).toBeDisabled();
  await fillUsAddress(page);

  // A pasted profile link with a trailing space becomes the bare name, and the page says so.
  const handle = uniqueHandle('jane');
  const igInput = page.getByLabel('Your Instagram name');
  await igInput.fill(`https://www.instagram.com/${handle} `);
  await checkButton(page).click();
  await expect(page.getByText(`We changed what you typed to ${handle}`)).toBeVisible();
  await expect(igInput).toHaveValue(handle);
  await expect(page.getByText(`We found @${handle} and it's public.`)).toBeVisible();

  // The button waits before another check, and the API refuses rapid checks too.
  await expect(page.getByRole('button', { name: /Try again in \d+s/ })).toBeDisabled();
  const tooSoon = await check(page, handle);
  expect(tooSoon.status()).toBe(429);
  expect((await tooSoon.json()).retryAfterSeconds).toBeGreaterThan(0);

  // A misspelled name: guidance, and no joining.
  await igInput.fill(uniqueHandle('nosuch'));
  await expect(joinButton).toBeDisabled();
  await expect(checkButton(page)).toBeEnabled({ timeout: 15_000 });
  await checkButton(page).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText("We couldn't find a public Instagram account");
  await expect(alert).toContainText('Check the spelling');
  await expect(alert).toContainText('needs to be public');
  await expect(joinButton).toBeDisabled();

  // A private account: the same guidance. The failed check also clears the earlier pass on the server.
  await igInput.fill(uniqueHandle('private'));
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toContainText('is a private account');
  await expect(joinButton).toBeDisabled();
  const sneaky = await join(page, swapId, { address: US_ADDRESS });
  expect(sneaky.status()).toBe(400);
  expect((await sneaky.json()).error).toMatch(/Instagram/);

  // Fixed: it joins.
  await igInput.fill(handle);
  await expect(checkButton(page)).toBeEnabled({ timeout: 15_000 });
  await checkButton(page).click();
  await expect(page.getByText(`We found @${handle} and it's public.`)).toBeVisible();
  await joinButton.click();
  await expect(page.getByText("You've joined this swap.")).toBeVisible();

  // The manager sees the confirmed Instagram on the members list.
  await admin.goto(`/manage/swaps/${swapId}/members`);
  const row = admin.getByRole('listitem', { name: user.email });
  await expect(row.getByRole('link', { name: `@${handle}` })).toBeVisible();
  await expect(row.getByText('Instagram unconfirmed')).toHaveCount(0);

  // Their details are saved, so the next swap's form is filled in and ready.
  const nextId = await openSwap(`Next ${Date.now()}`);
  await page.goto(`/swaps/${nextId}/join`);
  await expect(page.getByLabel('Street address')).toHaveValue(US_ADDRESS.line1);
  await expect(page.getByLabel('State')).toHaveValue(US_ADDRESS.region);
  await expect(igInput).toHaveValue(handle);
  await expect(page.getByText(`We found @${handle} and it's public.`)).toBeVisible();
  await page.getByRole('button', { name: 'Join this swap' }).click();
  await expect(page.getByText("You've joined this swap.")).toBeVisible();

  await user.context.close();
});

test("an Instagram we can't confirm needs the person to say it's public, and is flagged", async ({ browser }) => {
  const user = await newSignedInUser(browser, 'unconfirmed');
  const swapId = await openSwap(`Unconfirmed ${Date.now()}`);
  const { page } = user;
  const handle = uniqueHandle('unknown');

  await page.goto(`/swaps/${swapId}/join`);
  await fillUsAddress(page);
  await page.getByLabel('Your Instagram name').fill(handle);
  await checkButton(page).click();
  await expect(page.getByText(`We couldn't confirm that @${handle} is public.`)).toBeVisible();
  const joinButton = page.getByRole('button', { name: 'Join this swap' });
  await expect(joinButton).toBeDisabled();

  // The API insists on the box too.
  expect((await join(page, swapId, { address: US_ADDRESS })).status()).toBe(400);

  await page.getByLabel("I've checked that my Instagram account is public").check();
  await joinButton.click();
  await expect(page.getByText("You've joined this swap.")).toBeVisible();

  await admin.goto(`/manage/swaps/${swapId}/members`);
  const row = admin.getByRole('listitem', { name: user.email });
  await expect(row.getByRole('link', { name: `@${handle}` })).toBeVisible();
  await expect(row.getByText('Instagram unconfirmed')).toBeVisible();

  await user.context.close();
});

test('joining needs a valid address for the country and a checked Instagram', async ({ browser }) => {
  const user = await newSignedInUser(browser, 'address');
  const swapId = await openSwap(`Address ${Date.now()}`);
  const { page } = user;

  // Nothing checked yet.
  const unchecked = await join(page, swapId, { address: US_ADDRESS });
  expect(unchecked.status()).toBe(400);
  expect((await unchecked.json()).error).toMatch(/Instagram/);

  // Not an Instagram name at all: refused before anyone asks Instagram.
  const bad = await check(page, 'jane smith');
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatch(/letters, numbers, periods and underscores/);

  expect((await check(page, `@${uniqueHandle()}`)).status()).toBe(200);
  const expectProblem = async (address: object, message: RegExp) => {
    const res = await join(page, swapId, { address });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(message);
  };
  await expectProblem({}, /first name/);
  await expectProblem({ ...US_ADDRESS, lastName: '' }, /last name/);
  await expectProblem({ ...US_ADDRESS, postalCode: '1234' }, /ZIP/);
  await expectProblem({ ...US_ADDRESS, region: 'ON' }, /state/);
  await expectProblem({ ...US_ADDRESS, country: 'CA', region: 'ON', postalCode: '12345' }, /postal code/);
  await expectProblem({ ...US_ADDRESS, country: 'GB', region: '', postalCode: '' }, /postal code/);

  // Canada: postal codes are tidied. Elsewhere, region and postal code are free text.
  expect((await join(page, swapId, { address: { ...US_ADDRESS, country: 'CA', region: 'ON', postalCode: 'k1a0b1' } })).status()).toBe(200);
  const saved = await (await page.request.get('/api/me/profile')).json();
  expect(saved.address).toMatchObject({ country: 'CA', region: 'ON', postalCode: 'K1A 0B1' });
  expect((await join(page, swapId, { address: { ...US_ADDRESS, country: 'GB', region: '', postalCode: 'SW1A 1AA' } })).status()).toBe(200);

  // The page shows the right fields for the saved country.
  await page.goto(`/swaps/${swapId}/join`);
  await expect(page.getByLabel('Country')).toHaveValue('GB');
  await expect(page.getByLabel('State, province, or region')).toBeVisible();
  await expect(page.getByLabel('Postal code')).toHaveValue('SW1A 1AA');
  await page.getByLabel('Country').selectOption('CA');
  await expect(page.getByLabel('Province or territory')).toBeVisible();

  await user.context.close();
});
