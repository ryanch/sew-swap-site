import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, adminUser, getJson, newUser, runId, type User } from '../helpers/api';

// The admin's user list and role grants, through the API. The admin page itself is in admin-roles.spec.ts.
// Display names only come from Google sign-in, which e2e can't do, so searching by name isn't covered.

test.describe.configure({ mode: 'serial' });

let admin: User;
const run = runId();
const people: User[] = [];

type AdminUser = { userId: string; email: string; displayName: string | null; roles: string[]; bootstrapAdmin: boolean };
const search = async (q: string) => (await getJson(admin.api, `/api/admin/users?q=${encodeURIComponent(q)}`)).users as AdminUser[];
const grant = (userId: string, role: string) => admin.api.put(`/api/admin/users/${userId}/roles/${role}`, { data: {} });
const revoke = (userId: string, role: string) => admin.api.delete(`/api/admin/users/${userId}/roles/${role}`, { data: {} });
const roles = async (u: User) => (await getJson(u.api, '/api/auth/me')).user.roles as string[];

test.beforeAll(async () => {
  admin = await adminUser();
  // Created one after the other, so the newest is last.
  for (const name of ['first', 'second', 'third']) people.push(await newUser(`adm${run}-${name}`));
});

test.afterAll(async () => {
  await Promise.all([admin.api.dispose(), ...people.map((p) => p.api.dispose())]);
});

test('the admin finds people by any part of their email, newest first', async () => {
  const found = await search(`adm${run}`);
  expect(found.map((u) => u.email)).toEqual([people[2].email, people[1].email, people[0].email]);
  expect(found[0]).toEqual({ userId: people[2].userId, email: people[2].email, displayName: null, roles: [], bootstrapAdmin: false });

  // The middle of an address, in capitals, and with spaces around it.
  expect((await search(`  ${run}-SECOND `)).map((u) => u.userId)).toEqual([people[1].userId]);
  expect(await search(`nobody-${run}`)).toEqual([]);

  // No query lists recent people, at most 100.
  const all = await search('');
  expect(all.length).toBeGreaterThanOrEqual(3);
  expect(all.length).toBeLessThanOrEqual(100);
  expect(all[0].userId).toBe(people[2].userId);

  // The bootstrap admin is marked as such.
  const [me] = await search(ADMIN_EMAIL);
  expect(me).toMatchObject({ email: ADMIN_EMAIL, roles: ['admin'], bootstrapAdmin: true });
});

test('granting a role twice keeps one grant, and removing it twice is fine', async () => {
  const [person] = people;
  for (let i = 0; i < 2; i++) {
    const res = await grant(person.userId, 'swap_manager');
    expect(res.status()).toBe(200);
    expect((await res.json()).user.roles).toEqual(['swap_manager']);
  }
  expect(await roles(person)).toEqual(['swap_manager']);

  // Both roles come back sorted, and the list shows them too.
  expect((await (await grant(person.userId, 'admin')).json()).user.roles).toEqual(['admin', 'swap_manager']);
  expect((await search(person.email))[0].roles).toEqual(['admin', 'swap_manager']);
  expect(await roles(person)).toEqual(['admin', 'swap_manager']);
  // A granted admin isn't a bootstrap admin, so the role can be removed.
  expect((await (await revoke(person.userId, 'admin')).json()).user).toMatchObject({ roles: ['swap_manager'], bootstrapAdmin: false });

  for (let i = 0; i < 2; i++) {
    const res = await revoke(person.userId, 'swap_manager');
    expect(res.status()).toBe(200);
    expect((await res.json()).user.roles).toEqual([]);
  }
  expect(await roles(person)).toEqual([]);
  // Other people's roles are untouched.
  expect(await roles(people[1])).toEqual([]);
});

test('granting roles needs a real user and a known role', async () => {
  expect((await grant('00000000-0000-0000-0000-000000000000', 'swap_manager')).status()).toBe(404);
  expect((await revoke('00000000-0000-0000-0000-000000000000', 'swap_manager')).status()).toBe(404);
  expect((await grant(people[0].userId, 'superuser')).status()).toBe(400);
  // The bootstrap admin keeps Admin, even when another admin tries to remove it.
  const other = people[1];
  await grant(other.userId, 'admin');
  const res = await other.api.delete(`/api/admin/users/${admin.userId}/roles/admin`, { data: {} });
  expect(res.status()).toBe(400);
  expect((await search(ADMIN_EMAIL))[0].roles).toEqual(['admin']);
  await revoke(other.userId, 'admin');
  expect(await roles(other)).toEqual([]);
});
