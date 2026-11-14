import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Logger as NestLogger } from '@nestjs/common';
import { Logger as PinoNestLogger, PinoLogger } from 'nestjs-pino';
import pinoHttp from 'pino-http';
import { SafeLogger } from '@common/logging/safe-logger';
import { createLoggingOptions } from '@common/logging/logging.options';
import { MetricsService } from '@common/metrics';
import type { EmfDocument } from '@common/metrics/emf';
import { RiskAiService } from '@modules/risk/ai/risk-ai.service';
import { createLoopbackAdapter } from '@modules/risk/ai/openai-decisions';
import { projectFeatures } from '@modules/risk/ai/feature-projection';
import { R3NewAccountLargeTransferRule } from '@modules/risk/rules/r3-new-account-large-transfer.rule';
import { activeTransactionContext } from '@database/transaction.helper';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { checkLedgerInvariants } from '../support/invariants';
import { startDepositApp } from '../support/deposit-app';
import { buildRiskConsumer, eventFor, riskFixtures } from '../support/risk-consumer';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * DBS-111 decision G1-2 (ADR-14 (b)): what the consumer records when the current rule-set version
 * asks for AI. In a file of its own because risk_rule_sets is append-only: a new version here would
 * change the version every other test in the same database scores with.
 */
const VALID_AI = {
  provider: 'openai',
  model: 'gpt-6-luna',
  rubric:
    'needs_operator_review: đánh giá mẫu giao dịch đã hoàn tất có dấu hiệu cần nhân viên xem xét',
  threshold: 0.8,
  weight: 20,
  maxAdmissionDelayMs: 2000,
  requestTimeoutMs: 3000,
};

describe('DBS-111 decisions while the rule set asks for AI (PostgreSQL)', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let source: DataSource;
  let fx: ReturnType<typeof riskFixtures>;
  let server: Server;
  let endpoint: string;
  let responseKind: 'success' | '429' | 'refusal' | 'outage' | 'timeout' = 'success';
  let requests: Record<string, unknown>[] = [];
  const runtime = (
    overrides: Partial<NonNullable<ConstructorParameters<typeof RiskAiService>[0]>> = {},
    databaseUrl?: string,
  ) =>
    new RiskAiService(
      {
        approved: true,
        policyRevision: 'synthetic-v1',
        dailyRequestLimit: 100,
        concurrentLimit: 5,
        gateTimeoutMs: 1000,
        apiKey: 'synthetic-test-only',
        ...overrides,
      },
      {
        url: databaseUrl ?? db.url,
        ssl: false,
        sslCaPath: undefined,
        poolMax: 5,
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10000,
      },
      createLoopbackAdapter(endpoint),
    );
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) =>
    db.runner.query(sql, args) as Promise<T[]>;

  async function newVersion(ai: unknown): Promise<number> {
    const [{ version }] = await q<{ version: number }>(
      `INSERT INTO risk_rule_sets(version, config)
       SELECT max(version) + 1,
              (SELECT config FROM risk_rule_sets WHERE version = 1)
                || jsonb_build_object('mode', 'rules_with_external_ai', 'ai', $1::jsonb)
         FROM risk_rule_sets
       RETURNING version`,
      [JSON.stringify(ai)],
    );
    return version;
  }
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
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        body += String(chunk);
      });
      req.on('end', () => {
        requests.push(JSON.parse(body) as Record<string, unknown>);
        if (responseKind === 'outage') {
          res.destroy();
          return;
        }
        if (responseKind === 'timeout') {
          setTimeout(() => res.destroy(), 500).unref();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-request-id', 'synthetic-request');
        res.statusCode = responseKind === '429' ? 429 : 200;
        res.end(
          JSON.stringify({
            model: 'synthetic-response-model',
            answers: [
              {
                name: 'needs_operator_review',
                type: responseKind === 'refusal' ? 'refusal' : 'predicate',
                probability: 0.95,
              },
            ],
          }),
        );
      });
    });
    // ES2022 lib: Promise.withResolvers is not available in this project's type target.
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/decisions`;
  });
  beforeEach(async () => {
    responseKind = 'success';
    requests = [];
    await q('TRUNCATE ai_gate_policy, ai_gate_days, ai_gate_permits');
    await q(`INSERT INTO ai_gate_policy(singleton, revision, daily_limit, concurrent_limit)
      VALUES (true, 'synthetic-v1', 100, 5)`);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    expect((await checkLedgerInvariants(db.runner)).violations).toEqual([]);
  });
  afterAll(async () => {
    try {
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      await app?.close();
      await source?.destroy();
    } finally {
      await db?.drop();
    }
  });
  it('RSK-02 dbs_worker executes gate without table access; API cannot execute after role rerun', async () => {
    const roles = readFileSync(resolve(__dirname, '../../../infra/scripts/db-roles.sql'), 'utf8');
    await db.runner.query(roles);
    await db.runner.query(roles);
    await db.runner.query("ALTER ROLE dbs_worker LOGIN PASSWORD 'role-test-only'");
    const workerUrl = new URL(db.url);
    workerUrl.username = 'dbs_worker';
    workerUrl.password = 'role-test-only';
    const worker = await new DataSource({
      type: 'postgres',
      url: workerUrl.toString(),
    }).initialize();
    try {
      await newVersion(VALID_AI);
      const { transferId, event } = await ac91();
      await buildRiskConsumer(worker, { ai: runtime({}, workerUrl.toString()) }).consumer.handle(
        event,
      );
      expect(requests).toHaveLength(1);
      expect(
        await q('SELECT ai_status FROM risk_decisions WHERE transfer_id=$1', [transferId]),
      ).toEqual([{ ai_status: 'SUCCEEDED' }]);
      for (const table of ['ai_gate_policy', 'ai_gate_days', 'ai_gate_permits']) {
        await expect(worker.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({
          driverError: { code: '42501' },
        });
      }
      const [permissions] = await q(`SELECT
        has_function_privilege('dbs_api', 'public.ai_gate_acquire(uuid,text,integer,integer)', 'EXECUTE') AS api_acquire,
        has_function_privilege('dbs_api', 'public.ai_gate_release(uuid)', 'EXECUTE') AS api_release,
        has_function_privilege('dbs_worker', 'public.ai_gate_acquire(uuid,text,integer,integer)', 'EXECUTE') AS worker_acquire,
        has_function_privilege('dbs_worker', 'public.ai_gate_release(uuid)', 'EXECUTE') AS worker_release`);
      expect(permissions).toEqual({
        api_acquire: false,
        api_release: false,
        worker_acquire: true,
        worker_release: true,
      });
    } finally {
      await worker.destroy();
    }
  });

  it('RSK-02 unavailable gate database falls back without provider request', async () => {
    await newVersion(VALID_AI);
    const bad = new URL(db.url);
    bad.port = '1';
    const { transferId, event } = await ac91();
    await buildRiskConsumer(source, {
      ai: runtime({ gateTimeoutMs: 100 }, bad.toString()),
    }).consumer.handle(event);
    expect(requests).toHaveLength(0);
    expect(
      await q('SELECT ai_status FROM risk_decisions WHERE transfer_id=$1', [transferId]),
    ).toEqual([{ ai_status: 'UNAVAILABLE' }]);
  });

  it('keeps request, credential and rubric out of real SafeLogger output', async () => {
    await newVersion(VALID_AI);
    const { event } = await ac91();
    const fields = event as { amount: string; fromBalanceBefore: string };
    let output = '';
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const settings = createLoggingOptions({ role: 'worker', logLevel: 'debug' });
    const actual = pinoHttp(settings, stream).logger;
    const descriptor = Object.getOwnPropertyDescriptor(PinoLogger.prototype, 'logger');
    if (!descriptor) throw new Error('Pino logger getter missing');
    Object.defineProperty(PinoLogger.prototype, 'logger', {
      configurable: true,
      get: () => actual,
    });
    const pino = new PinoLogger({ pinoHttp: settings });
    NestLogger.overrideLogger(new SafeLogger(new PinoNestLogger(pino, {})));
    try {
      await buildRiskConsumer(source, { ai: runtime() }).consumer.handle(event);
    } finally {
      NestLogger.overrideLogger(false);
      Object.defineProperty(PinoLogger.prototype, 'logger', descriptor);
    }
    expect(output).toContain('Risk decision recorded');
    expect(output).not.toContain('synthetic-test-only');
    expect(output).not.toContain('Authorization');
    expect(output).not.toContain(fields.amount);
    expect(output).not.toContain(fields.fromBalanceBefore);
    expect(output).not.toContain(VALID_AI.rubric);
  });
  it.each([false, true])(
    'RSK-02 success, rule hits=%s: persists model/SHA and dedups before network',
    async withRules => {
      const version = await newVersion({ ...VALID_AI, weight: 45 });
      let transferId: string;
      let event: Record<string, unknown>;
      if (withRules) {
        ({ transferId, event } = await ac91());
      } else {
        const sender = await fx.customer('Khách tổng hợp A');
        const recipient = await fx.customer('Khách tổng hợp B');
        await fx.deposit(sender.accounts[0], '10000000');
        transferId = await fx.transfer(
          sender.token,
          sender.accounts[0],
          recipient.accounts[0],
          '1000',
        );
        event = await eventFor(db.runner, transferId);
      }
      const parts = buildRiskConsumer(source, { ai: runtime() });
      const score = jest.spyOn(parts.scoring, 'score');
      const rule = jest.spyOn(R3NewAccountLargeTransferRule.prototype, 'evaluate');
      const transactions = jest.spyOn(parts.tx, 'run');
      const originalEvaluate = RiskAiService.prototype.evaluate;
      const evaluate = jest.spyOn(RiskAiService.prototype, 'evaluate');
      evaluate.mockImplementation(function (this: RiskAiService, ...args) {
        expect(transactions).not.toHaveBeenCalled();
        expect(activeTransactionContext.getStore()).toBeUndefined();
        return originalEvaluate.apply(this, args);
      });
      await parts.consumer.handle(event);
      await parts.consumer.handle(event);
      await parts.consumer.handle({ ...event, eventId: randomUUID() });
      expect(requests).toHaveLength(1);
      expect(score).toHaveBeenCalledTimes(1);
      // parseRuleSet (BL-188) chạy thử R1–R6 trên giao dịch giả để kiểm tham số khi nạp phiên bản luật,
      // nên chỉ đếm các lần R3 chấm giao dịch thật này.
      expect(rule.mock.calls.filter(([e]) => e.transferId === transferId)).toHaveLength(1);
      expect(evaluate).toHaveBeenCalledTimes(1);
      const [decision] = await q<{
        feature_snapshot: unknown;
        input_sha256: string;
        rubric_sha256: string;
        rule_score: number;
        ai_status: string;
        requested_model: string;
        response_model: string;
        ai_applied_weight: number;
        probability: number;
        rule_set_version: number;
      }>('SELECT * FROM risk_decisions WHERE transfer_id=$1', [transferId]);
      expect(decision).toMatchObject({
        rule_set_version: version,
        ai_status: 'SUCCEEDED',
        requested_model: VALID_AI.model,
        response_model: 'synthetic-response-model',
        ai_applied_weight: 45,
        probability: 0.95,
        rule_score: withRules ? 65 : 0,
      });
      expect(decision.rubric_sha256).toBe(
        createHash('sha256').update(VALID_AI.rubric).digest('hex'),
      );
      expect(decision.input_sha256).toBe(
        createHash('sha256')
          .update(JSON.stringify(projectFeatures(decision.feature_snapshot)))
          .digest('hex'),
      );
      expect(Object.keys(decision.feature_snapshot as object)).toHaveLength(11);
      expect(await q('SELECT score FROM fraud_flags WHERE transfer_id=$1', [transferId])).toEqual([
        { score: (withRules ? 65 : 0) + 45 },
      ]);
    },
  );

  it.each(['429', 'refusal', 'outage', 'timeout'] as const)(
    'RSK-02 %s falls back without API retry',
    async kind => {
      await newVersion({ ...VALID_AI, requestTimeoutMs: kind === 'timeout' ? 50 : 3000 });
      responseKind = kind;
      const { transferId, event } = await ac91();
      await buildRiskConsumer(source, { ai: runtime() }).consumer.handle(event);
      expect(requests).toHaveLength(1);
      expect(
        await q(
          'SELECT ai_status, ai_applied_weight, rule_score, provider FROM risk_decisions WHERE transfer_id=$1',
          [transferId],
        ),
      ).toEqual([
        {
          ai_status: kind === 'refusal' ? 'REFUSED' : 'UNAVAILABLE',
          ai_applied_weight: 0,
          rule_score: 65,
          provider: 'openai',
        },
      ]);
      expect(await q('SELECT score FROM fraud_flags WHERE transfer_id=$1', [transferId])).toEqual([
        { score: 65 },
      ]);
    },
  );

  it.each([
    { approved: false },
    { policyRevision: undefined },
    { policyRevision: 'not-approved' },
    { dailyRequestLimit: undefined },
    { concurrentLimit: undefined },
    { gateTimeoutMs: undefined },
  ])('RSK-02 missing approval/policy fails closed with provenance: %j', async overrides => {
    await newVersion(VALID_AI);
    const { transferId, event } = await ac91();
    await buildRiskConsumer(source, { ai: runtime(overrides) }).consumer.handle(event);
    expect(requests).toHaveLength(0);
    expect(
      await q(
        'SELECT ai_status, provider, requested_model FROM risk_decisions WHERE transfer_id=$1',
        [transferId],
      ),
    ).toEqual([{ ai_status: 'UNAVAILABLE', provider: 'openai', requested_model: VALID_AI.model }]);
  });

  it('RSK-02 missing key and invalid AI config never acquire quota or call provider', async () => {
    await newVersion(VALID_AI);
    const first = await ac91();
    await buildRiskConsumer(source, { ai: runtime({ apiKey: undefined }) }).consumer.handle(
      first.event,
    );
    await newVersion({ ...VALID_AI, threshold: 2 });
    const second = await ac91();
    await buildRiskConsumer(source, { ai: runtime() }).consumer.handle(second.event);
    expect(requests).toHaveLength(0);
    expect(
      await q('SELECT ai_status FROM risk_decisions WHERE transfer_id=ANY($1::uuid[])', [
        [first.transferId, second.transferId],
      ]),
    ).toEqual([{ ai_status: 'CONFIG_INVALID' }, { ai_status: 'CONFIG_INVALID' }]);
    expect(await q('SELECT * FROM ai_gate_days')).toEqual([]);
  });

  it('RSK-02 daily quota is durable and exhausted deliveries retain baseline', async () => {
    await q('UPDATE ai_gate_policy SET daily_limit=1');
    await newVersion(VALID_AI);
    const parts = buildRiskConsumer(source, { ai: runtime({ dailyRequestLimit: 1 }) });
    const first = await ac91();
    const second = await ac91();
    await parts.consumer.handle(first.event);
    await parts.consumer.handle(second.event);
    expect(requests).toHaveLength(1);
    expect(
      await q('SELECT ai_status FROM risk_decisions WHERE transfer_id=$1', [second.transferId]),
    ).toEqual([{ ai_status: 'BUDGET_EXHAUSTED' }]);
    expect(await q('SELECT requests::int AS requests FROM ai_gate_days')).toEqual([
      { requests: 1 },
    ]);
  });

  it('RSK-02 gate outage/URL TLS override cannot call network', async () => {
    await newVersion(VALID_AI);
    const { transferId, event } = await ac91();
    await buildRiskConsumer(source, {
      ai: runtime({}, `${db.url}?sslmode=no-verify`),
    }).consumer.handle(event);
    expect(requests).toHaveLength(0);
    expect(
      await q('SELECT ai_status FROM risk_decisions WHERE transfer_id=$1', [transferId]),
    ).toEqual([{ ai_status: 'UNAVAILABLE' }]);
  });

  it('RSK-02 SQL deadlock retry reuses one prepared AI answer and one rule evaluation', async () => {
    await newVersion(VALID_AI);
    const { transferId, event } = await ac91();
    const parts = buildRiskConsumer(source, { ai: runtime() });
    const record = parts.audit.record.bind(parts.audit);
    const audit = jest
      .spyOn(parts.audit, 'record')
      .mockRejectedValueOnce(Object.assign(new Error('synthetic deadlock'), { code: '40P01' }))
      .mockImplementation(record);
    const score = jest.spyOn(parts.scoring, 'score');
    await parts.consumer.handle(event);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(score).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(
      await q('SELECT count(*)::int AS n FROM risk_decisions WHERE transfer_id=$1', [transferId]),
    ).toEqual([{ n: 1 }]);
  });

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
  const lines = (docs: EmfDocument[], name: string) =>
    docs.filter(d => d._aws.CloudWatchMetrics[0].Metrics.some(m => m.Name === name));

  it.each([
    ['success', 'SUCCEEDED', 1],
    ['outage', 'UNAVAILABLE', 1],
    ['429', 'UNAVAILABLE', 1],
  ] as const)(
    'TC-204-09 AI answer %s: risk_decision_total{AiStatus=%s} and %s risk_ai_call_duration_ms sample',
    async (kind, status, samples) => {
      responseKind = kind;
      await newVersion(VALID_AI);
      const { metrics, docs } = await collectingMetrics();
      const { event } = await ac91();
      await buildRiskConsumer(source, { ai: runtime(), metrics }).consumer.handle(event);
      await metrics.flush();

      const [decision] = lines(docs, 'risk_decision_total');
      expect(decision).toMatchObject({ Role: 'worker', AiStatus: status, risk_decision_total: 1 });
      const [call] = lines(docs, 'risk_ai_call_duration_ms');
      expect(call._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Role']]);
      expect(call._aws.CloudWatchMetrics[0].Metrics).toEqual([
        { Name: 'risk_ai_call_duration_ms', Unit: 'Milliseconds' },
      ]);
      expect(call.risk_ai_call_duration_ms as number[]).toHaveLength(samples);
      expect(JSON.stringify(docs)).not.toContain('synthetic');
    },
  );

  it('TC-204-09 a broken ai block counts CONFIG_INVALID and makes no AI call, so no duration sample', async () => {
    await newVersion({ ...VALID_AI, threshold: 7 });
    const { metrics, docs } = await collectingMetrics();
    const { event } = await ac91();
    await buildRiskConsumer(source, { ai: runtime(), metrics }).consumer.handle(event);
    await metrics.flush();
    expect(lines(docs, 'risk_decision_total')[0]).toMatchObject({ AiStatus: 'CONFIG_INVALID' });
    expect(lines(docs, 'risk_ai_call_duration_ms')).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('TC-111-11a a broken ai block records rules_with_external_ai / CONFIG_INVALID with no AI weight, and still flags on the rules', async () => {
    const version = await newVersion({ ...VALID_AI, threshold: 7 });
    const { transferId, event } = await ac91();
    await buildRiskConsumer(source).consumer.handle(event);
    expect(
      await q(
        `SELECT rule_set_version, mode, ai_status, ai_applied_weight, probability, provider
           FROM risk_decisions WHERE transfer_id = $1`,
        [transferId],
      ),
    ).toEqual([
      {
        rule_set_version: version,
        mode: 'rules_with_external_ai',
        ai_status: 'CONFIG_INVALID',
        ai_applied_weight: 0,
        probability: null,
        provider: null,
      },
    ]);
    expect(
      await q(
        'SELECT score, risk_level, rule_set_version FROM fraud_flags WHERE transfer_id = $1',
        [transferId],
      ),
    ).toEqual([{ score: 65, risk_level: 'MEDIUM', rule_set_version: version }]);
  });

  it('TC-111-11b a valid AI block without a runtime key records CONFIG_INVALID, never rule_only', async () => {
    const version = await newVersion(VALID_AI);
    const parts = buildRiskConsumer(source);
    const first = await ac91();
    const second = await ac91();
    await parts.consumer.handle(first.event);
    await parts.consumer.handle(second.event);
    for (const { transferId } of [first, second]) {
      expect(
        await q(
          'SELECT rule_set_version, mode, ai_status FROM risk_decisions WHERE transfer_id = $1',
          [transferId],
        ),
      ).toEqual([
        { rule_set_version: version, mode: 'rules_with_external_ai', ai_status: 'CONFIG_INVALID' },
      ]);
    }
  });
});
