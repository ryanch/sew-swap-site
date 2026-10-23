/**
 * What a strategy learned about a profile:
 * - public / private / not_found: decisive, the chain stops.
 * - exists: the account is real but this strategy can't see whether it's public.
 * - unknown: no answer (blocked, rate limited, timed out, page changed).
 */
export type IgResult = 'public' | 'private' | 'not_found' | 'exists' | 'unknown';

/**
 * One way of asking Instagram about a profile. Instagram changes and blocks these often,
 * so strategies are tried in order and a broken one should return 'unknown', not guess.
 */
export interface InstagramStrategy {
  name: string;
  check(handle: string, signal: AbortSignal): Promise<IgResult>;
}

export type CheckOutcome = { result: IgResult; strategy: string | null };

type Logger = { warn(obj: object, msg: string): void };

/** Runs strategies in order. The first decisive answer wins; 'exists' is kept in case a later one decides. */
export async function runStrategies(
  strategies: InstagramStrategy[],
  handle: string,
  { timeoutMs = 6000, log }: { timeoutMs?: number; log?: Logger } = {},
): Promise<CheckOutcome> {
  let best: CheckOutcome = { result: 'unknown', strategy: null };
  for (const strategy of strategies) {
    let result: IgResult;
    try {
      result = await strategy.check(handle, AbortSignal.timeout(timeoutMs));
    } catch (err) {
      log?.warn({ err, strategy: strategy.name, handle }, 'Instagram strategy failed');
      result = 'unknown';
    }
    if (result === 'public' || result === 'private' || result === 'not_found') {
      return { result, strategy: strategy.name };
    }
    if (result === 'exists' && best.result === 'unknown') best = { result, strategy: strategy.name };
  }
  return best;
}

/**
 * What a post strategy learned. Instagram only shows a private account's posts to followers who are
 * signed in, so a post we can read means a public account, and its page names the owner.
 * A private account's post looks the same as a link to nothing: 'not_found'.
 */
export type PostResult = { result: 'public'; handle: string } | { result: 'not_found' | 'unknown' };

/** One way of reading a post's page. Like `InstagramStrategy`, a broken one returns 'unknown'. */
export interface PostStrategy {
  name: string;
  check(url: string, signal: AbortSignal): Promise<PostResult>;
}

export type PostOutcome = PostResult & { strategy: string | null };

/** Runs post strategies in order. The first 'public' or 'not_found' wins. */
export async function runPostStrategies(
  strategies: PostStrategy[],
  url: string,
  { timeoutMs = 6000, log }: { timeoutMs?: number; log?: Logger } = {},
): Promise<PostOutcome> {
  for (const strategy of strategies) {
    let outcome: PostResult;
    try {
      outcome = await strategy.check(url, AbortSignal.timeout(timeoutMs));
    } catch (err) {
      log?.warn({ err, strategy: strategy.name, url }, 'Instagram post strategy failed');
      continue;
    }
    if (outcome.result !== 'unknown') return { ...outcome, strategy: strategy.name };
  }
  return { result: 'unknown', strategy: null };
}
