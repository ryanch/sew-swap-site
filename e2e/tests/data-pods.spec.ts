import { expect, test } from '@playwright/test';
import { adminUser, assign, createSwap, getJson, newMember, runId, US_ADDRESS, type User } from '../helpers/api';

// Pods and pairings as stored: pod counts, names, moving, deleting and splitting pods, and
// assignment writes. The pages and auto-assign are in pods.spec.ts.

test.describe.configure({ mode: 'serial' });

type Pod = { podId: string; name: string; count: number };

let admin: User;
let swapId: string;
const run = runId();
const KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
type Key = (typeof KEYS)[number];
const p = {} as Record<Key, User>;
const podIds: Record<string, string> = {};

const pods = async () => (await getJson(admin.api, `/api/swaps/${swapId}/pods`)).pods as Pod[];
const counts = async () => (await pods()).map((x) => [x.name, x.count]);
const createPod = (name: string) => admin.api.post(`/api/swaps/${swapId}/pods`, { data: { name } });
const renamePod = (podId: string, name: string) => admin.api.patch(`/api/swaps/${swapId}/pods/${podId}`, { data: { name } });
const move = (podId: string, userIds: string[]) => admin.api.put(`/api/swaps/${swapId}/pods/${podId}/members`, { data: { userIds } });
const member = async (k: Key) => (await getJson(admin.api, `/api/swaps/${swapId}/members/${p[k].userId}`)).member;
const makingFor = async (k: Key) => (await member(k)).makingFor.map((x: { userId: string }) => x.userId).sort();
const uid = (...keys: Key[]) => keys.map((k) => p[k].userId);

test.beforeAll(async () => {
  admin = await adminUser();
  swapId = await createSwap(admin.api, `Pod data ${run}`);
  for (const k of KEYS) p[k] = await newMember(`pod${k}`, swapId, { ...US_ADDRESS, name: `Person ${k.toUpperCase()}` });
});

test.afterAll(async () => {
  await Promise.all([admin.api.dispose(), ...Object.values(p).map((u) => u.api.dispose())]);
});

test('Default is always first; other pods sort by name with numbers in order, each with its count', async () => {
  expect(await pods()).toEqual([{ podId: 'default', name: 'Default', count: 8 }]);

  for (const name of ['  Pod 10 ', 'Pod 2', 'Alpha pod']) {
    const res = await createPod(name);
    expect(res.status()).toBe(201);
    const { pod } = await res.json();
    expect(pod).toEqual({ podId: expect.any(String), name: name.trim(), count: 0 });
    podIds[name.trim()] = pod.podId;
  }
  expect(await counts()).toEqual([['Default', 8], ['Alpha pod', 0], ['Pod 2', 0], ['Pod 10', 0]]);

  expect(await (await move(podIds['Pod 2'], uid('a', 'b'))).json()).toEqual({ moved: 2 });
  expect(await (await move(podIds['Pod 10'], uid('c'))).json()).toEqual({ moved: 1 });
  expect(await counts()).toEqual([['Default', 5], ['Alpha pod', 0], ['Pod 2', 2], ['Pod 10', 1]]);
});

test('moving people: only participants count, and someone is in one pod at a time', async () => {
  // Duplicates and people who aren't in the swap (the admin) are skipped.
  const res = await move(podIds['Alpha pod'], [...uid('c', 'd', 'd'), admin.userId, 'not-a-user']);
  expect(await res.json()).toEqual({ moved: 2 });
  expect(await counts()).toEqual([['Default', 4], ['Alpha pod', 2], ['Pod 2', 2], ['Pod 10', 0]]);
  expect((await member('c')).pod).toEqual({ podId: podIds['Alpha pod'], name: 'Alpha pod' });

  // Back to Default, and an unknown pod is refused.
  expect(await (await move('default', uid('c', 'd'))).json()).toEqual({ moved: 2 });
  expect((await member('d')).pod).toEqual({ podId: 'default', name: 'Default' });
  expect((await move('00000000-0000-0000-0000-000000000000', uid('e'))).status()).toBe(404);
  expect(await counts()).toEqual([['Default', 6], ['Alpha pod', 0], ['Pod 2', 2], ['Pod 10', 0]]);
});

test('pod names are unique in a swap, ignoring case', async () => {
  for (const name of ['pod 2', 'POD 10', 'default', 'DEFAULT', '', '   ', 'x'.repeat(101)]) {
    const res = await createPod(name);
    expect(res.status(), JSON.stringify(name)).toBe(400);
  }
  expect((await (await createPod('pod 2')).json()).error).toBe(`There's already a pod called "pod 2".`);

  // Another swap can use the same name.
  const other = await createSwap(admin.api, `Pod data other ${run}`);
  expect((await admin.api.post(`/api/swaps/${other}/pods`, { data: { name: 'Pod 2' } })).status()).toBe(201);

  // Renaming checks the same, except against the pod itself.
  expect((await renamePod(podIds['Pod 10'], 'pod 2')).status()).toBe(400);
  expect((await renamePod(podIds['Pod 10'], 'Default')).status()).toBe(400);
  const res = await renamePod(podIds['Pod 2'], ' POD 2 ');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ pod: { podId: podIds['Pod 2'], name: 'POD 2' } });
  expect((await renamePod(podIds['Pod 10'], 'Pod 3')).status()).toBe(200);
  expect(await counts()).toEqual([['Default', 6], ['Alpha pod', 0], ['POD 2', 2], ['Pod 3', 0]]);
  expect((await member('a')).pod.name).toBe('POD 2');

  expect((await renamePod('default', 'Main')).status()).toBe(400);
  expect((await renamePod('00000000-0000-0000-0000-000000000000', 'Ghost')).status()).toBe(404);
  // The old name is free again.
  const again = await createPod('Pod 10');
  expect(again.status()).toBe(201);
  podIds['Pod 10'] = (await again.json()).pod.podId;
});

test('deleting a pod moves its people to Default and keeps their pairings', async () => {
  expect((await assign(admin.api, swapId, p.a.userId, p.b.userId)).status()).toBe(200);
  expect((await assign(admin.api, swapId, p.b.userId, p.e.userId)).status()).toBe(200);

  expect((await admin.api.delete(`/api/swaps/${swapId}/pods/${podIds['Pod 2']}`)).status()).toBe(204);
  expect(await counts()).toEqual([['Default', 8], ['Alpha pod', 0], ['Pod 3', 0], ['Pod 10', 0]]);
  expect((await member('a')).pod).toEqual({ podId: 'default', name: 'Default' });
  expect(await makingFor('a')).toEqual(uid('b'));
  expect(await makingFor('b')).toEqual(uid('e'));
  expect((await getJson(admin.api, `/api/swaps/${swapId}/members?pod=${podIds['Pod 2']}`)).total).toBe(0);

  expect((await admin.api.delete(`/api/swaps/${swapId}/pods/${podIds['Pod 2']}`)).status()).toBe(404);
  expect((await admin.api.delete(`/api/swaps/${swapId}/pods/default`)).status()).toBe(400);
  // An empty pod deletes too.
  expect((await admin.api.delete(`/api/swaps/${swapId}/pods/${podIds['Alpha pod']}`)).status()).toBe(204);
  expect(await counts()).toEqual([['Default', 8], ['Pod 3', 0], ['Pod 10', 0]]);
});

test('splitting makes even pods by skill, skipping names in use, and removes the old pod', async () => {
  const big = (await (await createPod('Big')).json()).pod.podId as string;
  expect((await createPod('big 2')).status()).toBe(201);
  await move(big, uid('a', 'b', 'c', 'd', 'e'));
  // The two rated people sort first, lowest skill first.
  for (const [k, skill] of [['d', 1], ['c', 2]] as [Key, number][]) {
    await admin.api.patch(`/api/swaps/${swapId}/members/${p[k].userId}`, { data: { skillLevel: skill } });
  }

  const split = (podId: string, size: number) => admin.api.post(`/api/swaps/${swapId}/pods/${podId}/split`, { data: { size } });
  expect((await split(big, 5)).status()).toBe(400);
  expect((await split(big, 1)).status()).toBe(400);
  expect((await split('00000000-0000-0000-0000-000000000000', 2)).status()).toBe(404);

  const res = await split(big, 2);
  expect(res.status()).toBe(200);
  const made = (await res.json()).pods as Pod[];
  // 5 by 2 makes three pods of 2, 2 and 1. "big 2" is taken (in any case), so it's skipped.
  expect(made.map((x) => [x.name, x.count])).toEqual([['Big 1', 2], ['Big 3', 2], ['Big 4', 1]]);
  expect(await counts()).toEqual([['Default', 3], ['Big 1', 2], ['big 2', 0], ['Big 3', 2], ['Big 4', 1], ['Pod 3', 0], ['Pod 10', 0]]);
  expect((await member('d')).pod).toEqual({ podId: made[0].podId, name: 'Big 1' });
  expect((await member('c')).pod).toEqual({ podId: made[0].podId, name: 'Big 1' });
  expect((await admin.api.delete(`/api/swaps/${swapId}/pods/${big}`)).status()).toBe(404);
  // Pairings don't change.
  expect(await makingFor('a')).toEqual(uid('b'));
});

test('splitting Default leaves Default listed, and empty', async () => {
  const res = await admin.api.post(`/api/swaps/${swapId}/pods/default/split`, { data: { size: 2 } });
  expect(res.status()).toBe(200);
  expect(((await res.json()).pods as Pod[]).map((x) => [x.name, x.count])).toEqual([['Default 1', 2], ['Default 2', 1]]);
  const after = await pods();
  expect(after[0]).toEqual({ podId: 'default', name: 'Default', count: 0 });
  expect(after.reduce((n, x) => n + x.count, 0)).toBe(8);
});

test('assigning the same pairing twice keeps one, and removing it twice is fine', async () => {
  const before = await makingFor('f');
  expect(before).toEqual([]);
  for (let i = 0; i < 2; i++) {
    const res = await assign(admin.api, swapId, p.f.userId, p.g.userId);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ assigned: true });
  }
  expect(await makingFor('f')).toEqual(uid('g'));
  expect((await member('g')).madeBy.map((x: { userId: string }) => x.userId)).toEqual(uid('f'));

  for (let i = 0; i < 2; i++) {
    expect((await admin.api.delete(`/api/swaps/${swapId}/assignments/${p.f.userId}/${p.g.userId}`)).status()).toBe(204);
  }
  expect(await makingFor('f')).toEqual([]);
  expect((await member('g')).madeBy).toEqual([]);
});

test('a maker at the limit of 5 can still be re-assigned someone they already make for', async () => {
  const five = uid('a', 'b', 'c', 'd', 'e');
  for (const to of five) expect((await assign(admin.api, swapId, p.h.userId, to)).status()).toBe(200);
  expect(await makingFor('h')).toEqual([...five].sort());
  expect((await assign(admin.api, swapId, p.h.userId, p.c.userId)).status()).toBe(200);
  const sixth = await assign(admin.api, swapId, p.h.userId, p.f.userId);
  expect(sixth.status()).toBe(400);
  expect((await sixth.json()).error).toBe('Person H already makes for 5 people.');
  // Being made for has no limit: everyone else can make for A.
  for (const k of ['c', 'd', 'e', 'f', 'g'] as Key[]) expect((await assign(admin.api, swapId, p[k].userId, p.a.userId)).status()).toBe(200);
  expect((await member('a')).madeBy).toHaveLength(6);

  // Both people have to be in the swap, and nobody makes for themselves.
  expect((await assign(admin.api, swapId, p.h.userId, p.h.userId)).status()).toBe(400);
  expect((await assign(admin.api, swapId, p.g.userId, admin.userId)).status()).toBe(400);
  expect((await assign(admin.api, swapId, admin.userId, p.g.userId)).status()).toBe(400);
  expect(await makingFor('g')).toEqual(uid('a'));
});
