import { Counter, register } from 'prom-client';

export const CONSUMER_MESSAGE_METRIC = 'consumer_message_total';

/**
 * What the frame decided for a message it could not apply (BL-209): `retry` = the error is
 * thrown, the message goes back to the queue (with backoff); `dead_letter` = it goes to the DLQ.
 * A message applied, or recognised as already applied, is not counted: the counter is for the
 * unhappy paths, and the DLQ alarm and these two series together say whether they are stuck.
 */
export type ConsumerOutcome = 'retry' | 'dead_letter';
const OUTCOMES: readonly ConsumerOutcome[] = ['retry', 'dead_letter'];
/** A consumer name is a literal in code (`processed_events.consumer`); anything else is not a label. */
const CONSUMER_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const UNKNOWN = 'unknown';

function sharedCounter(): Counter<'consumer' | 'outcome'> {
  const existing = register.getSingleMetric(CONSUMER_MESSAGE_METRIC);
  if (existing instanceof Counter) return existing;
  return new Counter({
    name: CONSUMER_MESSAGE_METRIC,
    help: 'Messages a queue consumer retried or dead-lettered, by consumer and outcome',
    labelNames: ['consumer', 'outcome'],
    registers: [register],
  });
}

const messages = sharedCounter();

/**
 * One retry or dead-letter decision. `MetricsService` writes it as `consumer_message_total` with the
 * dimensions `Role`, `Consumer` and `Outcome`; both values are checked against a fixed shape, so a
 * bug cannot put an id or a message text on a metric.
 */
export function countConsumerMessage(consumer: string, outcome: ConsumerOutcome): void {
  messages.inc({
    consumer: CONSUMER_NAME.test(consumer) ? consumer : UNKNOWN,
    outcome: OUTCOMES.includes(outcome) ? outcome : UNKNOWN,
  });
}
