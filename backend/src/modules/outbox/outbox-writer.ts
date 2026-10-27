import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import { assertEvent, type DomainEvent } from '@common/events';

@Injectable()
export class OutboxWriter {
  constructor(private readonly logger: PinoLogger) {}

  async add(manager: EntityManager, event: DomainEvent): Promise<void> {
    const runner = manager.queryRunner;
    if (!runner || !runner.isTransactionActive || runner.isReleased) {
      throw new Error('Outbox writer requires an active transaction');
    }

    // A producer bug must fail the caller transaction (BL-011), never leave half a business write.
    assertEvent(event);
    const payload = JSON.stringify(event);
    if (typeof payload !== 'string') throw new TypeError('Event must serialize to JSON');
    // Validate what will be persisted too: a toJSON hook can change a previously valid object.
    const snapshot = assertEvent(JSON.parse(payload));
    const aggregateId =
      snapshot.eventType === 'TransferCompleted' ? snapshot.transferId : snapshot.accountId;

    await manager.query(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id)
       VALUES($1,$2,$3,$4::jsonb,$5)`,
      [snapshot.eventId, snapshot.eventType, aggregateId, payload, snapshot.correlationId],
    );
  }
}
