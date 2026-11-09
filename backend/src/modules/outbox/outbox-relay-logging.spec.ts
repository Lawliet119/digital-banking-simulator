import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { TransactionService } from '@database/transaction.service';
import type { SqsClient } from '@libs/sqs';
import { OutboxRelayService } from './outbox-relay.service';

/** DBS-134: a failed send is logged with the correlationId of the event, not null. */
const PAYLOAD = { correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045' };

describe('OutboxRelayService logging (unit)', () => {
  it('TC-134-08 the warning for an event that could not be sent carries its correlationId', async () => {
    const manager = {
      query: (sql: string) =>
        Promise.resolve(
          sql.startsWith('SELECT')
            ? [{ id: '7', event_type: 'TransferCompleted', payload: PAYLOAD }]
            : [],
        ),
    } as unknown as EntityManager;
    const tx = { run: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager) };
    const sqs = { send: jest.fn().mockRejectedValue(new Error('queue unavailable')) };
    const relay = new OutboxRelayService(
      tx as unknown as TransactionService,
      sqs as unknown as SqsClient,
      {
        riskQueueUrl: 'http://localhost:9324/000000000000/risk-events',
        notificationQueueUrl: 'http://localhost:9324/000000000000/notification-events',
      } as never,
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const result = await relay.relayOnce();
      expect(result.published).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          outboxId: '7',
          correlationId: PAYLOAD.correlationId,
        }),
        'Outbox event could not be sent',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
