import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import { assertEvent, InvalidEventError, validateEvent, type DomainEvent } from '@common/events';

/**
 * PostgreSQL jsonb stores neither U+0000 (22P05) nor a lone UTF-16 surrogate (22P02), in a value or
 * in a key. Validation allows unknown extension fields, so such a string passes assertEvent and
 * only fails at the INSERT, aborting the whole business transaction with a generic 500. A valid
 * surrogate pair (an emoji) is accepted. String.isWellFormed is not used: it is typed in
 * lib.es2024 and this project builds with ES2022.
 */
// U+0000 is exactly what must be matched here, so the control-character rule does not apply.
const UNSTORABLE_TEXT =
  // eslint-disable-next-line no-control-regex
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Walks a value that came out of JSON.parse. It never reports or keeps the offending text. */
function hasUnstorableText(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (UNSTORABLE_TEXT.test(value)) return true;
    } else if (Array.isArray(value)) {
      for (const item of value as unknown[]) pending.push(item);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (UNSTORABLE_TEXT.test(key)) return true;
        pending.push(nested);
      }
    }
  }
  return false;
}

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
    // PostgreSQL would refuse this text at the INSERT. Refuse it here so the caller gets a typed
    // producer error instead of a database failure, and so the message never carries the text.
    if (hasUnstorableText(snapshot)) {
      throw new InvalidEventError([
        { path: '', code: 'INVALID_FORMAT', message: 'has an invalid format' },
      ]);
    }
    const contextId: unknown = this.logger.logger.bindings().correlationId;
    let correlationId = snapshot.correlationId;
    if (contextId !== undefined && contextId !== null) {
      const checked = validateEvent({ ...snapshot, correlationId: contextId });
      if (!checked.ok) {
        throw new InvalidEventError([
          { path: 'correlationId', code: 'INVALID_FORMAT', message: 'has an invalid format' },
        ]);
      }
      if (checked.event.correlationId !== snapshot.correlationId) {
        throw new InvalidEventError([
          { path: 'correlationId', code: 'NOT_ALLOWED', message: 'is not allowed' },
        ]);
      }
      correlationId = checked.event.correlationId;
    }
    const aggregateId =
      snapshot.eventType === 'TransferCompleted' ? snapshot.transferId : snapshot.accountId;

    await manager.query(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id)
       VALUES($1,$2,$3,$4::jsonb,$5)`,
      [snapshot.eventId, snapshot.eventType, aggregateId, payload, correlationId],
    );
  }
}
