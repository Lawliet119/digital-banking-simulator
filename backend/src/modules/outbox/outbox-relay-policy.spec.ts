import type { TransactionService } from '@database/transaction.service';
import type { SqsClient } from '@libs/sqs';
import {
  classifySendError,
  OutboxRelayService,
  RELAY_BATCH_SIZE,
  RELAY_IDLE_DELAY_MS,
  relayDelayMs,
} from './outbox-relay.service';

const config = {
  region: 'us-east-1',
  endpoint: undefined,
  riskQueueUrl: 'http://queue/risk-events',
  notificationQueueUrl: 'http://queue/notification-events',
};
const http = (status: number) =>
  Object.assign(new Error(`http ${status}`), {
    $metadata: { httpStatusCode: status },
  });

/** A relay over a fake manager: the SELECT returns `rows`, the UPDATE is recorded. */
function relayOver(
  rows: { id: string; event_type: string; payload: object }[],
  send: SqsClient['send'],
) {
  const marked: string[][] = [];
  const selects: unknown[][] = [];
  const manager = {
    query: (sql: string, args: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        selects.push(args);
        const skip = new Set((args[2] as string[]) ?? []);
        return Promise.resolve(rows.filter(r => !skip.has(r.id)));
      }
      marked.push(args[0] as string[]);
      return Promise.resolve([]);
    },
  };
  const tx = { run: (cb: (m: typeof manager) => Promise<unknown>) => cb(manager) };
  const relay = new OutboxRelayService(
    tx as unknown as TransactionService,
    { send } as unknown as SqsClient,
    config,
  );
  return { relay, marked, selects };
}
const events = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    event_type: 'AccountStatusChanged',
    payload: { eventId: `e${i + 1}` },
  }));

describe('DBS-91 relay failure policy', () => {
  it('TC-91-12 the loop keeps its pace unless nothing could be sent because of a transient failure', () => {
    const transient = new Error('socket hang up');
    expect(relayDelayMs({ published: 0 })).toBe(RELAY_IDLE_DELAY_MS);
    expect(relayDelayMs({ published: RELAY_BATCH_SIZE })).toBe(0);
    expect(relayDelayMs({ published: 3, truncated: true })).toBe(0);
    expect(relayDelayMs({ published: 2, failure: transient })).toBe(RELAY_IDLE_DELAY_MS);
    expect(() => relayDelayMs({ published: 0, failure: transient })).toThrow(transient);
    // A permanent failure is parked, so the next poll does not meet it again: no back-off needed.
    expect(relayDelayMs({ published: 0, failure: http(400) })).toBe(RELAY_IDLE_DELAY_MS);
  });

  it('classifies HTTP 4xx (except 429) as permanent and everything else as transient', () => {
    expect(classifySendError(http(400))).toBe('permanent');
    expect(classifySendError(http(404))).toBe('permanent');
    expect(classifySendError(http(429))).toBe('transient');
    expect(classifySendError(http(500))).toBe('transient');
    expect(classifySendError(http(503))).toBe('transient');
    expect(classifySendError(new Error('socket hang up'))).toBe('transient');
    expect(classifySendError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(
      'transient',
    );
    expect(classifySendError('weird')).toBe('transient');
  });

  it('TC-91-06 a successful send resets the count of transient failures', async () => {
    // Event i uses one send (AccountStatusChanged goes to one queue). Outcomes per event:
    const outcomes = ['fail', 'ok', 'fail', 'fail', 'ok', 'fail', 'fail', 'ok'];
    let call = 0;
    const { relay, marked } = relayOver(events(outcomes.length), () => {
      const outcome = outcomes[call++];
      return outcome === 'ok' ? Promise.resolve() : Promise.reject(new Error('socket hang up'));
    });
    const result = await relay.relayOnce();
    // Never three failures in a row, so the whole batch is tried and the three good ones go.
    expect(call).toBe(outcomes.length);
    expect(result.published).toBe(3);
    expect(marked).toEqual([['2', '5', '8']]);
    expect(result.failure).toBeInstanceOf(Error);
  });

  it('stops after three transient failures in a row and still marks what was sent', async () => {
    let call = 0;
    const { relay, marked } = relayOver(events(10), () => {
      call += 1;
      return call === 1 ? Promise.resolve() : Promise.reject(new Error('socket hang up'));
    });
    const result = await relay.relayOnce();
    expect(call).toBe(4); // one good send, then three failures
    expect(result.published).toBe(1);
    expect(marked).toEqual([['1']]);
  });

  it('result keys are present only when they have a value', async () => {
    const { relay } = relayOver(events(2), () => Promise.resolve());
    const result = await relay.relayOnce();
    expect(Object.keys(result)).toEqual(['published']);
  });
});
