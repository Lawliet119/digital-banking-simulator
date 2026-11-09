import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RuleSetRepository } from '@modules/risk/config/rule-set.repository';
import { ScoringService } from '@modules/risk/scoring.service';
import type { Features, TransferEvent } from '@modules/risk/features/feature-provider';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { insertRuleOnlyDecision } from '../support/risk-decisions';

/** A cache that never holds anything: every read goes to PostgreSQL. */
const noCache = {
  readExpiringVersion: () => Promise.resolve(null),
  serverTimeMs: () => Promise.reject(new Error('cache unavailable')),
  get: () => Promise.resolve(null),
  setIfAbsent: () => Promise.resolve(false),
  setVersionBefore: () => Promise.resolve(false),
};

const features: Features = {
  txCount10m: 1,
  txCount1h: 1,
  historyCount30d: 0,
  medianAmount30dTimes2: null,
  reverseTransferOccurredAt: null,
  newRecipients1h: 0,
  distinctRecipients24h: 1,
  sumOut24h: '950000',
  smallTxCount24h: 0,
};

/** DBS-110: the repository over the real `risk_rule_sets` table, seed v1 included. */
describe('RuleSetRepository (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;
  const repository = () =>
    new RuleSetRepository({ redis: noCache, db: source, metrics: new RiskMetrics() });

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
  });
  afterAll(async () => {
    await source?.destroy();
    await db?.drop();
  });

  it('TC-110-01 reads the seed v1 and scores a transfer with it (R6 only: 30, LOW)', async () => {
    const set = await repository().current();
    expect(set.version).toBe(1);
    expect(set.mode).toBe('rule_only');
    const event = {
      ...TRANSFER_SAMPLE,
      fromBalanceBefore: '1000000',
      amount: '950000',
      sameOwner: false,
    } as TransferEvent;
    const result = new ScoringService().score(event, features, set);
    expect(result?.hits.map(h => [h.id, h.weight])).toEqual([['R6', 30]]);
    expect(result?.level).toBe('LOW');
    expect(result?.score).toBe(30);
  });

  it('TC-110-01 the highest version wins, and each version stays readable on its own', async () => {
    const v2 = {
      mode: 'rule_only',
      thresholds: { medium: 25, high: 70 },
      rules: {
        R1: { enabled: true, weight: 30, maxTransfers: 5, windowMinutes: 10 },
        R2: { enabled: true, weight: 25, medianMultiplier: 5, historyDays: 30, minHistory: 5 },
        R3: {
          enabled: true,
          weight: 35,
          maxAccountAgeHoursExclusive: 24,
          minAmountExclusive: '10000000',
        },
        R4: { enabled: true, weight: 20, reverseWindowMinutes: 60 },
        R5: { enabled: true, weight: 40, minNewRecipients: 5, windowMinutes: 60, noveltyDays: 30 },
        R6: { enabled: false, weight: 30, minBalancePercent: 90, minBalance: '1000000' },
      },
    };
    await q('INSERT INTO risk_rule_sets(version,config) VALUES(2,$1::jsonb)', [JSON.stringify(v2)]);
    const set = await repository().current();
    expect(set.version).toBe(2);
    expect(set.thresholds.medium).toBe(25);
    expect(set.rules.R6.enabled).toBe(false);
    // The emergency switch: R6 off in v2, so the same transfer scores nothing.
    const event = {
      ...TRANSFER_SAMPLE,
      fromBalanceBefore: '1000000',
      amount: '950000',
      sameOwner: false,
    } as TransferEvent;
    expect(new ScoringService().score(event, features, set)?.score).toBe(0);
  });

  it('TC-110-04 the version the repository returns is accepted by fraud_flags.rule_set_version', async () => {
    const set = await repository().current();
    const fixture = new TransferFixture(db.runner);
    const [a, b] = await fixture.accounts(2);
    const transfer = await fixture.transfer({ from: a, to: b, at: new Date().toISOString() });
    // RSK-01: a flag needs a decision of the same rule-set version.
    await insertRuleOnlyDecision(db.runner, transfer.id, { version: set.version });
    await q(
      `INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,45,'MEDIUM',$2)`,
      [transfer.id, set.version],
    );
    const [flag] = await q('SELECT rule_set_version FROM fraud_flags WHERE transfer_id=$1', [
      transfer.id,
    ]);
    expect(flag.rule_set_version).toBe(set.version);
    await expect(
      q(
        `INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,45,'MEDIUM',999)`,
        [randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it('TC-110-03 a stored version that cannot be used is an error naming the field', async () => {
    await q('INSERT INTO risk_rule_sets(version,config) VALUES(3,$1::jsonb)', [
      JSON.stringify({ mode: 'rule_only', thresholds: { medium: 40, high: 70 }, rules: {} }),
    ]);
    await expect(repository().current()).rejects.toThrow('Invalid risk rule set: rules.R1');
  });
});
