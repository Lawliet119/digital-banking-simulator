import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { installSilentRootLogger } from '../support/silent-root-logger';
import { DataSource } from 'typeorm';
import type { ConsumerBase } from '@common/messaging';
import { TransactionService } from '@database/transaction.service';
import { SqsClient } from '@libs/sqs';
import { AuditService } from '@modules/audit';
import { NotificationConsumer } from '@modules/notification';
import { ACCOUNT_LOCKED_SAMPLE, DEPOSIT_SAMPLE, TRANSFER_SAMPLE } from '../support/event-samples';
import {
  localSqsClient,
  startElasticMqContainer,
  type StartedElasticMq,
} from '../support/elasticmq.container';
import { buildRiskConsumer } from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

installSilentRootLogger();

/** Every table a consumer can write to when it handles an event (and the claim itself). */
const EFFECT_TABLES = [
  'processed_events',
  'notification_log',
  'risk_decisions',
  'fraud_flags',
  'fraud_rule_hits',
  'audit_log',
  'outbox_events',
] as const;

interface Subject {
  name: string;
  /** What `unknownEventPolicy` says for this consumer (BL-010): both dead-letter, risk says it out loud. */
  unknownPolicy: 'dead-letter';
  make(url: string): ConsumerBase;
  /** A valid event of the kind this consumer owns, to prove it is still alive after the poison. */
  valid(): Record<string, unknown>;
}

/**
 * BL-010: each consumer (risk and notification) against a real SQS protocol server (ElasticMQ) and
 * real PostgreSQL. For every consumer: an event type it does not know follows the declared policy
 * (dead-letter), a body that breaks the schema goes to the DLQ at the first receive, and a body that
 * is not JSON goes to the DLQ with its source deleted; none of them leaves any effect or claim.
 */
describe('consumers: unknown event type, bad schema and broken JSON (real PostgreSQL + ElasticMQ)', () => {
  let mq: StartedElasticMq;
  let admin: ReturnType<typeof localSqsClient>;
  let db: TempDatabase;
  let source: DataSource;
  let sqs: SqsClient;
  let tx: TransactionService;
  const created: string[] = [];
  const oldKey = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const opts = { waitTimeSeconds: 1, visibilityTimeout: 0 };
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;

  async function queuePair(): Promise<{ url: string; dlq: string }> {
    const name = `bl010-${randomUUID()}`;
    const make = async (n: string): Promise<string> => {
      const result = await admin.send(new CreateQueueCommand({ QueueName: n }));
      const url = new URL(new URL(result.QueueUrl!).pathname, mq.endpoint).toString();
      created.push(url);
      return url;
    };
    return { url: await make(name), dlq: await make(`${name}-dlq`) };
  }
  async function snapshot(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of EFFECT_TABLES) {
      counts[table] = ((await q(`SELECT count(*)::int AS n FROM ${table}`))[0] as { n: number }).n;
    }
    return counts;
  }
  /** Receives from `queue` until `expected` bodies arrived (SQS may return short batches). */
  async function bodies(queue: string, expected: number): Promise<string[]> {
    const found: string[] = [];
    for (let i = 0; i < 10 && found.length < expected; i++) {
      for (const m of await sqs.receive(queue, { ...opts, maxMessages: 10 })) found.push(m.Body!);
    }
    return found;
  }

  const subjects: Subject[] = [
    {
      name: 'NotificationConsumer',
      unknownPolicy: 'dead-letter',
      make: url =>
        new NotificationConsumer(
          tx,
          sqs,
          { notificationQueueUrl: url } as never,
          new AuditService(tx),
        ),
      valid: () => ({ ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() }),
    },
    {
      name: 'RiskScoringConsumer',
      unknownPolicy: 'dead-letter',
      make: url => buildRiskConsumer(source, { sqs, queueUrl: url }).consumer,
      // A deposit is claimed and never scored (FR-RSK-01): a valid event that needs no features.
      valid: () => ({ ...DEPOSIT_SAMPLE, eventId: randomUUID() }),
    },
  ];

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    mq = await startElasticMqContainer();
    admin = localSqsClient(mq.endpoint);
    sqs = new SqsClient({ region: 'us-east-1', endpoint: mq.endpoint });
    db = await createTempDatabase();
    await migrate(db.url);
    for (const id of [ACCOUNT_LOCKED_SAMPLE.ownerUserId]) {
      await q('INSERT INTO users(id,cognito_sub) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        id,
        randomUUID(),
      ]);
    }
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
  });
  afterAll(async () => {
    for (const url of created) await admin.send(new DeleteQueueCommand({ QueueUrl: url }));
    sqs?.onApplicationShutdown();
    admin?.destroy();
    await source?.destroy();
    await db?.drop();
    await mq?.stop();
    if (oldKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = oldKey;
    if (oldSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
  });

  describe.each(subjects)('$name', subject => {
    /**
     * Sends `body`, receives once, and checks the whole contract of a poison message: the single
     * result of the first receive is `dead-lettered`, the source queue is empty (deleted, not just
     * hidden), the DLQ holds the exact original body, the consumer wrote nothing, and a valid event
     * sent afterwards is still processed.
     */
    async function expectDeadLetteredAtFirstReceive(body: string): Promise<void> {
      const { url, dlq } = await queuePair();
      const consumer = subject.make(url);
      const before = await snapshot();
      await sqs.send(url, body);

      const results = await consumer.consumeOnce(1, 0);
      expect(results.map(r => r.status)).toEqual(['dead-lettered']);
      expect(await sqs.receive(url, opts)).toEqual([]);
      expect(await bodies(dlq, 1)).toEqual([body]);
      expect(await snapshot()).toEqual(before);

      // Not a dead consumer: the next valid event of the same queue is applied.
      const good = subject.valid();
      await sqs.send(url, JSON.stringify(good));
      expect((await consumer.consumeOnce(1, 0)).map(r => r.status)).toEqual(['acknowledged']);
      expect(
        await q('SELECT 1 FROM processed_events WHERE event_id = $1', [good.eventId]),
      ).toHaveLength(1);
    }

    it(`TC-010-01 declares the policy "${subject.unknownPolicy}" for an unknown event type: it goes to the DLQ at the first receive and nothing is written`, async () => {
      const unknown = { ...TRANSFER_SAMPLE, eventId: randomUUID(), eventType: 'FraudFlagRaised' };
      await expectDeadLetteredAtFirstReceive(JSON.stringify(unknown));
    });

    it('TC-010-01 an event type that differs only in case is unknown too, not a schema fault of a known type', async () => {
      const unknown = {
        ...TRANSFER_SAMPLE,
        eventId: randomUUID(),
        eventType: 'transfercompleted',
      };
      await expectDeadLetteredAtFirstReceive(JSON.stringify(unknown));
    });

    it.each([
      ['a required field is missing', { ...TRANSFER_SAMPLE, amount: undefined }],
      ['a money field is a number, not a string', { ...TRANSFER_SAMPLE, amount: 500000 }],
      ['a value is outside the allowed set', { ...TRANSFER_SAMPLE, type: 'REFUND' }],
      ['the eventId is not a uuid', { ...TRANSFER_SAMPLE, eventId: 'not-a-uuid' }],
      ['only the eventType is there', { eventType: 'TransferCompleted' }],
      [
        'an AccountStatusChanged has an unknown status',
        { ...ACCOUNT_LOCKED_SAMPLE, newStatus: 'DELETED' },
      ],
    ])(
      'TC-010-02 schema fault (%s) goes to the DLQ at the first receive with no side effect',
      async (_label, event) => {
        await expectDeadLetteredAtFirstReceive(JSON.stringify({ eventId: randomUUID(), ...event }));
      },
    );

    it.each([
      ['null', 'null'],
      ['an array', '[]'],
      ['a string', '"TransferCompleted"'],
      ['a number', '42'],
    ])(
      'TC-010-02 a JSON value that is not an object (%s) is a schema fault, dead-lettered at the first receive',
      async (_label, body) => {
        await expectDeadLetteredAtFirstReceive(body);
      },
    );

    it.each([
      ['plain text', 'not json at all'],
      ['an unclosed object', '{"eventType":"TransferCompleted"'],
      ['single quotes', "{'eventType':'TransferCompleted'}"],
      ['a trailing comma', '{"eventType":"TransferCompleted",}'],
    ])(
      'TC-010-03 a body that is not JSON (%s) goes to the DLQ, the source is deleted and nothing is written',
      async (_label, body) => {
        await expectDeadLetteredAtFirstReceive(body);
      },
    );
  });
});
