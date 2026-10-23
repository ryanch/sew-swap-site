import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPostStrategies, runStrategies, type IgResult, type InstagramStrategy, type PostResult, type PostStrategy } from './check';
import { cleanInstagramHandle } from './handle';
import { parsePostLink } from './post';
import { postOwner } from './strategies';

test('cleanInstagramHandle strips spaces, @, and profile URLs', () => {
  for (const input of [
    'john',
    'john ',
    ' @John',
    'https://www.instagram.com/john',
    'https://www.instagram.com/john/',
    'www.instagram.com/john',
    'instagram.com/john/?hl=en',
    'http://m.instagram.com/john#top',
  ]) {
    assert.deepEqual(cleanInstagramHandle(input), { handle: 'john' }, input);
  }
  assert.deepEqual(cleanInstagramHandle('jane.doe_99'), { handle: 'jane.doe_99' });
});

test('cleanInstagramHandle rejects things that are not usernames', () => {
  for (const input of ['', '   ', 'https://www.instagram.com/', 'john smith', '.john', 'john.', 'jo..hn', 'a'.repeat(31), 'jöhn']) {
    assert.ok('error' in cleanInstagramHandle(input), input);
  }
});

const strategy = (name: string, result: IgResult | Error, calls: string[] = []): InstagramStrategy => ({
  name,
  async check() {
    calls.push(name);
    if (result instanceof Error) throw result;
    return result;
  },
});

test('the first decisive strategy wins and later ones are skipped', async () => {
  const calls: string[] = [];
  const outcome = await runStrategies(
    [strategy('a', 'unknown', calls), strategy('b', 'private', calls), strategy('c', 'public', calls)],
    'x',
  );
  assert.deepEqual(outcome, { result: 'private', strategy: 'b' });
  assert.deepEqual(calls, ['a', 'b']);
});

test("'exists' is kept unless a later strategy decides", async () => {
  assert.deepEqual(await runStrategies([strategy('a', 'exists'), strategy('b', 'unknown')], 'x'), {
    result: 'exists',
    strategy: 'a',
  });
  assert.deepEqual(await runStrategies([strategy('a', 'exists'), strategy('b', 'public')], 'x'), {
    result: 'public',
    strategy: 'b',
  });
});

test('errors and timeouts count as unknown', async () => {
  const slow: InstagramStrategy = {
    name: 'slow',
    check: (_handle, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  };
  // AbortSignal.timeout doesn't keep the process alive on its own.
  const keepAlive = setTimeout(() => {}, 5000);
  const outcome = await runStrategies([strategy('boom', new Error('blocked')), slow], 'x', { timeoutMs: 20 });
  clearTimeout(keepAlive);
  assert.deepEqual(outcome, { result: 'unknown', strategy: null });
  assert.deepEqual(await runStrategies([], 'x'), { result: 'unknown', strategy: null });
});

test('parsePostLink accepts what the share buttons copy and normalizes it', () => {
  const cases: [string, string][] = [
    ['https://www.instagram.com/p/DeztjUqvTI9/?utm_source=ig_web_copy_link&rpxt=NTc4MTIwNjQ2YQ==', 'https://www.instagram.com/p/DeztjUqvTI9/'],
    [' https://www.instagram.com/p/DeztjUqvTI9/?igsh=MWQ1ZGUxMzBkMA== ', 'https://www.instagram.com/p/DeztjUqvTI9/'],
    ['instagram.com/p/DeztjUqvTI9', 'https://www.instagram.com/p/DeztjUqvTI9/'],
    ['http://m.instagram.com/p/Dez-tj_9/#comments', 'https://www.instagram.com/p/Dez-tj_9/'],
    ['https://www.instagram.com/realmikejfox/p/DeztjUqvTI9/', 'https://www.instagram.com/p/DeztjUqvTI9/'],
    ['https://www.instagram.com/reel/C1a2b3/?utm_source=ig_web_copy_link', 'https://www.instagram.com/reel/C1a2b3/'],
    ['https://www.instagram.com/reels/C1a2b3/', 'https://www.instagram.com/reel/C1a2b3/'],
    ['https://www.instagram.com/tv/C1a2b3', 'https://www.instagram.com/tv/C1a2b3/'],
    ['https://www.instagram.com/share/p/BAzx12/', 'https://www.instagram.com/share/p/BAzx12/'],
    ['https://www.instagram.com/share/BAzx12', 'https://www.instagram.com/share/BAzx12/'],
  ];
  for (const [input, url] of cases) {
    const parsed = parsePostLink(input);
    assert.ok('url' in parsed, input);
    assert.equal(parsed.url, url, input);
  }
  assert.deepEqual(parsePostLink('instagram.com/p/DeztjUqvTI9'), { shortcode: 'DeztjUqvTI9', url: 'https://www.instagram.com/p/DeztjUqvTI9/' });
});

test('parsePostLink explains names and profile links, and refuses other links', () => {
  for (const input of ['john', '@john', 'https://www.instagram.com/john/', 'instagram.com/john?hl=en']) {
    const parsed = parsePostLink(input);
    assert.ok('error' in parsed && /Instagram name or profile/.test(parsed.error), input);
  }
  for (const input of ['', 'john smith', 'https://www.instagram.com/', 'https://www.instagram.com/p/', 'https://evil.example/instagram.com/p/ABC/', 'https://notinstagram.com/p/ABC/', 'https://www.instagram.com/p/AB C/']) {
    const parsed = parsePostLink(input);
    assert.ok('error' in parsed && !/Instagram name or profile/.test(parsed.error), input);
  }
});

test('postOwner reads the owner from og:url, else og:description', () => {
  const page = (url: string, description: string) =>
    `<meta property="og:type" content="article" />\n<meta property="og:url" content="${url}" />\n<meta property="og:description" content="${description}" />`;
  const description = '165K likes, 1,606 comments - realmikejfox on October 22, 2026: &quot;Great Scott&quot;. ';
  assert.equal(postOwner(page('https://www.instagram.com/realmikejfox/p/DeztjUqvTI9/', description)), 'realmikejfox');
  assert.equal(postOwner(page('https://www.instagram.com/Jane.Doe_9/reel/C1a2b3/', '')), 'jane.doe_9');
  assert.equal(postOwner(page('https://www.instagram.com/p/DeztjUqvTI9/', description)), 'realmikejfox');
  // A missing post, or a private account's: the login page with no post tags.
  assert.equal(postOwner('<html><title>Instagram</title></html>'), null);
  assert.equal(postOwner(page('https://www.instagram.com/p/X/', 'Sign up to see photos')), null);
});

const postStrategy = (name: string, result: PostResult | Error, calls: string[] = []): PostStrategy => ({
  name,
  async check() {
    calls.push(name);
    if (result instanceof Error) throw result;
    return result;
  },
});

test('the first post strategy with an answer wins; errors count as no answer', async () => {
  const calls: string[] = [];
  const outcome = await runPostStrategies(
    [
      postStrategy('a', new Error('blocked'), calls),
      postStrategy('b', { result: 'unknown' }, calls),
      postStrategy('c', { result: 'public', handle: 'jo' }, calls),
      postStrategy('d', { result: 'not_found' }, calls),
    ],
    'u',
  );
  assert.deepEqual(outcome, { result: 'public', handle: 'jo', strategy: 'c' });
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(await runPostStrategies([postStrategy('a', { result: 'not_found' })], 'u'), { result: 'not_found', strategy: 'a' });
  assert.deepEqual(await runPostStrategies([postStrategy('a', { result: 'unknown' })], 'u'), { result: 'unknown', strategy: null });
});
