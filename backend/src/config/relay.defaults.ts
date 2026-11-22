/**
 * Outbox relay tuning bounds and defaults (DBS-175, ADR-03, docs/03 §10). One source for the Joi schema, the relay's own fallback
 * constants and the tests; the Terraform variables (`relay_idle_delay_ms`, `relay_batch_size`) repeat them and
 * `worker.tftest.hcl` keeps them equal.
 */
/** Sleep after a batch that was not full. ADR-03: the poll is at most 1 s, hence the upper bound below. */
export const RELAY_DEFAULT_IDLE_DELAY_MS = 500;
export const RELAY_IDLE_DELAY_MIN_MS = 50;
export const RELAY_IDLE_DELAY_MAX_MS = 1000;
/** Events per batch (ADR-03). The 15 s batch budget stays inside Postgres' idle-in-transaction limit up to this size. */
export const RELAY_DEFAULT_BATCH_SIZE = 100;
export const RELAY_BATCH_SIZE_MIN = 1;
export const RELAY_BATCH_SIZE_MAX = 500;
