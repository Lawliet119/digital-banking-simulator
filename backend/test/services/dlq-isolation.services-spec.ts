import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import type { DomainEvent } from '@common/events';
import { dlqUrlFor } from '@common/messaging';
import { TransactionService } from '@database/transaction.service';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { SqsClient, type BatchResult, type SqsMessage } from '@libs/sqs';
import { NotificationConsumer } from '@modules/notification';
import { OutboxRelayService } from '@modules/outbox';
import { AuditService } from '@modules/audit';
import { RiskScoringConsumer } from '@modules/risk/risk-scoring.consumer';
import { checkLedgerInvariants } from '../support/invariants';
import { startDepositApp } from '../support/deposit-app';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import { buildRiskConsumer, eventFor, riskFixtures } from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

const eventIdOf = (body: unknown) => String((body as { eventId?: unknown } | null)?.eventId);

/** Counts every `handle` per eventId and the receive count SQS reported for it. */
class CountingRisk extends RiskScoringConsumer {
  readonly handled = new Map<string, number>();
  override consumeOnce(waitTimeSeconds = 1, visibilityTimeout?: number): Promise<BatchResult[]> {
    return super.consumeOnce(waitTimeSeconds, visibilityTimeout);
  }
  override handle(body: unknown, message?: SqsMessage): Promise<void> {
    this.handled.set(eventIdOf(body), (this.handled.get(eventIdOf(body)) ?? 0) + 1);
    return super.handle(body, message);
  }
}

/**
 * The production notification consumer, with a store that fails for transfers from the chosen
 * source accounts (DBS-125 decision G1-1): it writes, then throws, so the transaction rolls back
 * like a real database error. No backoff and a 1-second visibility, so five receives take seconds.
 */
class TestNotification extends NotificationConsumer {
  readonly failFrom = new Set<string>();
  readonly handled = new Map<string, number>();
  readonly receiveCounts = new Map<string, string[]>();
  readonly messageIds = new Map<string, string[]>();
  protected override get retryBackoffSeconds(): number {
    return 0;
  }
  override consumeOnce(waitTimeSeconds = 1, visibilityTimeout = 1): Promise<BatchResult[]> {
    return super.consumeOnce(waitTimeSeconds, visibilityTimeout);
  }
  override handle(body: unknown, message?: SqsMessage): Promise<void> {
    const id = eventIdOf(body);
    this.handled.set(id, (this.handled.get(id) ?? 0) + 1);
    const count = message?.Attributes?.ApproximateReceiveCount;
    if (count) this.receiveCounts.set(id, [...(this.receiveCounts.get(id) ?? []), count]);
    if (message?.MessageId) {
      this.messageIds.set(id, [...(this.messageIds.get(id) ?? []), message.MessageId]);
    }
    return super.handle(body, message);
  }
  protected override async apply(event: DomainEvent, manager: EntityManager): Promise<void> {
    await super.apply(event, manager);
    if (
      event.eventType === 'TransferCompleted' &&
      event.type === 'TRANSFER' &&
      this.failFrom.has(event.fromAccountId)
    ) {
      throw new Error('notification store failed');
    }
  }
}

/**
 * DBS-125: a notification consumer that keeps failing dead-letters its message after exactly five
 * receives while the risk consumer goes on; broken messages go to the DLQ at once; and the runbook's
 * redrive (StartMessageMoveTask with an explicit destination) brings a message back for exactly one
 * successful handling. Real PostgreSQL, Valkey, ElasticMQ, relay and both consumers' loops.
 * Design: docs/features/DBS-125-dlq-isolation-runbook.md.
 */
describe('DBS-125 a failing consumer dead-letters alone; broken messages; redrive', () => {
  let mq: StartedElasticMq;
  let valkey: StartedValkey;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let admin: SQSClient;
  let redis: RedisClient;
  let tx: TransactionService;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let fx: ReturnType<typeof riskFixtures>;
  let riskUrl: string;
  let notificationUrl: string;
  const pino = new PinoLogger({ pinoHttp: { level: 'silent' } } as never);
  const running: { beforeApplicationShutdown(): Promise<void> }[] = [];
  const saved = {
    role: process.env.APP_ROLE,
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
  };
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) =>
    db.runner.query(sql, args) as Promise<T[]>;
  const n = async (sql: string, args: unknown[] = []) =>
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, args))[0].n;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  async function until(check: () => Promise<boolean>, what: string, ms = 60_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await wait(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  async function onQueue(url: string): Promise<number> {
    const { Attributes = {} } = await admin.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    );
    return Object.values(Attributes).reduce((sum, value) => sum + Number(value), 0);
  }
  /** Looks at a DLQ without taking anything (visibility 0); DLQs have no redrive policy. */
  async function peekBodies(url: string): Promise<string[]> {
    return (await peek(url)).map(m => m.body);
  }
  async function peek(url: string): Promise<{ id: string; body: string }[]> {
    const { Messages = [] } = await admin.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 0,
        WaitTimeSeconds: 1,
      }),
    );
    return Messages.map(m => ({ id: m.MessageId ?? '', body: m.Body ?? '' }));
  }
  async function arnOf(url: string): Promise<string> {
    const { Attributes = {} } = await admin.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
    );
    return Attributes.QueueArn!;
  }
  const queues = () => [riskUrl, notificationUrl, dlqUrlFor(riskUrl), dlqUrlFor(notificationUrl)];
  const quiet = async () =>
    (await n('outbox_events WHERE published_at IS NULL')) === 0 &&
    (await onQueue(riskUrl)) === 0 &&
    (await onQueue(notificationUrl)) === 0;

  function start<
    T extends { onApplicationBootstrap(): void; beforeApplicationShutdown(): Promise<void> },
  >(component: T): T {
    component.onApplicationBootstrap();
    running.push(component);
    return component;
  }
  async function stop(component: { beforeApplicationShutdown(): Promise<void> }) {
    await component.beforeApplicationShutdown();
    running.splice(running.indexOf(component), 1);
  }
  const config = () =>
    ({
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    }) as never;
  const relay = () => start(new OutboxRelayService(tx, sqs, config()));
  const notification = () =>
    start(new TestNotification(tx, sqs, pino, config(), new AuditService(tx)));
  function risk(): CountingRisk {
    const parts = buildRiskConsumer(source, {
      redis,
      sqs,
      queueUrl: riskUrl,
      make: (...args) => new CountingRisk(...args),
    });
    return start(parts.consumer as CountingRisk);
  }
  /** AC-9.1 source: new account, 21M deposited, consumed by both queues before the test acts. */
  async function ac91Source() {
    const from = await fx.customer('Trần Văn An');
    const to = await fx.customer('Nguyễn Thị Bình');
    await fx.deposit(from.accounts[0], '21000000');
    await until(quiet, 'the deposit to be consumed');
    return { token: from.token, from: from.accounts[0], to: to.accounts[0] };
  }
  /** The scenario of TC-125-01: the chosen transfer's notification ends in the DLQ. */
  async function deadLetteredTransfer(failing: TestNotification) {
    const s = await ac91Source();
    failing.failFrom.add(s.from); // set before the request: no race with the relay
    const transferId = await fx.transfer(s.token, s.from, s.to, '20000000');
    const eventId = String((await eventFor(db.runner, transferId)).eventId);
    await until(
      async () =>
        (failing.handled.get(eventId) ?? 0) >= 5 &&
        (await onQueue(notificationUrl)) === 0 &&
        (await onQueue(dlqUrlFor(notificationUrl))) === 1,
      'the notification to be dead-lettered',
    );
    return { transferId, eventId };
  }

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    process.env.APP_ROLE = 'both';
    mq = await startElasticMqContainer();
    valkey = await startValkeyContainer();
    riskUrl = new URL('/000000000000/risk-events', mq.endpoint).toString();
    notificationUrl = new URL('/000000000000/notification-events', mq.endpoint).toString();
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 10 },
    }).initialize();
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    admin = new SQSClient({
      region: 'us-east-1',
      endpoint: mq.endpoint,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    redis = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    await until(() => Promise.resolve(redis.isReady), 'Valkey', 10_000);
    tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    app = await startDepositApp(db.url);
    fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));
  });
  beforeEach(async () => {
    // Each test stands alone: nothing left on any queue by the one before it.
    for (const url of queues()) await admin.send(new PurgeQueueCommand({ QueueUrl: url }));
  });
  afterEach(async () => {
    for (const component of [...running].reverse()) await stop(component);
    expect((await checkLedgerInvariants(db.runner)).violations).toEqual([]);
  });
  afterAll(async () => {
    try {
      await app?.close();
      redis?.onModuleDestroy();
      sqs?.onApplicationShutdown();
      admin?.destroy();
      await source?.destroy();
      await db?.drop();
      await valkey?.stop();
      await mq?.stop();
    } finally {
      restore('APP_ROLE', saved.role);
      restore('AWS_ACCESS_KEY_ID', saved.key);
      restore('AWS_SECRET_ACCESS_KEY', saved.secret);
    }
  });

  it('TC-125-01 notification failing every time dead-letters its message after exactly 5 receives, while risk flags the same transfer', async () => {
    relay();
    const riskConsumer = risk();
    const failing = notification();
    const { transferId, eventId } = await deadLetteredTransfer(failing);

    expect(failing.handled.get(eventId)).toBe(5);
    expect(failing.receiveCounts.get(eventId)).toEqual(['1', '2', '3', '4', '5']);
    const dead = (await peek(dlqUrlFor(notificationUrl))).filter(m => m.body.includes(eventId));
    expect(dead).toHaveLength(1);
    // It is ConsumerBase's copy (a new MessageId), not ElasticMQ's own redrive at the 6th receive,
    // which would move the original message with its id: the limit tested is MAX_ATTEMPTS = 5.
    expect(failing.messageIds.get(eventId)).not.toContain(dead[0].id);
    expect(await n('notification_log WHERE event_id = $1', [eventId])).toBe(0);
    expect(
      await n("processed_events WHERE consumer = 'notification' AND event_id = $1", [eventId]),
    ).toBe(0);

    // Risk was never held up by the failing consumer.
    expect(riskConsumer.handled.get(eventId)).toBe(1);
    expect(
      await q('SELECT score, risk_level FROM fraud_flags WHERE transfer_id = $1', [transferId]),
    ).toEqual([{ score: 65, risk_level: 'MEDIUM' }]);
    expect(await n("processed_events WHERE consumer = 'risk' AND event_id = $1", [eventId])).toBe(
      1,
    );
    expect(await onQueue(dlqUrlFor(riskUrl))).toBe(0);
  });

  it('TC-125-02 a body that is not JSON and one that breaks the schema go to each DLQ at the first receive; the next valid event is processed by both', async () => {
    relay();
    const riskConsumer = risk();
    const healthy = notification();
    for (const url of [riskUrl, notificationUrl]) {
      await sqs.send(url, '{not json');
      await sqs.send(url, JSON.stringify({ eventType: 'TransferCompleted' }));
    }
    const s = await ac91Source(); // a valid event after the broken ones (its deposit)
    const transferId = await fx.transfer(s.token, s.from, s.to, '20000000');
    const eventId = String((await eventFor(db.runner, transferId)).eventId);
    await until(
      async () =>
        (await quiet()) &&
        (await onQueue(dlqUrlFor(riskUrl))) === 2 &&
        (await onQueue(dlqUrlFor(notificationUrl))) === 2 &&
        (await n('processed_events WHERE event_id = $1', [eventId])) === 2,
      'the broken messages to be dead-lettered and the valid one processed',
    );
    for (const consumer of [riskConsumer, healthy]) {
      // `{not json` never reaches the handler; the schema-broken body (no eventId) is handled once.
      expect(consumer.handled.get('undefined')).toBe(1);
      expect(consumer.handled.get(eventId)).toBe(1);
    }
    for (const url of [dlqUrlFor(riskUrl), dlqUrlFor(notificationUrl)]) {
      expect((await peekBodies(url)).sort()).toEqual([
        '{"eventType":"TransferCompleted"}',
        '{not json',
      ]);
    }
    expect(await n('notification_log WHERE event_id = $1', [eventId])).toBe(2);
    expect(await n('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(1);
  });

  it('TC-125-03 the runbook redrive (explicit destination ARN) brings the message back for exactly one successful handling', async () => {
    relay();
    risk();
    const failing = notification();
    const { eventId } = await deadLetteredTransfer(failing);
    await stop(failing);
    const healed = notification(); // the "fixed" consumer

    await admin.send(
      new StartMessageMoveTaskCommand({
        SourceArn: await arnOf(dlqUrlFor(notificationUrl)),
        DestinationArn: await arnOf(notificationUrl),
      }),
    );
    await until(
      async () =>
        (await n('notification_log WHERE event_id = $1', [eventId])) === 2 &&
        (await onQueue(dlqUrlFor(notificationUrl))) === 0 &&
        (await onQueue(notificationUrl)) === 0,
      'the redriven message to be processed',
      30_000,
    );
    expect(healed.handled.get(eventId)).toBe(1);
    expect(await n('notification_log WHERE event_id = $1', [eventId])).toBe(2);
    expect(
      await n("processed_events WHERE consumer = 'notification' AND event_id = $1", [eventId]),
    ).toBe(1);
  });
});
