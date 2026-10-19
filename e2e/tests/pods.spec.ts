import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from '../helpers/auth';
import { uniqueEmail } from '../helpers/mailpit';
import { uniqueHandle, US_ADDRESS } from '../helpers/signup';

const ADMIN_EMAIL = 'admin@example.test';

test.describe.configure({ mode: 'serial' });

type Maker = { key: string; name: string; email: string; handle: string; userId: string; context: BrowserContext; page: Page };

let adminContext: BrowserContext;
let admin: Page;
let swapId: string;
const makers: Record<string, Maker> = {};
let fran: Maker;
const run = Date.now().toString(36);

const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const NY = { ...US_ADDRESS, city: 'New York', region: 'NY', postalCode: '10001' };
const CA = { ...US_ADDRESS, city: 'Oakland', region: 'CA', postalCode: '94607' };

// The six who get paired, plus two more who stay in Default (so one person can be given 5 to make for).
const PEOPLE: [string, typeof US_ADDRESS][] = [
  ['Jane', US_ADDRESS],
  ['Monica', US_ADDRESS],
  ['Fran', US_ADDRESS],
  ['John', NY],
  ['Ana', NY],
  ['Bo', CA],
  ['Extra1', NY],
  ['Extra2', NY],
];
const LOOP = ['Jane', 'Monica', 'Fran', 'John', 'Ana', 'Bo'];

async function newMaker(browser: Browser, key: string, address: typeof US_ADDRESS): Promise<Maker> {
  const email = uniqueEmail(key.toLowerCase());
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  const handle = uniqueHandle(key.toLowerCase());
  expect((await page.request.post('/api/me/instagram/check', { data: { input: handle } })).status()).toBe(200);
  const name = `${key} ${run}`;
  const joined = await page.request.put(`/api/swaps/${swapId}/membership`, { data: { address: { ...address, name } } });
  expect(joined.status()).toBe(200);
  const userId = (await (await page.request.get('/api/auth/me')).json()).user.userId as string;
  return { key, name, email, handle, userId, context, page };
}

const members = async (query = '') => (await (await admin.request.get(`/api/swaps/${swapId}/members?limit=500${query}`)).json()).members;
const member = async (key: string) =>
  (await (await admin.request.get(`/api/swaps/${swapId}/members/${makers[key].userId}`)).json()).member;
const createPod = async (name: string) =>
  (await (await admin.request.post(`/api/swaps/${swapId}/pods`, { data: { name } })).json()).pod.podId as string;
const movePeople = (podId: string, keys: string[]) =>
  admin.request.put(`/api/swaps/${swapId}/pods/${podId}/members`, { data: { userIds: keys.map((k) => makers[k].userId) } });

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext();
  admin = await adminContext.newPage();
  await signIn(admin, ADMIN_EMAIL);
  const res = await admin.request.post('/api/swaps', {
    data: {
      title: `Pods ${run}`,
      description: 'Make a pincushion.',
      signUpOpens: day(-1),
      signUpCloses: day(5),
      partnersAnnounced: day(7),
      makingDeadline: day(30),
      shipBy: day(35),
    },
  });
  swapId = (await res.json()).swap.swapId;
  for (const [key, address] of PEOPLE) makers[key] = await newMaker(browser, key, address);
});

test.afterAll(async () => {
  await adminContext.close();
  for (const m of Object.values(makers)) await m.context.close();
});

test("participants can't see skill, pods or pairings", async () => {
  const { page } = makers.Jane;
  for (const path of ['members', 'pods', 'export.csv', `members/${makers.Monica.userId}`]) {
    expect((await page.request.get(`/api/swaps/${swapId}/${path}`)).status(), path).toBe(403);
  }
  expect((await page.request.post(`/api/swaps/${swapId}/pods`, { data: { name: 'Mine' } })).status()).toBe(403);
  const put = await page.request.put(`/api/swaps/${swapId}/assignments/${makers.Jane.userId}/${makers.Monica.userId}`, { data: {} });
  expect(put.status()).toBe(403);
  // The swap list shows how many signed up only to people who manage the swap.
  await page.goto('/swaps');
  await expect(page.getByRole('listitem', { name: `Pods ${run}` })).toBeVisible();
  await expect(page.getByText(/Swappers:/)).toHaveCount(0);
  await admin.goto('/swaps');
  await expect(admin.getByRole('listitem', { name: `Pods ${run}` }).getByText('Swappers: 8')).toBeVisible();
  await admin.goto('/manage/swaps');
  await expect(admin.getByRole('listitem', { name: `Pods ${run}` }).getByText('Swappers: 8')).toBeVisible();
  const detail = JSON.stringify(await (await page.request.get(`/api/swaps/${swapId}`)).json());
  expect(detail).not.toMatch(/"(skillLevel|pod|makingFor|madeBy)"/);
});

test('everyone starts in Default; the manager rates skill and fills a pod', async () => {
  await admin.goto(`/swaps/${swapId}`);
  await admin.getByRole('link', { name: 'Pods and pairings' }).click();
  await expect(admin.getByRole('listitem', { name: 'Default' })).toContainText('8 people');

  // Rating skill sits next to the person's Instagram link.
  await admin.getByRole('listitem', { name: 'Default' }).getByRole('link', { name: 'Default' }).click();
  const jane = admin.getByRole('listitem', { name: makers.Jane.email });
  await expect(jane.getByRole('link', { name: `@${makers.Jane.handle}` })).toHaveAttribute(
    'href',
    `https://www.instagram.com/${makers.Jane.handle}/`,
  );
  await jane.getByLabel(`Skill level for ${makers.Jane.name}`).selectOption('1');
  await expect.poll(async () => (await member('Jane')).skillLevel).toBe(1);
  await admin.reload();
  await expect(admin.getByLabel(`Skill level for ${makers.Jane.name}`)).toHaveValue('1');

  // Make a pod, and an empty one still opens.
  await admin.getByRole('link', { name: '← All pods' }).click();
  await admin.getByLabel('New pod name').fill('Chicago');
  await admin.getByRole('button', { name: 'Create pod' }).click();
  await admin.getByRole('link', { name: 'Chicago' }).click();
  await expect(admin.getByRole('heading', { name: 'Chicago' })).toBeVisible();
  await expect(admin.getByText('No one is in this pod yet.')).toBeVisible();

  // Quick add finds people by name.
  await admin.getByLabel('Find a person to add to this pod').fill(makers.Jane.name);
  await admin.getByRole('button', { name: 'Search' }).click();
  await admin.getByRole('listitem', { name: makers.Jane.email }).getByRole('button', { name: 'Add to this pod' }).click();
  await expect(admin.getByText('1 person in this pod.')).toBeVisible();

  // Bulk add everyone in Illinois who isn't in a pod yet: Monica and Fran (Jane is already here).
  await admin.getByLabel('Country').selectOption('US');
  await admin.getByLabel('State or region').selectOption('IL');
  await admin.getByRole('button', { name: 'Find people' }).click();
  await expect(admin.getByText('2 people match.')).toBeVisible();
  await admin.getByRole('button', { name: 'Add these 2 people' }).click();
  await expect(admin.getByText('3 people in this pod.')).toBeVisible();
  for (const key of ['Jane', 'Monica', 'Fran']) {
    await expect(admin.getByRole('region', { name: 'People in this pod' }).getByRole('listitem', { name: makers[key].email })).toBeVisible();
  }

  // Skill narrows a bulk search: only Jane is rated 1, and she's already in this pod.
  await admin.getByLabel('Skill level', { exact: true }).selectOption('1');
  await admin.getByRole('button', { name: 'Find people' }).click();
  await expect(admin.getByText('No one matches.')).toBeVisible();
});

test('splitting a pod makes even pods named after it', async () => {
  const big = await createPod('Big');
  expect((await movePeople(big, LOOP)).status()).toBe(200);
  await admin.goto(`/manage/swaps/${swapId}/pods/${big}`);
  await admin.getByRole('button', { name: 'Split into smaller pods' }).click();
  await admin.getByLabel('How many people in each pod?').fill('4');
  await expect(admin.getByText('This makes 2 pods with 3, 3 people')).toBeVisible();
  await admin.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(admin.getByText('Split Big into 2 pods: Big 1 (3), Big 2 (3).')).toBeVisible();
  await expect(admin.getByRole('listitem', { name: 'Big', exact: true })).toHaveCount(0);
  await expect(admin.getByRole('listitem', { name: 'Big 1' })).toContainText('3 people');
  // Jane is the only one rated, at 1 (Beginner), so she sorts first.
  expect((await member('Jane')).pod.name).toBe('Big 1');
});

test('auto-assign keeps pairings the manager made and closes the loop', async () => {
  const loop = await createPod('Loop');
  await movePeople(loop, LOOP);

  // By hand first: Jane makes for Monica.
  await admin.goto(`/manage/swaps/${swapId}/members/${makers.Jane.userId}`);
  await admin.getByLabel(`Find someone for ${makers.Jane.name} to make for`).fill(makers.Monica.handle);
  await admin.getByRole('button', { name: 'Search' }).click();
  await admin.getByRole('button', { name: `Make for ${makers.Monica.name}` }).click();
  await expect(admin.getByRole('listitem', { name: makers.Monica.name })).toBeVisible();

  await admin.goto(`/manage/swaps/${swapId}/pods/${loop}`);
  await admin.getByRole('button', { name: 'Auto-assign makers' }).click();
  await expect(admin.getByText('Added 5 pairings.')).toBeVisible();

  const inLoop = (await members(`&pod=${loop}`)) as { userId: string; makingFor: { userId: string }[]; madeBy: unknown[] }[];
  expect(inLoop).toHaveLength(6);
  for (const m of inLoop) expect([m.makingFor.length, m.madeBy.length]).toEqual([1, 1]);
  expect((await member('Jane')).makingFor.map((p: { userId: string }) => p.userId)).toEqual([makers.Monica.userId]);
  // Following the pairings from Jane visits all six before coming back.
  const next = new Map(inLoop.map((m) => [m.userId, m.makingFor[0].userId]));
  const seen = new Set<string>();
  for (let cur = makers.Jane.userId; !seen.has(cur); cur = next.get(cur)!) seen.add(cur);
  expect(seen.size).toBe(6);

  // Running it again changes nothing.
  await admin.getByRole('button', { name: 'Auto-assign makers' }).click();
  await expect(admin.getByText('Nothing to add')).toBeVisible();
});

test('when someone drops out, the manager sees who needs a maker and fixes it', async () => {
  const janesMaker = (await member('Jane')).madeBy[0].userId as string;
  expect((await makers.Jane.page.request.delete(`/api/swaps/${swapId}/membership`)).status()).toBe(204);

  await admin.goto(`/manage/swaps/${swapId}/members`);
  await admin.getByLabel('Show').selectOption('maker');
  const monicaRow = admin.getByRole('listitem', { name: makers.Monica.email });
  await expect(monicaRow.getByText('Nobody is making for them')).toBeVisible();
  // The two extras were never paired, so they show up too.
  await expect(admin.getByText('3 people.')).toBeVisible();
  const lonelyMakers = (await members('&needs=recipient')).map((m: { userId: string }) => m.userId);
  expect(lonelyMakers).toContain(janesMaker);

  // Someone who still makes for one person (the loop is shuffled, so not always Fran) agrees to make
  // for Monica as well.
  fran = LOOP.map((k) => makers[k]).find((m) => !['Jane', 'Monica'].includes(m.key) && m.userId !== janesMaker)!;
  await admin.goto(`/manage/swaps/${swapId}/members/${fran.userId}`);
  await admin.getByLabel(`Find someone for ${fran.name} to make for`).fill(makers.Monica.name);
  await admin.getByRole('button', { name: 'Search' }).click();
  await admin.getByRole('button', { name: `Make for ${makers.Monica.name}` }).click();
  await expect(admin.getByRole('button', { name: `Stop making for ${makers.Monica.name}` })).toBeVisible();
  expect((await member(fran.key)).makingFor).toHaveLength(2);
  expect((await member('Monica')).madeBy.map((p: { userId: string }) => p.userId)).toEqual([fran.userId]);

  // The CSV shows both, with a clickable Instagram link.
  const csv = await (await admin.request.get(`/api/swaps/${swapId}/export.csv`)).text();
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  expect(lines[0]).toBe(
    'Name,Email,Instagram,Instagram link,Instagram confirmed,Name on package,Address line 1,Address line 2,City,State/Region,Postal code,Country,Pod,Skill level,' +
      'Making For,Make Confirmed,Make Shipped,Make Tracking,Make Tracking link,' +
      'Making For 2,Make 2 Confirmed,Make 2 Shipped,Make 2 Tracking,Make 2 Tracking link,' +
      'Making For 3,Make 3 Confirmed,Make 3 Shipped,Make 3 Tracking,Make 3 Tracking link,' +
      'Making For 4,Make 4 Confirmed,Make 4 Shipped,Make 4 Tracking,Make 4 Tracking link,' +
      'Making For 5,Make 5 Confirmed,Make 5 Shipped,Make 5 Tracking,Make 5 Tracking link,Made by',
  );
  expect(lines).toHaveLength(1 + 7);
  const franRow = lines.find((l) => l.startsWith(fran.name))!.split(',');
  expect(franRow[3]).toBe(`https://www.instagram.com/${fran.handle}/`);
  expect(franRow[12]).toBe('Loop');
  // Columns 14-38 give each person Fran makes for 5 columns: who, confirmed, shipped, tracking and
  // its link (not confirmed or shipped yet: nothing is published).
  const slots = [14, 19, 24, 29, 34];
  const makingFor = slots.map((i) => franRow[i]);
  expect(makingFor.filter(Boolean)).toHaveLength(2);
  expect(makingFor).toContain(`${makers.Monica.name} (@${makers.Monica.handle})`);
  expect(slots.map((i) => franRow[i + 1])).toEqual(['No', 'No', '', '', '']);
  expect(slots.map((i) => franRow[i + 2])).toEqual(['No', 'No', '', '', '']);
});

test('auto-assign pairs a pod of two both ways', async () => {
  const pair = await createPod('Pair');
  await movePeople(pair, ['Extra1', 'Extra2']);
  await admin.goto(`/manage/swaps/${swapId}/pods/${pair}`);
  await admin.getByRole('button', { name: 'Auto-assign makers' }).click();
  await expect(admin.getByText('Added 2 pairings.')).toBeVisible();
  await expect(admin.getByText('Still to sort out')).toHaveCount(0);
  const [one, two] = [await member('Extra1'), await member('Extra2')];
  expect(one.makingFor.map((p: { userId: string }) => p.userId)).toEqual([makers.Extra2.userId]);
  expect(two.makingFor.map((p: { userId: string }) => p.userId)).toEqual([makers.Extra1.userId]);
});

test('a maker can make for up to 5 people, and never themselves', async () => {
  const name = fran.name;
  const key = fran.key;
  const userId = fran.userId;
  const assign = (to: string) => admin.request.put(`/api/swaps/${swapId}/assignments/${userId}/${to}`, { data: {} });
  expect((await assign(userId)).status()).toBe(400);
  const current = new Set((await member(key)).makingFor.map((p: { userId: string }) => p.userId));
  const others = Object.values(makers)
    .filter((m) => m.key !== 'Jane' && m.userId !== userId && !current.has(m.userId))
    .map((m) => m.userId);
  for (const to of others.slice(0, 5 - current.size)) expect((await assign(to)).status()).toBe(200);
  const sixth = await assign(others[5 - current.size]);
  expect(sixth.status()).toBe(400);
  expect((await sixth.json()).error).toBe(`${name} already makes for 5 people.`);
});
