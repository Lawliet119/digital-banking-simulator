import { createHash } from 'node:crypto';

/** Share of customers that go to the train part; the rest is validation (DBS-161, DBS-212). */
export const TRAIN_SHARE = 0.7;

export type SplitPart = 'train' | 'validation';

/**
 * Deterministic split by customer: the same seed and customer always land in the same part, and no
 * customer is ever in both (a customer's rows share history, so splitting rows would leak).
 */
export function isTrainCustomer(seed: string, customer: string): boolean {
  const digest = createHash('sha256').update(`${seed}:split:${customer}`).digest('hex');
  return parseInt(digest.slice(0, 8), 16) / 0x100000000 < TRAIN_SHARE;
}

export const partOf = (seed: string, customer: string): SplitPart =>
  isTrainCustomer(seed, customer) ? 'train' : 'validation';
