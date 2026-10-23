import { expect, test } from '@playwright/test';
import { adminUser, assign, checkInstagram, createSwap, newMember, newUser, parseCsv, runId, uniqueHandle, US_ADDRESS, type User } from '../helpers/api';

// The CSV export for a small swap where every cell is known: row order (Default first, then pods by
// name with numbers in order, then people by name) and each column's value.

test.describe.configure({ mode: 'serial' });

type Person = User & { handle: string; name: string };

let admin: User;
let swapId: string;
const run = runId();
const p = {} as Record<'amy' | 'bob' | 'cat' | 'dan' | 'zoe', Person>;

const EMPTY_MAKE = ['', '', '', '', ''];

test.beforeAll(async () => {
  admin = await adminUser();
  swapId = await createSwap(admin.api, `CSV data ${run}`);
  p.zoe = await (async () => {
    // Zoe's Instagram couldn't be confirmed, so it says "No".
    const user = await newUser('csvzoe');
    const handle = await checkInstagram(user.api, uniqueHandle('unknownzoe'));
    const address = { ...US_ADDRESS, name: 'Zoe' };
    expect((await user.api.put(`/api/swaps/${swapId}/membership`, { data: { address, instagramPublicConfirmed: true } })).status()).toBe(200);
    return { ...user, handle, name: 'Zoe' };
  })();
  p.amy = await newMember('csvamy', swapId, { ...US_ADDRESS, name: 'amy' });
  p.bob = await newMember('csvbob', swapId, { ...US_ADDRESS, name: 'Bob', line2: 'Unit 5' });
  p.cat = await newMember('csvcat', swapId, { ...US_ADDRESS, name: 'Cat', city: 'Toronto', region: 'ON', postalCode: 'M5V 2T6', country: 'CA' });
  // A name a spreadsheet would run as a formula, and an address with a comma and a quote.
  p.dan = await newMember('csvdan', swapId, { ...US_ADDRESS, name: '=Dan', line1: '5 Oak St, "Back"' });

  const pod = async (name: string, people: Person[]) => {
    const podId = (await (await admin.api.post(`/api/swaps/${swapId}/pods`, { data: { name } })).json()).pod.podId;
    await admin.api.put(`/api/swaps/${swapId}/pods/${podId}/members`, { data: { userIds: people.map((x) => x.userId) } });
  };
  await pod('Pod 10', [p.dan]);
  await pod('Pod 2', [p.cat, p.bob]);
  await admin.api.patch(`/api/swaps/${swapId}/members/${p.bob.userId}`, { data: { skillLevel: 3 } });
  // Bob makes for Cat and amy; amy and Zoe make for Bob.
  for (const [m, r] of [[p.bob, p.cat], [p.bob, p.amy], [p.amy, p.bob], [p.zoe, p.bob]]) {
    expect((await assign(admin.api, swapId, m.userId, r.userId)).status()).toBe(200);
  }
});

test.afterAll(async () => {
  await Promise.all([admin.api.dispose(), ...Object.values(p).map((u) => u.api.dispose())]);
});

test('the CSV lists Default first, then pods in number order, then people by name', async () => {
  const res = await admin.api.get(`/api/swaps/${swapId}/export.csv`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('text/csv; charset=utf-8');
  expect(res.headers()['content-disposition']).toBe(`attachment; filename="csv-data-${run}-makers.csv"`);
  const text = await res.text();
  expect(text.startsWith('﻿')).toBe(true);
  expect(text.endsWith('\r\n')).toBe(true);

  const [header, ...rows] = parseCsv(text);
  expect(header).toHaveLength(14 + 25 + 1);
  expect(rows.map((r) => [r[0], r[12]])).toEqual([
    ['amy', 'Default'],
    ['Zoe', 'Default'],
    ['Bob', 'Pod 2'],
    ['Cat', 'Pod 2'],
    ["'=Dan", 'Pod 10'],
  ]);
});

test('every column for each person', async () => {
  const rows = parseCsv(await (await admin.api.get(`/api/swaps/${swapId}/export.csv`)).text()).slice(1);
  // A leading @ is one of the characters guarded against formulas, so the handle gets a ' too.
  const ig = (x: Person) => [`'@${x.handle}`, `https://www.instagram.com/${x.handle}/`];
  const label = (x: Person) => `${x.name} (@${x.handle})`;
  const address = ['1 Main St', '', 'Springfield', 'IL', '62701', 'US'];
  const notYet = (x: Person) => [label(x), 'No', 'No', '', ''];

  expect(rows).toEqual([
    ['amy', p.amy.email, ...ig(p.amy), 'Yes', 'amy', ...address, 'Default', '', ...notYet(p.bob), ...Array(4).fill(EMPTY_MAKE).flat(), label(p.bob)],
    ['Zoe', p.zoe.email, ...ig(p.zoe), 'No', 'Zoe', ...address, 'Default', '', ...notYet(p.bob), ...Array(4).fill(EMPTY_MAKE).flat(), ''],
    [
      'Bob', p.bob.email, ...ig(p.bob), 'Yes', 'Bob', '1 Main St', 'Unit 5', 'Springfield', 'IL', '62701', 'US', 'Pod 2', '3',
      // Who Bob makes for, by name; and who makes for Bob, by name, separated by "; ".
      ...notYet(p.amy), ...notYet(p.cat), ...Array(3).fill(EMPTY_MAKE).flat(),
      `${label(p.amy)}; ${label(p.zoe)}`,
    ],
    ['Cat', p.cat.email, ...ig(p.cat), 'Yes', 'Cat', '1 Main St', '', 'Toronto', 'ON', 'M5V 2T6', 'CA', 'Pod 2', '', ...Array(5).fill(EMPTY_MAKE).flat(), label(p.bob)],
    ["'=Dan", p.dan.email, ...ig(p.dan), 'Yes', "'=Dan", '5 Oak St, "Back"', '', 'Springfield', 'IL', '62701', 'US', 'Pod 10', '', ...Array(5).fill(EMPTY_MAKE).flat(), ''],
  ]);
});

test('people who leave drop out of the CSV, along with their pairings', async () => {
  expect((await p.amy.api.delete(`/api/swaps/${swapId}/membership`)).status()).toBe(204);
  const rows = parseCsv(await (await admin.api.get(`/api/swaps/${swapId}/export.csv`)).text()).slice(1);
  expect(rows.map((r) => r[0])).toEqual(['Zoe', 'Bob', 'Cat', "'=Dan"]);
  const bob = rows[1];
  expect([bob[14], bob[19], bob[39]]).toEqual([`Cat (@${p.cat.handle})`, '', `Zoe (@${p.zoe.handle})`]);
  // Participants can't export.
  expect((await p.bob.api.get(`/api/swaps/${swapId}/export.csv`)).status()).toBe(403);
});
