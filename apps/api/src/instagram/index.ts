import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config';
import { runStrategies, type CheckOutcome } from './check';
import { STRATEGIES } from './strategies';

const strategies = config.instagram.strategies.map((name) => {
  const strategy = STRATEGIES[name];
  if (!strategy) throw new Error(`Unknown Instagram strategy "${name}" in INSTAGRAM_CHECK_STRATEGIES`);
  if (name === 'fake' && config.appBaseUrl.startsWith('https://')) {
    throw new Error('The fake Instagram strategy is for local development only');
  }
  return strategy;
});

export function checkInstagram(handle: string, log: FastifyBaseLogger): Promise<CheckOutcome> {
  return runStrategies(strategies, handle, { log });
}
