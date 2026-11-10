import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { dlqUrlFor } from '@common/messaging';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { SqsClient, type BatchResult, type SqsMessage } from '@libs/sqs';
import { OutboxRelayService } from '@modules/outbox';
import { RiskScoringConsumer } from '@modules/risk/risk-scoring.consumer';
import { checkLedgerInvariants } from '../support/invariants';
import { startDepositApp } from '../support/deposit-app';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import {
  buildRiskConsumer,
  eventFor,
  riskFixtures,
  type RiskConsumerParts,
} from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

/** Production consumer, 1-second long poll, the queue's own visibility timeout (30 s). */
class FastPollConsumer extends RiskScoringConsumer {
  override consumeOnce(waitTimeSeconds = 1, visibilityTimeout?: number): Promise<BatchResult[]> {
    return super.consumeOnce(waitTimeSeconds, visibilityTimeout);
  }
}

/**
 * Commits one chosen event and then "dies" before the message is deleted, exactly once: the batch
 * handler throws, so `processBatch` leaves the message on the queue and SQS hands it out again when
 * the 2-second visibility runs out. Only this consumer uses 2 s (TC-124-02).
 */
class DyingConsumer extends RiskScoringConsumer {
  target: string | undefined;
  died = false;
  readonly handled = new Map<string, number>();
  override consumeOnce(waitTimeSeconds = 1, visibilityTimeout = 2): Promise<BatchResult[]> {
    return super.consumeOnce(waitTimeSeconds, visibilityTimeout);
  }
  override async handle(body: unknown, message?: SqsMessage): Promise<void> {
    const eventId = String((body as { eventId?: unknown })?.eventId);
    this.handled.set(eventId, (this.handled.get(eventId) ?? 0) + 1);
    await super.handle(body, message);
    if (eventId === this.target && !this.died) {
      this.died = true;
      throw new Error('worker died after the commit, before the delete');
    }
  }
}

interface Worker {
  relay: OutboxRelayService;
  parts: RiskConsumerParts;
}

/**
 * DBS-124: a worker that is away, or dies, loses no event and no flag. Real HTTP app, PostgreSQL,
 * Valkey, ElasticMQ, and the real relay and consumer loops; a "new worker" is a new set of
 * instances, as a restarted process builds them (empty relay state, fresh rule-set cache, counters
 * invalidated). Design: docs/features/DBS-124-worker-down-recovery.md.
 */
describe('DBS-124 worker stop, crash and restart (real PostgreSQL, Valkey, ElasticMQ)', () => {
  let mq: StartedElasticMq;
  let valkey: StartedValkey;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let attributes: SQSClient;
  let redis: RedisClient;
  let tx: TransactionService;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let fx: ReturnType<typeof riskFixtures>;
  let riskUrl: string;
  let notificationUrl: string;
  const running: Worker[] = [];
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
  /** Visible + in flight + delayed: 0 means the queue really is drained (an ack runs after the commit). */
  async function onQueue(url: string): Promise<number> {
    const { Attributes = {} } = await attributes.send(
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
  const unpublished = () => n('outbox_events WHERE published_at IS NULL');
  const settled = async () => (await unpublished()) === 0 && (await onQueue(riskUrl)) === 0;

  function startWorker(
    make: (...args: ConstructorParameters<typeof RiskScoringConsumer>) => RiskScoringConsumer = (
      ...args
    ) => new FastPollConsumer(...args),
  ): Worker {
    const relay = new OutboxRelayService(tx, sqs, {
      region: 'us-east-1',
      endpoint: mq.endpoint,
      riskQueueUrl: riskUrl,
      notificationQueueUrl: notificationUrl,
    });
    const parts = buildRiskConsumer(source, { redis, sqs, queueUrl: riskUrl, make });
    relay.onApplicationBootstrap();
    parts.consumer.onApplicationBootstrap();
    const worker = { relay, parts };
    running.push(worker);
    return worker;
  }
  async function stopWorker(worker: Worker) {
    await worker.parts.consumer.onApplicationShutdown();
    await worker.relay.onApplicationShutdown();
    running.splice(running.indexOf(worker), 1);
  }

  /** A new source account that sends once, to a new recipient who never sends back (no R1/R2/R4/R5). */
  async function source_(name: string, deposit: string) {
    const from = await fx.customer(name);
    const to = await fx.customer(`Người nhận của ${name}`);
    await fx.deposit(from.accounts[0], deposit);
    return { token: from.token, from: from.accounts[0], to: to.accounts[0] };
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
    attributes = new SQSClient({
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
  afterEach(async () => {
    for (const worker of [...running]) await stopWorker(worker);
    expect((await checkLedgerInvariants(db.runner)).violations).toEqual([]);
  });
  afterAll(async () => {
    try {
      await app?.close();
      redis?.onModuleDestroy();
      sqs?.onModuleDestroy();
      attributes?.destroy();
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

  it('TC-124-01 with the worker stopped 12 transfers wait in the outbox; a new worker catches up: 6 flags of 65 with one audit and R3+R6 each, 6 LOW without, queue drained, DLQ empty', async () => {
    const first = startWorker();
    const flaggable: Awaited<ReturnType<typeof source_>>[] = [];
    const low: Awaited<ReturnType<typeof source_>>[] = [];
    for (let i = 1; i <= 6; i++) {
      flaggable.push(await source_(`Trần Văn An ${i}`, '21000000'));
      low.push(await source_(`Lê Thị Mai ${i}`, '5000000'));
    }
    await until(settled, 'the deposits to be consumed');
    await stopWorker(first);

    const flagIds: string[] = [];
    const lowIds: string[] = [];
    for (const s of flaggable) flagIds.push(await fx.transfer(s.token, s.from, s.to, '20000000'));
    for (const s of low) lowIds.push(await fx.transfer(s.token, s.from, s.to, '1000000'));
    const ids = [...flagIds, ...lowIds];
    expect(await unpublished()).toBe(12);
    expect(
      await n(
        "outbox_events WHERE published_at IS NULL AND event_type = 'TransferCompleted' AND (payload->>'transferId')::uuid = ANY($1::uuid[])",
        [ids],
      ),
    ).toBe(12);
    expect(await n('risk_decisions WHERE transfer_id = ANY($1::uuid[])', [ids])).toBe(0);

    startWorker();
    await until(
      async () =>
        (await n('risk_decisions WHERE transfer_id = ANY($1::uuid[])', [ids])) === 12 &&
        (await settled()),
      'the new worker to catch up',
    );

    const flags = await q<{
      transfer_id: string;
      score: number;
      risk_level: string;
      rules: string;
      audits: number;
    }>(
      `SELECT f.transfer_id, f.score, f.risk_level,
              (SELECT string_agg(rule_id, ',' ORDER BY rule_id) FROM fraud_rule_hits h WHERE h.transfer_id = f.transfer_id) AS rules,
              (SELECT count(*)::int FROM audit_log a WHERE a.action = 'fraud.flagged' AND a.target_id = f.transfer_id::text) AS audits
         FROM fraud_flags f WHERE f.transfer_id = ANY($1::uuid[])`,
      [ids],
    );
    expect(flags.map(f => f.transfer_id).sort()).toEqual([...flagIds].sort());
    for (const flag of flags) {
      expect(flag).toMatchObject({ score: 65, risk_level: 'MEDIUM', rules: 'R3,R6', audits: 1 });
    }
    expect(
      await n("audit_log WHERE action = 'fraud.flagged' AND target_id = ANY($1::text[])", [lowIds]),
    ).toBe(0);
    expect(await onQueue(dlqUrlFor(riskUrl))).toBe(0);
  });

  it('TC-124-02 a consumer that dies after the commit and before the delete gets the message again; still one decision, one flag, one audit, DLQ empty', async () => {
    const helper = startWorker();
    const s = await source_('Phạm Văn Cường', '21000000');
    await until(settled, 'the deposit to be consumed');
    await stopWorker(helper); // no other consumer may take the chosen message

    const transferId = await fx.transfer(s.token, s.from, s.to, '20000000');
    const eventId = String((await eventFor(db.runner, transferId)).eventId);
    let dying!: DyingConsumer;
    startWorker((...args) => {
      dying = new DyingConsumer(...args);
      dying.target = eventId;
      return dying;
    });
    await until(
      async () =>
        dying.died &&
        (dying.handled.get(eventId) ?? 0) >= 2 &&
        (await n('risk_decisions WHERE transfer_id = $1', [transferId])) === 1 &&
        (await settled()),
      'the redelivery to be handled',
    );
    expect(dying.handled.get(eventId)).toBeGreaterThanOrEqual(2);
    expect(await n('risk_decisions WHERE transfer_id = $1', [transferId])).toBe(1);
    expect(await n('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(1);
    expect(
      await n("audit_log WHERE action = 'fraud.flagged' AND target_id = $1", [transferId]),
    ).toBe(1);
    expect(await n("processed_events WHERE consumer = 'risk' AND event_id = $1", [eventId])).toBe(
      1,
    );
    expect(await onQueue(dlqUrlFor(riskUrl))).toBe(0);
  });
});
