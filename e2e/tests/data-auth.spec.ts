import { expect, test } from '@playwright/test';
import { newContext, requestCode, sessionCookie, signInWithCode } from '../helpers/api';
import { uniqueEmail } from '../helpers/mailpit';

// Sign-in data: login tokens (code and link share one row), sessions, and users keyed by email.
// The link-only-works-once case is in auth-email.spec.ts.

test('the 6-digit code signs in, creates the user once, and works only once', async () => {
  const email = uniqueEmail('code');
  const api = await newContext();
  const mail = await requestCode(api, email);

  // Spaces around the code are fine.
  const res = await api.post('/api/auth/email/verify-code', { data: { email, code: ` ${mail.code} ` } });
  expect(res.status()).toBe(200);
  const first = await res.json();
  expect(first.isNewUser).toBe(true);
  expect(first.user).toMatchObject({ email, roles: [] });
  expect((await (await api.get('/api/auth/me')).json()).user.userId).toBe(first.user.userId);

  // The same code again is refused, even from a fresh client.
  const other = await newContext();
  expect((await other.post('/api/auth/email/verify-code', { data: { email, code: mail.code } })).status()).toBe(400);
  expect((await other.get('/api/auth/me')).status()).toBe(401);

  // A second sign-in finds the same user.
  const again = await signInWithCode(other, email);
  expect(again.isNewUser).toBe(false);
  expect(again.user.userId).toBe(first.user.userId);
  await Promise.all([api.dispose(), other.dispose()]);
});

test('using the link uses up the code from the same email, and the other way round', async () => {
  const email = uniqueEmail('linkcode');
  const api = await newContext();

  const one = await requestCode(api, email);
  expect((await api.post('/api/auth/email/verify-link', { data: { token: one.token } })).status()).toBe(200);
  expect((await api.post('/api/auth/email/verify-code', { data: { email, code: one.code } })).status()).toBe(400);

  const two = await requestCode(api, email);
  expect((await api.post('/api/auth/email/verify-code', { data: { email, code: two.code } })).status()).toBe(200);
  expect((await api.post('/api/auth/email/verify-link', { data: { token: two.token } })).status()).toBe(400);
  await api.dispose();
});

test('five wrong codes lock out every live code for that email, but a new email works', async () => {
  const email = uniqueEmail('wrongcode');
  const api = await newContext();
  const first = await requestCode(api, email);
  const second = await requestCode(api, email);
  const wrong = [first.code, second.code].includes('000000') ? '111111' : '000000';

  for (let i = 0; i < 5; i++) {
    const res = await api.post('/api/auth/email/verify-code', { data: { email, code: wrong } });
    expect(res.status(), `wrong guess ${i + 1}`).toBe(400);
  }
  // Both codes counted the wrong guesses, so neither works now.
  for (const code of [first.code, second.code]) {
    expect((await api.post('/api/auth/email/verify-code', { data: { email, code } })).status()).toBe(400);
  }
  expect((await api.get('/api/auth/me')).status()).toBe(401);
  // The link isn't limited by wrong codes.
  expect((await api.post('/api/auth/email/verify-link', { data: { token: first.token } })).status()).toBe(200);

  // A new email's code starts with no wrong guesses.
  const third = await requestCode(api, email);
  expect((await api.post('/api/auth/email/verify-code', { data: { email, code: third.code } })).status()).toBe(200);
  await api.dispose();
});

test('a code from one email does not sign in another address', async () => {
  const a = uniqueEmail('codea');
  const b = uniqueEmail('codeb');
  const api = await newContext();
  const mail = await requestCode(api, a);
  expect((await api.post('/api/auth/email/verify-code', { data: { email: b, code: mail.code } })).status()).toBe(400);
  expect((await api.get('/api/auth/me')).status()).toBe(401);
  await api.dispose();
});

test('logging out deletes the session, so the old cookie stops working', async () => {
  const email = uniqueEmail('logout');
  const api = await newContext();
  await signInWithCode(api, email);
  const sid = await sessionCookie(api);
  expect(sid).toBeTruthy();

  // A second session for the same person is separate.
  const other = await newContext();
  await signInWithCode(other, email);

  // The cookie works from anywhere until logging out.
  const copy = await newContext();
  const withCookie = { headers: { cookie: `sid=${sid}` } };
  expect((await copy.get('/api/auth/me', withCookie)).status()).toBe(200);

  expect((await api.post('/api/auth/logout', { data: {} })).status()).toBe(200);
  expect((await api.get('/api/auth/me')).status()).toBe(401);
  expect((await copy.get('/api/auth/me', withCookie)).status()).toBe(401);
  // Logging out twice is fine.
  expect((await copy.post('/api/auth/logout', { ...withCookie, data: {} })).status()).toBe(200);
  // The other session is untouched.
  expect((await other.get('/api/auth/me')).status()).toBe(200);
  await Promise.all([api.dispose(), other.dispose(), copy.dispose()]);
});

test('the same email in different letter case is the same person', async () => {
  const email = uniqueEmail('case');
  const shouty = email.toUpperCase();
  const api = await newContext();

  // Signing up with capitals stores the email in lower case.
  const first = await signInWithCode(api, `  ${shouty} `);
  expect(first.isNewUser).toBe(true);
  expect(first.user.email).toBe(email);

  // Ask in lower case, answer the code in mixed case.
  const mail = await requestCode(api, email);
  const mixed = email.replace(/^./, (c) => c.toUpperCase());
  const res = await api.post('/api/auth/email/verify-code', { data: { email: mixed, code: mail.code } });
  expect(res.status()).toBe(200);
  const second = await res.json();
  expect(second.isNewUser).toBe(false);
  expect(second.user.userId).toBe(first.user.userId);
  await api.dispose();
});

test('sign-in emails are rate limited per address', async () => {
  // Compose sets LOGIN_REQUESTS_PER_HOUR to 50.
  const email = uniqueEmail('ratelimit');
  const api = await newContext();
  for (let i = 0; i < 50; i++) {
    const res = await api.post('/api/auth/email/request', { data: { email } });
    expect(res.status(), `request ${i + 1}`).toBe(200);
  }
  // Letter case doesn't get around it.
  const limited = await api.post('/api/auth/email/request', { data: { email: email.toUpperCase() } });
  expect(limited.status()).toBe(429);
  expect((await limited.json()).error).toMatch(/Too many/);

  // Another address isn't affected.
  expect((await api.post('/api/auth/email/request', { data: { email: uniqueEmail('ratelimit-other') } })).status()).toBe(200);
  // A bad address is refused before counting.
  expect((await api.post('/api/auth/email/request', { data: { email: 'not an email' } })).status()).toBe(400);
  await api.dispose();
});
