import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

/**
 * Outbox relay tuning (DBS-175, docs/03 §10): how long the relay sleeps after a batch that was not full,
 * and how many events one batch takes. The defaults (500 ms, 100) are what it always used. Kept apart from
 * `limitsConfig`: the relay is the only reader, and a test that builds the relay by hand passes neither.
 */
export const relayConfig = registerAs('relay', () => {
  const env = validateEnv(process.env);
  return {
    idleDelayMs: env.OUTBOX_RELAY_IDLE_DELAY_MS,
    batchSize: env.OUTBOX_RELAY_BATCH_SIZE,
  };
});
