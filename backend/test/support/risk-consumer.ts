import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import type { DataSource, QueryRunner } from 'typeorm';
import { RedisUnavailableError } from '@libs/redis';
import type { SqsClient } from '@libs/sqs';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from '@modules/audit/audit.service';
import { RuleSetRepository, type RuleSetRedis } from '@modules/risk/config/rule-set.repository';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import { TransferFacts } from '@modules/risk/features/transfer-facts';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { RiskScoringConsumer } from '@modules/risk/risk-scoring.consumer';
import { ScoringService } from '@modules/risk/scoring.service';
import { RiskAiService } from '@modules/risk/ai/risk-ai.service';
import type { startDepositApp } from './deposit-app';

type App = Awaited<ReturnType<typeof startDepositApp>>;
const unavailable = () => Promise.reject(new RedisUnavailableError('UNAVAILABLE'));

/** Redis configuration cache is down; feature aggregates always come from PostgreSQL. */
export const downRedis = {
  get: unavailable,
  set: unavailable,
  serverTimeMs: unavailable,
  readExpiringVersion: unavailable,
  setVersionBefore: unavailable,
  setIfAbsent: unavailable,
} as unknown as RuleSetRedis;

export interface RiskConsumerParts {
  consumer: RiskScoringConsumer;
  provider: OnlineFeatureProvider;
  scoring: ScoringService;
  audit: AuditService;
  tx: TransactionService;
}

/**
 * The production consumer, built by hand on a DataSource (the owner, or a `dbs_worker` login) so a
 * test can call `handle(payload)` directly. `make` lets a test pass a subclass.
 */
export function buildRiskConsumer(
  source: DataSource,
  options: {
    redis?: RuleSetRedis;
    queueUrl?: string;
    sqs?: SqsClient;
    ai?: RiskAiService;
    make?: (...args: ConstructorParameters<typeof RiskScoringConsumer>) => RiskScoringConsumer;
  } = {},
): RiskConsumerParts {
  const tx = new TransactionService(source, {
    lockTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    idleInTransactionTimeoutMs: 10000,
  } as never);
  const metrics = new RiskMetrics();
  const redis = options.redis ?? downRedis;
  const provider = new OnlineFeatureProvider({
    facts: new TransferFacts(source),
    perTxLimit: 50_000_000n,
  });
  const ruleSets = new RuleSetRepository({ redis, db: source, metrics });
  const scoring = new ScoringService();
  const audit = new AuditService(tx);
  const pino = new PinoLogger({ pinoHttp: { level: 'silent' } } as never);
  const sqs = options.sqs ?? ({} as SqsClient);
  const config = { riskQueueUrl: options.queueUrl } as never;
  const args: ConstructorParameters<typeof RiskScoringConsumer> = [
    tx,
    sqs,
    pino,
    config,
    ruleSets,
    provider,
    scoring,
    audit,
    source,
    options.ai ?? new RiskAiService(),
  ];
  const consumer = options.make ? options.make(...args) : new RiskScoringConsumer(...args);
  return { consumer, provider, scoring, audit, tx };
}

/** HTTP helpers on the real deposit app: onboarding, accounts, deposits and transfers. */
export function riskFixtures(app: App, operatorToken: string) {
  return {
    async customer(fullName: string, types: string[] = ['CHECKING']) {
      const sub = randomUUID();
      const token = await app.issuer.token('customer', { sub });
      await request(app.url)
        .post('/v1/customers/me')
        .auth(token, { type: 'bearer' })
        .send({ fullName })
        .expect(200);
      const accounts: string[] = [];
      for (const type of types) {
        const res = await request(app.url)
          .post('/v1/accounts')
          .auth(token, { type: 'bearer' })
          .send({ type })
          .expect(201);
        accounts.push(res.body.id as string);
      }
      return { sub, token, accounts };
    },
    async deposit(accountId: string, amount: string) {
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operatorToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: accountId, amount })
        .expect(201);
    },
    async transfer(token: string, fromAccountId: string, toAccountId: string, amount: string) {
      const res = await request(app.url)
        .post('/v1/transfers')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ fromAccountId, toAccountId, amount })
        .expect(201);
      return res.body.transferId as string;
    },
  };
}

/** The exact TransferCompleted payload the relay would send for this transfer. */
export async function eventFor(
  runner: Pick<QueryRunner, 'query'>,
  transferId: string,
): Promise<Record<string, unknown>> {
  const rows = (await runner.query(
    `SELECT payload FROM outbox_events
      WHERE event_type = 'TransferCompleted' AND payload->>'transferId' = $1`,
    [transferId],
  )) as { payload: Record<string, unknown> }[];
  if (rows.length !== 1) throw new Error(`expected one TransferCompleted for ${transferId}`);
  return rows[0].payload;
}
