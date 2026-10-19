import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStrategies, type IgResult, type InstagramStrategy } from './check';
import { cleanInstagramHandle } from './handle';

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
