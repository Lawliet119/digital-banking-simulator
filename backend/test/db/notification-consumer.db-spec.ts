import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { NotificationConsumer } from '@modules/notification';
import { AuditService } from '@modules/audit';
import { TransactionService } from '@database/transaction.service';
import type { SqsClient } from '@libs/sqs';
import {
  ACCOUNT_ACTIVE_SAMPLE,
  ACCOUNT_LOCKED_SAMPLE,
  DEPOSIT_SAMPLE,
  TRANSFER_SAMPLE,
} from '../support/event-samples';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

type Row = { user_id: string; kind: string; message: string };

/** DBS-102: who gets a notification_log row, and what the text may say, on real PostgreSQL. */
describe('NotificationConsumer (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  let consumer: NotificationConsumer;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const rows = async (eventId: string) =>
    (await q('SELECT user_id,kind,message FROM notification_log WHERE event_id=$1 ORDER BY id', [
      eventId,
    ])) as Row[];
  const FORBIDDEN = /gian lận|nghi ngờ|nghi vấn|lý do|fraud|suspicious|reason|risk|điểm rủi ro/i;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    for (const id of [
      TRANSFER_SAMPLE.fromUserId,
      TRANSFER_SAMPLE.toUserId,
      DEPOSIT_SAMPLE.toUserId,
      ACCOUNT_LOCKED_SAMPLE.ownerUserId,
    ]) {
      await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        randomUUID(),
      ]);
    }
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    consumer = new NotificationConsumer(
      tx,
      {} as SqsClient,
      new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
      { notificationQueueUrl: 'http://localhost:9324/000000000000/notification-events' } as never,
      new AuditService(tx),
    );
  });
  afterAll(async () => {
    await source?.destroy();
    await db?.drop();
  });

  it('TC-102-01 a transfer between two owners tells the sender and the recipient, each in their own words', async () => {
    const event = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    await consumer.handle(event);
    const found = await rows(event.eventId);
    expect(found.map(r => r.user_id).sort()).toEqual(
      [TRANSFER_SAMPLE.fromUserId, TRANSFER_SAMPLE.toUserId].sort(),
    );
    const sender = found.find(r => r.user_id === TRANSFER_SAMPLE.fromUserId)!;
    const receiver = found.find(r => r.user_id === TRANSFER_SAMPLE.toUserId)!;
    expect(sender.kind).toBe('transfer_completed');
    expect(receiver.kind).toBe('transfer_completed');
    expect(sender.message).toBe('Bạn đã chuyển tiền thành công');
    expect(receiver.message).toBe('Tài khoản của bạn vừa nhận tiền');
  });

  it('TC-134-03 every notice carries the correlationId of its event', async () => {
    const transfer = { ...TRANSFER_SAMPLE, eventId: randomUUID(), correlationId: randomUUID() };
    const status = { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID(), correlationId: randomUUID() };
    await consumer.handle(transfer);
    await consumer.handle(status);
    const ids = async (eventId: string) =>
      (
        (await q('SELECT correlation_id FROM notification_log WHERE event_id=$1', [eventId])) as {
          correlation_id: string | null;
        }[]
      ).map(r => r.correlation_id);
    expect(await ids(transfer.eventId)).toEqual([transfer.correlationId, transfer.correlationId]);
    expect(await ids(status.eventId)).toEqual([status.correlationId]);
  });

  it('TC-102-01 a transfer between two accounts of one owner writes one row', async () => {
    const event = {
      ...TRANSFER_SAMPLE,
      eventId: randomUUID(),
      sameOwner: true,
      toUserId: TRANSFER_SAMPLE.fromUserId,
    };
    await consumer.handle(event);
    const found = await rows(event.eventId);
    expect(found).toEqual([
      {
        user_id: TRANSFER_SAMPLE.fromUserId,
        kind: 'transfer_completed',
        message: 'Bạn đã chuyển tiền thành công',
      },
    ]);
  });

  it('TC-102-01 a deposit tells only the owner of the destination account', async () => {
    const event = { ...DEPOSIT_SAMPLE, eventId: randomUUID() };
    await consumer.handle(event);
    expect(await rows(event.eventId)).toEqual([
      {
        user_id: DEPOSIT_SAMPLE.toUserId,
        kind: 'transfer_completed',
        message: 'Tài khoản của bạn vừa được nạp tiền',
      },
    ]);
  });

  it('TC-102-01 an account status change tells the owner', async () => {
    const event = { ...ACCOUNT_ACTIVE_SAMPLE, eventId: randomUUID() };
    await consumer.handle(event);
    expect(await rows(event.eventId)).toEqual([
      {
        user_id: ACCOUNT_ACTIVE_SAMPLE.ownerUserId,
        kind: 'account_status_changed',
        message: 'Tài khoản của bạn đã được mở khóa',
      },
    ]);
  });

  it('TC-102-02 the lock notice never states a reason (BR-13), even if the event carries extra fields', async () => {
    const event = {
      ...ACCOUNT_LOCKED_SAMPLE,
      eventId: randomUUID(),
      note: 'Nghi ngờ gian lận, risk score 90',
    };
    await consumer.handle(event);
    const [row] = await rows(event.eventId);
    expect(row.user_id).toBe(ACCOUNT_LOCKED_SAMPLE.ownerUserId);
    expect(row.kind).toBe('account_status_changed');
    expect(row.message).toBe(
      'Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ ngân hàng để được hỗ trợ',
    );
    expect(row.message).not.toMatch(FORBIDDEN);
  });

  it('TC-102-02 no message the consumer can write names a reason or a risk', async () => {
    const all = await q('SELECT DISTINCT message FROM notification_log');
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const { message } of all as { message: string }[]) expect(message).not.toMatch(FORBIDDEN);
  });

  it('TC-102-05 an event received again writes nothing more', async () => {
    const event = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    await consumer.handle(event);
    await consumer.handle(event);
    expect(await rows(event.eventId)).toHaveLength(2);
  });

  it('TC-102-06 a recipient that is not a user rolls the whole event back, so nothing is half-written', async () => {
    const event = { ...TRANSFER_SAMPLE, eventId: randomUUID(), toUserId: randomUUID() };
    await expect(consumer.handle(event)).rejects.toThrow();
    expect(await rows(event.eventId)).toEqual([]);
    expect(await q('SELECT 1 FROM processed_events WHERE event_id=$1', [event.eventId])).toEqual(
      [],
    );
  });

  /** DBS-135: the audit line of one notification event, found by the event's correlationId. */
  const auditLines = async (correlationId: string) =>
    q(
      `SELECT actor_user_id, actor_role, action, outcome, target_type, target_id, metadata
         FROM audit_log WHERE correlation_id = $1 AND action = 'notification.sent'`,
      [correlationId],
    );

  it('TC-135-06 a transfer between two owners writes one notification.sent audit line with the count only', async () => {
    const event = { ...TRANSFER_SAMPLE, eventId: randomUUID(), correlationId: randomUUID() };
    await consumer.handle(event);
    expect(await rows(event.eventId)).toHaveLength(2);
    expect(await auditLines(event.correlationId)).toEqual([
      {
        actor_user_id: null,
        actor_role: 'worker',
        action: 'notification.sent',
        outcome: 'SUCCESS',
        target_type: 'transfer',
        target_id: event.transferId,
        metadata: { count: 2 },
      },
    ]);
  });

  it('TC-135-07 an account status change, a deposit and a transfer to oneself each write one line with the right target', async () => {
    const status = { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID(), correlationId: randomUUID() };
    const deposit = { ...DEPOSIT_SAMPLE, eventId: randomUUID(), correlationId: randomUUID() };
    const own = {
      ...TRANSFER_SAMPLE,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      sameOwner: true,
      toUserId: TRANSFER_SAMPLE.fromUserId,
    };
    for (const event of [status, deposit, own]) await consumer.handle(event);
    const brief = async (id: string) =>
      (await auditLines(id)).map(r => [r.target_type, r.target_id, r.metadata]);
    expect(await brief(status.correlationId)).toEqual([
      ['account', status.accountId, { count: 1 }],
    ]);
    expect(await brief(deposit.correlationId)).toEqual([
      ['transfer', deposit.transferId, { count: 1 }],
    ]);
    expect(await brief(own.correlationId)).toEqual([['transfer', own.transferId, { count: 1 }]]);
  });

  it('TC-135-08 the same event handled twice leaves one audit line and one set of notices', async () => {
    const event = { ...TRANSFER_SAMPLE, eventId: randomUUID(), correlationId: randomUUID() };
    await consumer.handle(event);
    await consumer.handle(event); // SQS redelivery, or a relay that sent it twice
    expect(await auditLines(event.correlationId)).toHaveLength(1);
    expect(await rows(event.eventId)).toHaveLength(2);
  });

  it('TC-135-09 an audit INSERT that fails rolls back the notices and the claim, and the retry succeeds', async () => {
    const event = { ...TRANSFER_SAMPLE, eventId: randomUUID(), correlationId: randomUUID() };
    await q(`CREATE FUNCTION public.refuse_notification_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'audit refused'; END $$`);
    await q(`CREATE TRIGGER refuse_notification_audit BEFORE INSERT ON audit_log
      FOR EACH ROW WHEN (NEW.action = 'notification.sent')
      EXECUTE FUNCTION public.refuse_notification_audit()`);
    try {
      await expect(consumer.handle(event)).rejects.toThrow();
      expect(await rows(event.eventId)).toEqual([]);
      expect(await q('SELECT 1 FROM processed_events WHERE event_id=$1', [event.eventId])).toEqual(
        [],
      );
    } finally {
      await q('DROP TRIGGER refuse_notification_audit ON audit_log');
      await q('DROP FUNCTION public.refuse_notification_audit()');
    }
    await consumer.handle(event);
    expect(await rows(event.eventId)).toHaveLength(2);
    expect(await auditLines(event.correlationId)).toHaveLength(1);
  });
});
