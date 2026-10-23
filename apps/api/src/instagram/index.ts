import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config';
import { runPostStrategies, runStrategies, type CheckOutcome, type PostOutcome } from './check';
import { POST_STRATEGIES, STRATEGIES } from './strategies';

function pick<T>(names: string[], all: Record<string, T>, envVar: string): T[] {
  return names.map((name) => {
    const strategy = all[name];
    if (!strategy) throw new Error(`Unknown Instagram strategy "${name}" in ${envVar}`);
    if (name.startsWith('fake') && config.appBaseUrl.startsWith('https://')) {
      throw new Error('The fake Instagram strategies are for local development only');
    }
    return strategy;
  });
}

const strategies = pick(config.instagram.strategies, STRATEGIES, 'INSTAGRAM_CHECK_STRATEGIES');
const postStrategies = pick(config.instagram.postStrategies, POST_STRATEGIES, 'INSTAGRAM_POST_STRATEGIES');

/** Reads the post at `url`: whether it's public, and whose it is. */
export function checkInstagramPost(url: string, log: FastifyBaseLogger): Promise<PostOutcome> {
  return runPostStrategies(postStrategies, url, { log });
}

/** Asks about the account called `handle`, for when the post couldn't be read. */
export function checkInstagram(handle: string, log: FastifyBaseLogger): Promise<CheckOutcome> {
  return runStrategies(strategies, handle, { log });
}
