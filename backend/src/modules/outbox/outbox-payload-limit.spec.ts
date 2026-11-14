import { EVENT_TYPES } from '@common/events';
import {
  OUTBOX_MAX_PAYLOAD_BYTES,
  SQS_ATTRIBUTE_RESERVE_BYTES,
  SQS_MAX_MESSAGE_BYTES,
} from './outbox-writer';

/**
 * SQS counts the body plus, for every message attribute, its name, its data type and its value
 * (UTF-8 bytes). The relay sends `eventType` and `correlationId`.
 */
/** A TransferCompleted as the writer stores it, with the longest fields it can have. */
const TRANSFER_SAMPLE = {
  eventId: '2f6c1a90-7d3b-4e58-9a14-c5b8e0d7f362',
  eventType: 'TransferCompleted',
  occurredAt: '2026-10-19T03:15:42.123Z',
  correlationId: '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045',
  transferId: '5c8d2e47-1b96-4a30-8f5e-7a3b9c0d6e18',
  type: 'TRANSFER',
  fromAccountId: '7e1a4b93-2c58-4d06-9b7f-e3a5c8d19f20',
  toAccountId: '1d9f6a38-4e72-4c15-a083-b6d2e7c4f951',
  amount: '9223372036854775807',
  fromBalanceBefore: '-9223372036854775808',
  fromAccountCreatedAt: '2026-09-30T08:00:00.000Z',
  toAccountCreatedAt: '2026-01-15T08:00:00.000Z',
  sameOwner: false,
  fromUserId: 'b2e5c8a1-6f40-4d93-8c17-a9d3f0e6b724',
  toUserId: 'd4a7f1c6-3b85-4e29-b0d8-5c6e9a2f1783',
};

const attributeBytes = (name: string, value: string): number =>
  Buffer.byteLength(name) + Buffer.byteLength('String') + Buffer.byteLength(value);

describe('BL-123 the payload limit is chosen from the SQS message limit', () => {
  it('SQS allows 256 KiB and the limit leaves a reserve below it', () => {
    expect(SQS_MAX_MESSAGE_BYTES).toBe(256 * 1024);
    expect(OUTBOX_MAX_PAYLOAD_BYTES).toBe(SQS_MAX_MESSAGE_BYTES - SQS_ATTRIBUTE_RESERVE_BYTES);
  });

  it('the largest message the relay can send (limit-sized body + both attributes) fits in 256 KiB', () => {
    const longestType = Math.max(...Object.values(EVENT_TYPES).map(t => t.length));
    const attributes =
      attributeBytes('eventType', 'x'.repeat(longestType)) +
      attributeBytes('correlationId', TRANSFER_SAMPLE.correlationId);
    // About 100 bytes today; the reserve is many times that.
    expect(attributes).toBeLessThan(SQS_ATTRIBUTE_RESERVE_BYTES / 4);
    expect(OUTBOX_MAX_PAYLOAD_BYTES + attributes).toBeLessThanOrEqual(SQS_MAX_MESSAGE_BYTES);
  });

  it('a real event is under 1 KiB, hundreds of times below the limit', () => {
    const size = Buffer.byteLength(JSON.stringify(TRANSFER_SAMPLE));
    expect(size).toBeLessThan(1024);
    expect(OUTBOX_MAX_PAYLOAD_BYTES / size).toBeGreaterThan(250);
  });

  it('the limit is far under what PostgreSQL jsonb refuses (268 435 455 bytes, 54000)', () => {
    expect(OUTBOX_MAX_PAYLOAD_BYTES).toBeLessThan(268_435_455);
  });
});
