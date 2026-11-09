import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
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
  model: 'gpt-5-mini',
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
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    expect((await checkLedgerInvariants(db.runner)).violations).toEqual([]);
  });
  afterAll(async () => {
    try {
      await app?.close();
      await source?.destroy();
    } finally {
      await db?.drop();
    }
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

  it('TC-111-11b a valid ai block that is not wired yet is scored and recorded rule_only, with one warning per version', async () => {
    const version = await newVersion(VALID_AI);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
      ).toEqual([{ rule_set_version: version, mode: 'rule_only', ai_status: 'DISABLED' }]);
    }
    expect(warn.mock.calls.filter(call => JSON.stringify(call).includes('not wired'))).toHaveLength(
      1,
    );
  });
});
