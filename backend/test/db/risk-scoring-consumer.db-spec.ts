import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { register as defaultRegister } from 'prom-client';
import { DataSource } from 'typeorm';
import type { DomainEvent } from '@common/events';
import { MetricsService } from '@common/metrics';
import type { EmfDocument } from '@common/metrics/emf';
import { LATENCY_BOUNDS_MS } from '@common/metrics/latency-histogram';
import { PoisonMessageError, type SqsMessage } from '@libs/sqs';
import { RiskRuleError } from '@modules/risk/risk-rule-error';
import { RiskScoringConsumer } from '@modules/risk/risk-scoring.consumer';
import { R3NewAccountLargeTransferRule } from '@modules/risk/rules/r3-new-account-large-transfer.rule';
import { checkLedgerInvariants } from '../support/invariants';
import { startDepositApp } from '../support/deposit-app';
import { ACCOUNT_LOCKED_SAMPLE } from '../support/event-samples';
import {
  buildRiskConsumer,
  eventFor,
  riskFixtures,
  type RiskConsumerParts,
} from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * DBS-111: the risk-events consumer on real PostgreSQL. Transfers are made through the real HTTP
 * app; the event handed to the consumer is the exact outbox payload the relay would send. Redis is
 * down here, so every rule set and every count comes from SQL (the Redis path: services spec).
 * Design: docs/features/DBS-111-risk-scoring-consumer.md.
 */
const SNAPSHOT_KEYS = [
  'accountAgeHours',
  'amount',
  'distinctRecipients24h',
  'fromBalanceBefore',
  'historyCount30d',
  'medianAmount30d',
  'minutesSinceReverse',
  'newRecipients1h',
  'sameOwner',
  'txCount10m',
  'txCount1h',
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const message = (receiveCount: number): SqsMessage => ({
  MessageId: randomUUID(),
  Attributes: { ApproximateReceiveCount: String(receiveCount) },
});

describe('DBS-111 risk scoring consumer on PostgreSQL', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let source: DataSource;
  let parts: RiskConsumerParts;
  let fx: ReturnType<typeof riskFixtures>;
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) =>
    db.runner.query(sql, args) as Promise<T[]>;
  const count = async (sql: string, args: unknown[]) =>
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, args))[0].n;

  /** BRD AC-9.1: a new account with 21M sends 20M to another owner: R3 + R6 = 65, MEDIUM. */
  async function ac91() {
    const an = await fx.customer('Trần Văn An');
    const binh = await fx.customer('Nguyễn Thị Bình');
    await fx.deposit(an.accounts[0], '21000000');
    const transferId = await fx.transfer(an.token, an.accounts[0], binh.accounts[0], '20000000');
    return { transferId, event: await eventFor(db.runner, transferId) };
  }

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    fx = riskFixtures(app, await app.issuer.token('operator', { sub: randomUUID() }));
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 10 },
    }).initialize();
    parts = buildRiskConsumer(source);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const report = await checkLedgerInvariants(db.runner);
    expect(report.violations).toEqual([]);
  });
  afterAll(async () => {
    try {
      await app?.close();
      await source?.destroy();
    } finally {
      await db?.drop();
    }
  });

  it('TC-111-01 a HIGH transfer (R3 + R5 = 75) writes decision, flag, hits and audit in one go, with the event correlationId', async () => {
    const giang = await fx.customer('Lê Thu Giang');
    await fx.deposit(giang.accounts[0], '40000000');
    for (const name of ['Phạm Văn Hải', 'Đỗ Thị Hoa', 'Vũ Minh Khang', 'Bùi Ngọc Lan']) {
      const to = await fx.customer(name);
      await fx.transfer(giang.token, giang.accounts[0], to.accounts[0], '100000');
    }
    const fifth = await fx.customer('Hoàng Văn Minh');
    const transferId = await fx.transfer(
      giang.token,
      giang.accounts[0],
      fifth.accounts[0],
      '15000000',
    );
    const event = await eventFor(db.runner, transferId);

    await parts.consumer.handle(event, message(1));

    const [decision] = await q(
      `SELECT event_id, rule_set_version, mode, rule_score, ai_status, ai_applied_weight, feature_snapshot
         FROM risk_decisions WHERE transfer_id = $1`,
      [transferId],
    );
    expect(decision).toMatchObject({
      event_id: event.eventId,
      rule_set_version: 1,
      mode: 'rule_only',
      rule_score: 75,
      ai_status: 'DISABLED',
      ai_applied_weight: 0,
    });
    const snapshot = decision.feature_snapshot as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual(SNAPSHOT_KEYS);
    expect(JSON.stringify(snapshot)).not.toMatch(UUID);
    expect(snapshot).toMatchObject({ amount: '15000000', newRecipients1h: 5, sameOwner: false });

    expect(
      await q(
        'SELECT score, risk_level, rule_set_version, review_status FROM fraud_flags WHERE transfer_id = $1',
        [transferId],
      ),
    ).toEqual([{ score: 75, risk_level: 'HIGH', rule_set_version: 1, review_status: 'OPEN' }]);
    const hits = await q<{ rule_id: string; weight: number; explanation: string }>(
      'SELECT rule_id, weight, explanation FROM fraud_rule_hits WHERE transfer_id = $1 ORDER BY rule_id',
      [transferId],
    );
    expect(hits.map(h => [h.rule_id, h.weight])).toEqual([
      ['R3', 35],
      ['R5', 40],
    ]);
    for (const hit of hits) expect(hit.explanation.length).toBeGreaterThan(0);
    expect(
      await q(
        `SELECT actor_user_id, actor_role, outcome, target_type, correlation_id, metadata
           FROM audit_log WHERE action = 'fraud.flagged' AND target_id = $1`,
        [transferId],
      ),
    ).toEqual([
      {
        actor_user_id: null,
        actor_role: 'worker',
        outcome: 'SUCCESS',
        target_type: 'transfer',
        correlation_id: event.correlationId,
        metadata: { count: 2 },
      },
    ]);
    expect(
      await count("processed_events WHERE consumer = 'risk' AND event_id = $1", [event.eventId]),
    ).toBe(1);
  });

  it('TC-111-02 AC-9.1: 20M of 21M from a new account to another owner → exactly one MEDIUM flag of 65 naming R3 and R6', async () => {
    const { transferId, event } = await ac91();
    await parts.consumer.handle(event, message(1));
    expect(
      await q('SELECT score, risk_level FROM fraud_flags WHERE transfer_id = $1', [transferId]),
    ).toEqual([{ score: 65, risk_level: 'MEDIUM' }]);
    const hits = await q<{ rule_id: string; explanation: string }>(
      'SELECT rule_id, explanation FROM fraud_rule_hits WHERE transfer_id = $1 ORDER BY rule_id',
      [transferId],
    );
    expect(hits.map(h => h.rule_id)).toEqual(['R3', 'R6']);
    expect(hits.find(h => h.rule_id === 'R6')!.explanation).toMatch(/95/);
  });

  it('TC-111-03 R6 alone (30 < 40) leaves a LOW decision and no flag, hit or audit', async () => {
    const tuan = await fx.customer('Ngô Minh Tuấn');
    const vy = await fx.customer('Trịnh Thảo Vy');
    await fx.deposit(tuan.accounts[0], '5000000');
    const transferId = await fx.transfer(tuan.token, tuan.accounts[0], vy.accounts[0], '4800000');
    await parts.consumer.handle(await eventFor(db.runner, transferId), message(1));
    expect(
      await q('SELECT rule_score, mode, ai_status FROM risk_decisions WHERE transfer_id = $1', [
        transferId,
      ]),
    ).toEqual([{ rule_score: 30, mode: 'rule_only', ai_status: 'DISABLED' }]);
    expect(await count('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(0);
    expect(await count('fraud_rule_hits WHERE transfer_id = $1', [transferId])).toBe(0);
    expect(
      await count("audit_log WHERE action = 'fraud.flagged' AND target_id = $1", [transferId]),
    ).toBe(0);
  });

  it('TC-111-04 AC-9.2: the same event twice → one decision, one flag, one audit; the second never reads features', async () => {
    const { transferId, event } = await ac91();
    const extract = jest.spyOn(parts.provider, 'extract');
    await parts.consumer.handle(event, message(1));
    await parts.consumer.handle(event, message(2));
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await count('risk_decisions WHERE transfer_id = $1', [transferId])).toBe(1);
    expect(await count('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(1);
    expect(
      await count("audit_log WHERE action = 'fraud.flagged' AND target_id = $1", [transferId]),
    ).toBe(1);
  });

  it('TC-111-05 two different events of one transfer, prepared together then claimed concurrently → one decision, one flag, no error', async () => {
    const { transferId, event } = await ac91();
    const copy = { ...event, eventId: randomUUID() };
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    class BarrierConsumer extends RiskScoringConsumer {
      protected override async prepare(e: DomainEvent): Promise<unknown> {
        const prepared = await super.prepare(e);
        if (++arrived === 2) release();
        await gate; // both are prepared (neither sees a decision) before either transaction opens
        return prepared;
      }
    }
    const racing = buildRiskConsumer(source, { make: (...args) => new BarrierConsumer(...args) });
    await Promise.all([
      racing.consumer.handle(event, message(1)),
      racing.consumer.handle(copy, message(1)),
    ]);
    const [decision] = await q<{ event_id: string }>(
      'SELECT event_id FROM risk_decisions WHERE transfer_id = $1',
      [transferId],
    );
    expect([event.eventId, copy.eventId]).toContain(decision.event_id);
    expect(await count('risk_decisions WHERE transfer_id = $1', [transferId])).toBe(1);
    expect(await count('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(1);
    expect(
      await count("audit_log WHERE action = 'fraud.flagged' AND target_id = $1", [transferId]),
    ).toBe(1);
    expect(
      await count("processed_events WHERE consumer = 'risk' AND event_id = ANY($1::uuid[])", [
        [event.eventId, copy.eventId],
      ]),
    ).toBe(2);
  });

  it('TC-111-06 without the early check, an event that loses the decision claim commits only its dedup row', async () => {
    const { transferId, event } = await ac91();
    await parts.consumer.handle(event, message(1));
    class NoEarlyCheck extends RiskScoringConsumer {
      protected override earlyDedup(): Promise<boolean> {
        return Promise.resolve(false);
      }
    }
    const late = buildRiskConsumer(source, { make: (...args) => new NoEarlyCheck(...args) });
    const copy = { ...event, eventId: randomUUID() };
    const extract = jest.spyOn(late.provider, 'extract');
    await late.consumer.handle(copy, message(1));
    expect(extract).toHaveBeenCalledTimes(1); // it really went past prepare to the claim
    expect(await count('risk_decisions WHERE transfer_id = $1', [transferId])).toBe(1);
    expect(await count('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(1);
    expect(
      await count("audit_log WHERE action = 'fraud.flagged' AND target_id = $1", [transferId]),
    ).toBe(1);
    expect(
      await count("processed_events WHERE consumer = 'risk' AND event_id = $1", [copy.eventId]),
    ).toBe(1);
  });

  it('TC-111-07 a DEPOSIT is claimed and not scored', async () => {
    const thao = await fx.customer('Mai Phương Thảo');
    await fx.deposit(thao.accounts[0], '3000000');
    const [{ payload }] = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events
        WHERE event_type = 'TransferCompleted' AND payload->>'type' = 'DEPOSIT' AND payload->>'toAccountId' = $1`,
      [thao.accounts[0]],
    );
    await parts.consumer.handle(payload, message(1));
    expect(
      await count("processed_events WHERE consumer = 'risk' AND event_id = $1", [payload.eventId]),
    ).toBe(1);
    expect(await count('risk_decisions WHERE transfer_id = $1', [payload.transferId])).toBe(0);
  });

  it('TC-111-08 an AccountStatusChanged on risk-events is poison at once and writes nothing', async () => {
    const event = { ...ACCOUNT_LOCKED_SAMPLE, eventId: randomUUID() };
    await expect(parts.consumer.handle(event, message(1))).rejects.toBeInstanceOf(
      PoisonMessageError,
    );
    expect(await count('processed_events WHERE event_id = $1', [event.eventId])).toBe(0);
  });

  it('TC-111-09 a rule that throws rolls everything back and is retried, then dead-lettered at the fifth receive (ADR-14)', async () => {
    const { transferId, event } = await ac91();
    jest.spyOn(parts.scoring, 'score').mockImplementation(() => {
      throw new Error('rule bug');
    });
    const first = parts.consumer.handle(event, message(1));
    await expect(first).rejects.toThrow('rule bug');
    await expect(first).rejects.not.toBeInstanceOf(PoisonMessageError);
    await expect(parts.consumer.handle(event, message(5))).rejects.toBeInstanceOf(
      PoisonMessageError,
    );
    expect(
      await count("processed_events WHERE consumer = 'risk' AND event_id = $1", [event.eventId]),
    ).toBe(0);
    expect(await count('risk_decisions WHERE transfer_id = $1', [transferId])).toBe(0);
  });

  /** A real MetricsService whose lines are collected; `start` fixes the baseline of the shared counters. */
  async function collectingMetrics() {
    const docs: EmfDocument[] = [];
    const metrics = new MetricsService(
      { enabled: true, flushMs: 600_000 },
      { role: 'worker' } as never,
      new PinoLogger({ pinoHttp: { level: 'silent' } } as never),
      doc => docs.push(doc),
    );
    await metrics.start();
    return { metrics, docs };
  }
  const metricNames = (doc: EmfDocument) => doc._aws.CloudWatchMetrics[0].Metrics.map(m => m.Name);

  it('TC-204-07 a flagged transfer writes risk_decision_total{AiStatus=DISABLED} and risk_transfer_to_flag_ms, equal to fraud_flags.created_at - transfers.created_at, with no personal data', async () => {
    const { metrics, docs } = await collectingMetrics();
    const withMetrics = buildRiskConsumer(source, { metrics });
    const { transferId, event } = await ac91();

    await withMetrics.consumer.handle(event, message(1));
    await metrics.flush();

    const [decision] = docs.filter(d => metricNames(d).includes('risk_decision_total'));
    expect(decision).toMatchObject({
      Role: 'worker',
      AiStatus: 'DISABLED',
      risk_decision_total: 1,
    });
    expect(decision._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Role', 'AiStatus']]);

    const [lag] = await q<{ lag_ms: number }>(
      `SELECT EXTRACT(EPOCH FROM f.created_at - t.created_at) * 1000 AS lag_ms
         FROM fraud_flags f JOIN transfers t ON t.id = f.transfer_id WHERE f.transfer_id = $1`,
      [transferId],
    );
    const [flag] = docs.filter(d => metricNames(d).includes('risk_transfer_to_flag_ms'));
    expect(flag._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Role']]);
    const samples = flag.risk_transfer_to_flag_ms as number[];
    expect(samples).toHaveLength(1);
    // The sample is the upper bound of the bucket the real lag falls in (see LatencyHistogram).
    const bucket = LATENCY_BOUNDS_MS.find(bound => Number(lag.lag_ms) <= bound);
    expect(samples[0]).toBe(bucket);
    expect(samples[0]).toBeLessThanOrEqual(5000); // SLO p95 < 5 s, even with a cold database

    const text = JSON.stringify(docs);
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain(transferId);
    expect(text).not.toContain('20000000');
    for (const doc of docs) {
      const dims = Object.keys(doc).filter(k => k !== '_aws' && !metricNames(doc).includes(k));
      expect(dims.every(k => ['Role', 'AiStatus'].includes(k))).toBe(true);
    }
  });

  it('TC-204-07 a duplicate delivery and a LOW transfer add no flag-lag sample, and the duplicate no decision', async () => {
    const { metrics, docs } = await collectingMetrics();
    const withMetrics = buildRiskConsumer(source, { metrics });
    const { event } = await ac91();
    await withMetrics.consumer.handle(event, message(1));
    await metrics.flush();
    docs.length = 0;

    await withMetrics.consumer.handle({ ...event, eventId: randomUUID() }, message(1));
    await metrics.flush();
    expect(docs).toEqual([]);

    const sender = await fx.customer('Khách LOW A');
    const recipient = await fx.customer('Khách LOW B');
    await fx.deposit(sender.accounts[0], '5000000');
    const lowId = await fx.transfer(
      sender.token,
      sender.accounts[0],
      recipient.accounts[0],
      '1000',
    );
    await withMetrics.consumer.handle(await eventFor(db.runner, lowId), message(1));
    await metrics.flush();
    expect(docs.filter(d => metricNames(d).includes('risk_transfer_to_flag_ms'))).toEqual([]);
    expect(docs.filter(d => metricNames(d).includes('risk_decision_total'))).toHaveLength(1);
  });

  it('TC-204-08 a rule that throws counts risk_rule_error_total{Rule} per attempt, is still thrown as a retry and goes to the DLQ at the fifth receive', async () => {
    const { metrics, docs } = await collectingMetrics();
    const withMetrics = buildRiskConsumer(source, { metrics });
    const { transferId, event } = await ac91();
    jest.spyOn(R3NewAccountLargeTransferRule.prototype, 'evaluate').mockImplementation(() => {
      throw new Error('rule bug');
    });

    const first = withMetrics.consumer.handle(event, message(1));
    await expect(first).rejects.toBeInstanceOf(RiskRuleError);
    await expect(first).rejects.not.toBeInstanceOf(PoisonMessageError);
    await expect(first).rejects.toMatchObject({ ruleId: 'R3' });
    await expect(withMetrics.consumer.handle(event, message(5))).rejects.toBeInstanceOf(
      PoisonMessageError,
    );
    await metrics.flush();

    const [line] = docs.filter(d => metricNames(d).includes('risk_rule_error_total'));
    expect(line).toMatchObject({ Role: 'worker', Rule: 'R3', risk_rule_error_total: 2 });
    expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Role', 'Rule']]);
    // Nothing was written and no decision was counted.
    expect(await count('risk_decisions WHERE transfer_id = $1', [transferId])).toBe(0);
    expect(docs.filter(d => metricNames(d).includes('risk_decision_total'))).toEqual([]);
    expect(JSON.stringify(docs)).not.toMatch(UUID);
  });

  it('TC-111-11 Redis configuration fallback still increments, but SQL features are not Redis fallbacks', async () => {
    const total = async (name: string) =>
      (await defaultRegister.getSingleMetric(name)?.get())?.values.reduce(
        (sum, value) => sum + value.value,
        0,
      ) ?? 0;
    const configBefore = await total('risk_config_redis_fallback_total');
    const featureBefore = await total('risk_redis_fallback_total');
    const { event } = await ac91();
    await parts.consumer.handle(event, message(1));
    expect(await total('risk_config_redis_fallback_total')).toBeGreaterThan(configBefore);
    expect(await total('risk_redis_fallback_total')).toBe(featureBefore);
  });

  it('TC-111-10 an audit failure rolls back the claim, the decision and the flag', async () => {
    const { transferId, event } = await ac91();
    jest.spyOn(parts.audit, 'record').mockRejectedValueOnce(new Error('audit down'));
    await expect(parts.consumer.handle(event, message(1))).rejects.toThrow('audit down');
    expect(
      await count("processed_events WHERE consumer = 'risk' AND event_id = $1", [event.eventId]),
    ).toBe(0);
    expect(await count('risk_decisions WHERE transfer_id = $1', [transferId])).toBe(0);
    expect(await count('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(0);
    // The retry then succeeds and writes everything once.
    await parts.consumer.handle(event, message(2));
    expect(await count('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(1);
  });

  it('TC-111-15 the consumer runs as a real dbs_worker login; the worker cannot change a flag or a decision', async () => {
    const PASSWORD = 'role-test-only'; // the same as db-roles.db-spec, so files never fight over it
    await db.runner.query(`ALTER ROLE dbs_worker LOGIN PASSWORD '${PASSWORD}'`);
    const url = new URL(db.url);
    url.username = 'dbs_worker';
    url.password = PASSWORD;
    const worker = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
    try {
      const { transferId, event } = await ac91();
      await buildRiskConsumer(worker).consumer.handle(event, message(1));
      expect(await count('fraud_flags WHERE transfer_id = $1', [transferId])).toBe(1);
      expect(
        await count("audit_log WHERE action = 'fraud.flagged' AND target_id = $1", [transferId]),
      ).toBe(1);
      for (const sql of [
        'UPDATE fraud_flags SET score = 0',
        'DELETE FROM fraud_flags',
        'UPDATE risk_decisions SET rule_score = 0',
        'DELETE FROM risk_decisions',
      ]) {
        await expect(worker.query(sql)).rejects.toMatchObject({ driverError: { code: '42501' } });
      }
    } finally {
      await worker.destroy();
    }
  });
});
