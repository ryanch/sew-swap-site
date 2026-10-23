import { expect, test } from '@playwright/test';
import {
  adminUser,
  ALL_TICKED,
  assign,
  checkInstagram,
  createSwap,
  getJson,
  ids,
  newMember,
  newUser,
  runId,
  US_ADDRESS,
  type Address,
  type User,
} from '../helpers/api';
import { nameFields, uniqueHandle } from '../helpers/signup';

// GET /api/swaps/:swapId/members: every filter, filters together, and keyset pagination, on a small
// swap where the right answer for each is known. Also GET …/members/:userId.

test.describe.configure({ mode: 'serial' });

type Person = User & { handle: string; name: string };
type Key = 'alpha' | 'bravo' | 'charlie' | 'delta' | 'echo' | 'foxtrot';

let admin: User;
let swapId: string;
let north: string;
let south: string;
const run = runId();
const p = {} as Record<Key, Person>;

const at = (overrides: Partial<Address>): Address => ({ ...US_ADDRESS, ...overrides });
// Names are the same every run; the filters only ever look inside this run's swap.
const PEOPLE: [Key, Address, number | null][] = [
  ['alpha', at({ ...nameFields('Alpha Person'), city: 'Chicago', region: 'IL', postalCode: '60601' }), 1],
  ['bravo', at({ ...nameFields('Bravo Person'), region: 'IL' }), 2],
  ['charlie', at({ ...nameFields('Charlie Person'), city: 'Ottawa', region: 'ON', postalCode: 'K1A 0B1', country: 'CA' }), 5],
  ['delta', at({ ...nameFields('Delta Person'), city: 'London', region: 'Greater London', postalCode: 'SW1A 1AA', country: 'GB' }), null],
  ['echo', at({ ...nameFields('Echo Person'), city: 'New York', region: 'NY', postalCode: '10001' }), 3],
  ['foxtrot', at({ ...nameFields('Foxtrot Person'), city: 'New York', region: 'NY', postalCode: '10002' }), null],
];

type Member = { userId: string };
type Page = { members: Member[]; total: number; nextCursor: string | null };
const query = (q: string) => admin.api.get(`/api/swaps/${swapId}/members?${q}`);
const page = async (q: string) => (await getJson(admin.api, `/api/swaps/${swapId}/members?${q}`)) as Page;
/** The people matching a query string, by key, in key order. */
const who = async (q: string) => {
  const res = await page(q);
  const byId = new Map(Object.entries(p).map(([k, v]) => [v.userId, k]));
  const keys = res.members.map((m) => byId.get(m.userId) ?? m.userId).sort();
  expect(res.total, `total for ${q}`).toBe(keys.length);
  return keys;
};

test.beforeAll(async () => {
  admin = await adminUser();
  swapId = await createSwap(admin.api, `Members ${run}`);
  for (const [key, address, skill] of PEOPLE) {
    if (key === 'foxtrot') {
      // Foxtrot's Instagram couldn't be confirmed, so they ticked the box.
      const user = await newUser(`mem${key}`);
      const handle = await checkInstagram(user.api, uniqueHandle('unknownfox'));
      const res = await user.api.put(`/api/swaps/${swapId}/membership`, { data: { address, instagramPublicConfirmed: true } });
      expect(res.status()).toBe(200);
      p[key] = { ...user, handle, name: address.name };
    } else {
      p[key] = await newMember(`mem${key}`, swapId, address, uniqueHandle(`hdl${key}`));
    }
    if (skill !== null) {
      const res = await admin.api.patch(`/api/swaps/${swapId}/members/${p[key].userId}`, { data: { skillLevel: skill } });
      expect(res.status()).toBe(200);
    }
  }
  const pod = async (name: string, keys: Key[]) => {
    const podId = (await (await admin.api.post(`/api/swaps/${swapId}/pods`, { data: { name } })).json()).pod.podId as string;
    const res = await admin.api.put(`/api/swaps/${swapId}/pods/${podId}/members`, { data: { userIds: keys.map((k) => p[k].userId) } });
    expect((await res.json()).moved).toBe(keys.length);
    return podId;
  };
  north = await pod('North', ['alpha', 'charlie']);
  south = await pod('South', ['echo']);
  // Alpha makes for Bravo, Bravo for Charlie, Charlie for Alpha, and Echo for Alpha too.
  for (const [m, r] of [['alpha', 'bravo'], ['bravo', 'charlie'], ['charlie', 'alpha'], ['echo', 'alpha']] as [Key, Key][]) {
    expect((await assign(admin.api, swapId, p[m].userId, p[r].userId)).status()).toBe(200);
  }
});

test.afterAll(async () => {
  await Promise.all([admin.api.dispose(), ...Object.values(p).map((u) => u.api.dispose())]);
});

test('no filter lists every participant, but not the manager', async () => {
  expect(await who('')).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
});

test('filter by pod, or everyone outside a pod', async () => {
  expect(await who(`pod=${north}`)).toEqual(['alpha', 'charlie']);
  expect(await who(`pod=${south}`)).toEqual(['echo']);
  expect(await who('pod=default')).toEqual(['bravo', 'delta', 'foxtrot']);
  expect(await who(`exceptPod=${north}`)).toEqual(['bravo', 'delta', 'echo', 'foxtrot']);
  expect(await who('exceptPod=default')).toEqual(['alpha', 'charlie', 'echo']);
  expect(await who('pod=00000000-0000-0000-0000-000000000000')).toEqual([]);
});

test('search by email, name or Instagram, ignoring case and a leading @', async () => {
  expect(await who('q=memalpha')).toEqual(['alpha']);
  expect(await who(`q=${encodeURIComponent('  ALPHA per ')}`)).toEqual(['alpha']);
  expect(await who(`q=${encodeURIComponent('@HDLBRAVO')}`)).toEqual(['bravo']);
  expect(await who(`q=${encodeURIComponent(p.charlie.handle)}`)).toEqual(['charlie']);
  expect(await who('q=unknownfox')).toEqual(['foxtrot']);
  expect(await who('q=person')).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
  expect(await who('q=example.test')).toHaveLength(6);
  // LIKE wildcards are matched literally.
  expect(await who(`q=${encodeURIComponent('%')}`)).toEqual([]);
  expect(await who(`q=${encodeURIComponent('alpha%person')}`)).toEqual([]);
  expect(await who('q=nobody-like-this')).toEqual([]);
});

test('filter by country and region, ignoring case', async () => {
  expect(await who('country=US')).toEqual(['alpha', 'bravo', 'echo', 'foxtrot']);
  expect(await who('country=us')).toEqual(['alpha', 'bravo', 'echo', 'foxtrot']);
  expect(await who('country=CA')).toEqual(['charlie']);
  expect(await who('country=FR')).toEqual([]);
  expect(await who('region=il')).toEqual(['alpha', 'bravo']);
  expect(await who(`region=${encodeURIComponent(' Ny ')}`)).toEqual(['echo', 'foxtrot']);
  expect(await who(`region=${encodeURIComponent('greater LONDON')}`)).toEqual(['delta']);
  expect(await who('region=on')).toEqual(['charlie']);
  // A blank region is no filter.
  expect(await who('region=%20')).toHaveLength(6);
});

test('filter by skill level, or not rated yet', async () => {
  expect(await who('skill=1')).toEqual(['alpha']);
  expect(await who('skill=2')).toEqual(['bravo']);
  expect(await who('skill=3')).toEqual(['echo']);
  expect(await who('skill=4')).toEqual([]);
  expect(await who('skill=5')).toEqual(['charlie']);
  expect(await who('skill=none')).toEqual(['delta', 'foxtrot']);
  expect((await query('skill=6')).status()).toBe(400);

  // Clearing a rating puts them back in "none".
  await admin.api.patch(`/api/swaps/${swapId}/members/${p.echo.userId}`, { data: { skillLevel: null } });
  expect(await who('skill=none')).toEqual(['delta', 'echo', 'foxtrot']);
  await admin.api.patch(`/api/swaps/${swapId}/members/${p.echo.userId}`, { data: { skillLevel: 3 } });
  expect((await admin.api.patch(`/api/swaps/${swapId}/members/${p.echo.userId}`, { data: { skillLevel: 0 } })).status()).toBe(400);
});

test('filter by who still needs a maker or someone to make for', async () => {
  expect(await who('needs=maker')).toEqual(['delta', 'echo', 'foxtrot']);
  expect(await who('needs=recipient')).toEqual(['delta', 'foxtrot']);
  expect((await query('needs=everything')).status()).toBe(400);
});

test('filters combine', async () => {
  expect(await who('country=US&needs=maker')).toEqual(['echo', 'foxtrot']);
  expect(await who('pod=default&skill=none')).toEqual(['delta', 'foxtrot']);
  expect(await who('exceptPod=default&country=US&region=IL')).toEqual(['alpha']);
  expect(await who(`q=person&pod=${north}&skill=5`)).toEqual(['charlie']);
  expect(await who(`exceptPod=${north}&needs=recipient&country=GB`)).toEqual(['delta']);
  expect(await who(`pod=${north}&exceptPod=${north}`)).toEqual([]);
});

test('pages through people in user id order, with the total on every page', async () => {
  const all = ids(Object.values(p));
  const seen: string[] = [];
  let after = '';
  let pages = 0;
  do {
    const res = await page(`limit=2${after ? `&after=${after}` : ''}`);
    expect(res.total).toBe(6);
    expect(res.members.length).toBeLessThanOrEqual(2);
    seen.push(...res.members.map((m) => m.userId));
    if (res.nextCursor) expect(res.nextCursor).toBe(res.members[res.members.length - 1].userId);
    after = res.nextCursor ?? '';
    pages++;
  } while (after && pages < 10);
  expect(pages).toBe(3);
  expect(seen).toEqual(all);

  // Exactly a page's worth has no next page.
  expect((await page('limit=6')).nextCursor).toBeNull();
  const five = await page('limit=5');
  expect(five.nextCursor).toBe(all[4]);
  expect((await page(`limit=5&after=${five.nextCursor}`)).members.map((m) => m.userId)).toEqual([all[5]]);
  // After the last one: an empty page, still with the total.
  expect(await page(`after=${all[5]}`)).toEqual({ members: [], total: 6, nextCursor: null });

  // With a filter, the total counts only matches.
  const us = ids([p.alpha, p.bravo, p.echo, p.foxtrot]);
  const first = await page('country=US&limit=3');
  expect([first.members.map((m) => m.userId), first.total, first.nextCursor]).toEqual([us.slice(0, 3), 4, us[2]]);
  const second = await page(`country=US&limit=3&after=${first.nextCursor}`);
  expect([second.members.map((m) => m.userId), second.total, second.nextCursor]).toEqual([us.slice(3), 4, null]);

  for (const bad of ['limit=0', 'limit=501', 'limit=two']) expect((await query(bad)).status(), bad).toBe(400);
});

test('one person, with their address, pod and pairings', async () => {
  const { member } = await getJson(admin.api, `/api/swaps/${swapId}/members/${p.charlie.userId}`);
  expect(member).toEqual({
    userId: p.charlie.userId,
    email: p.charlie.email,
    displayName: null,
    name: 'Charlie Person',
    joinedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    instagramHandle: p.charlie.handle,
    instagramConfirmed: true,
    skillLevel: 5,
    pod: { podId: north, name: 'North' },
    country: 'CA',
    region: 'ON',
    city: 'Ottawa',
    makingFor: [{ userId: p.alpha.userId, name: 'Alpha Person', instagramHandle: p.alpha.handle, confirmed: false, shipped: null }],
    madeBy: [{ userId: p.bravo.userId, name: 'Bravo Person', instagramHandle: p.bravo.handle, confirmed: false, shipped: null }],
    lastRemindedAt: null,
    lastShipRemindedAt: null,
    address: { ...nameFields('Charlie Person'), line1: US_ADDRESS.line1, line2: '', city: 'Ottawa', region: 'ON', postalCode: 'K1A 0B1', country: 'CA' },
  });

  // Alpha is made for by two people, listed by name; Foxtrot is in Default, unrated and unconfirmed.
  const alpha = (await getJson(admin.api, `/api/swaps/${swapId}/members/${p.alpha.userId}`)).member;
  expect(alpha.madeBy.map((x: { name: string }) => x.name)).toEqual(['Charlie Person', 'Echo Person']);
  const fox = (await getJson(admin.api, `/api/swaps/${swapId}/members/${p.foxtrot.userId}`)).member;
  expect(fox).toMatchObject({ pod: { podId: 'default', name: 'Default' }, skillLevel: null, instagramConfirmed: false, makingFor: [], madeBy: [] });
  // The list shows the same, without the address.
  const listed = (await page(`q=memcharlie`)).members[0];
  const { address: _, ...withoutAddress } = member;
  expect(listed).toEqual(withoutAddress);

  // Someone who isn't a participant (the admin manages, but hasn't joined), or doesn't exist.
  expect((await admin.api.get(`/api/swaps/${swapId}/members/${admin.userId}`)).status()).toBe(404);
  expect((await admin.api.get(`/api/swaps/${swapId}/members/00000000-0000-0000-0000-000000000000`)).status()).toBe(404);
  // Participants can't look.
  expect((await p.bravo.api.get(`/api/swaps/${swapId}/members/${p.charlie.userId}`)).status()).toBe(403);
});

test('after publishing: who still has to confirm, and who still has to ship', async () => {
  expect((await admin.api.post(`/api/swaps/${swapId}/publish`, { data: { confirm: true } })).status()).toBe(200);
  expect(await who('needs=confirmation')).toEqual(['alpha', 'bravo', 'charlie', 'echo']);
  expect(await who('needs=shipping')).toEqual(['alpha', 'bravo', 'charlie', 'echo']);

  // Alpha confirms and ships; Charlie only confirms.
  const confirm = (m: Key, r: Key) => p[m].api.post(`/api/swaps/${swapId}/makes/${p[r].userId}/confirm`, { data: ALL_TICKED });
  expect((await confirm('alpha', 'bravo')).status()).toBe(200);
  expect((await confirm('charlie', 'alpha')).status()).toBe(200);
  const shipped = await p.alpha.api.post(`/api/swaps/${swapId}/makes/${p.bravo.userId}/ship`, {
    data: { carrier: 'ups', trackingNumber: '1Z999AA10123456784' },
  });
  expect(shipped.status()).toBe(200);

  expect(await who('needs=confirmation')).toEqual(['bravo', 'echo']);
  expect(await who('needs=shipping')).toEqual(['bravo', 'charlie', 'echo']);
  expect(await who(`needs=shipping&pod=${north}`)).toEqual(['charlie']);
  expect(await who('needs=confirmation&region=ny')).toEqual(['echo']);

  // The pairing shows as confirmed and shipped from both ends.
  const alpha = (await getJson(admin.api, `/api/swaps/${swapId}/members/${p.alpha.userId}`)).member;
  expect(alpha.makingFor).toEqual([
    expect.objectContaining({
      userId: p.bravo.userId,
      confirmed: true,
      shipped: {
        shippedAt: expect.stringMatching(/Z$/),
        carrier: 'ups',
        trackingNumber: '1Z999AA10123456784',
        trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      },
    }),
  ]);
  const bravo = (await getJson(admin.api, `/api/swaps/${swapId}/members/${p.bravo.userId}`)).member;
  expect(bravo.madeBy).toEqual([expect.objectContaining({ userId: p.alpha.userId, confirmed: true, shipped: alpha.makingFor[0].shipped })]);
});
