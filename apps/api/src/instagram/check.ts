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
