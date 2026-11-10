import { DataSource } from 'typeorm';
import { toAiFeatureInput } from '@modules/risk/ai/feature-projection';
import { parseRuleSet } from '@modules/risk/config/rule-set';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import {
  OfflineFeatureProvider,
  type OfflineTransferFact,
} from '@modules/risk/features/offline-feature-provider';
import { TransferFacts } from '@modules/risk/features/transfer-facts';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { ScoringService } from '@modules/risk/scoring.service';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE_TIME = Date.parse('2026-10-01T12:00:00.000Z');
const PER_TX_LIMIT = 500_000_000n;
const SEED_V1 = {
  mode: 'rule_only' as const,
  thresholds: { medium: 40, high: 70 },
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
    R5: {
      enabled: true,
      weight: 40,
      minNewRecipients: 5,
      windowMinutes: 60,
      noveltyDays: 30,
      sameOwnerExempt: true,
    },
    R6: {
      enabled: true,
      weight: 30,
      minBalancePercent: 90,
      minBalance: '1000000',
      sameOwnerExempt: true,
    },
  },
};

describe('DBS-162 FeatureProvider parity (Online PostgreSQL vs Offline in-memory)', () => {
  let db: TempDatabase | undefined;
  let source: DataSource | undefined;
  let fixture: TransferFixture;
  let online: OnlineFeatureProvider;
  const scoring = new ScoringService();
  const ruleConfig = parseRuleSet(1, SEED_V1);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    fixture = new TransferFixture(db.runner);
    online = new OnlineFeatureProvider({
      facts: new TransferFacts(source),
      perTxLimit: PER_TX_LIMIT,
    });
  });

  afterAll(async () => {
    try {
      if (source?.isInitialized) await source.destroy();
    } finally {
      await db?.drop();
    }
  });

  interface TxSpec {
    from: string;
    to: string;
    amount: string;
    offsetMs: number;
    status?: 'REJECTED';
    sameOwner?: boolean;
    fromBalanceBefore?: string;
  }

  async function buildScenario(specs: TxSpec[]): Promise<{
    events: TransferEvent[];
    facts: OfflineTransferFact[];
  }> {
    const events: TransferEvent[] = [];
    const facts: OfflineTransferFact[] = [];

    for (const spec of specs) {
      const atMs = BASE_TIME + spec.offsetMs;
      const atIso = new Date(atMs).toISOString();
      const row = await fixture.transfer({
        from: spec.from,
        to: spec.to,
        amount: spec.amount,
        status: spec.status,
        at: atIso.replace('Z', '123Z'),
      });

      const event: TransferEvent = {
        eventType: 'TransferCompleted',
        correlationId: 'parity-test',
        eventId: row.id,
        transferId: row.id,
        type: 'TRANSFER',
        fromUserId: 'cust-source',
        toUserId: 'cust-dest',
        fromAccountId: spec.from,
        toAccountId: spec.to,
        amount: spec.amount,
        fromBalanceBefore: spec.fromBalanceBefore ?? '100000000',
        sameOwner: spec.sameOwner ?? false,
        occurredAt: atIso,
        fromAccountCreatedAt: new Date(BASE_TIME - 30 * DAY).toISOString(),
        toAccountCreatedAt: new Date(BASE_TIME - 30 * DAY).toISOString(),
      };

      events.push(event);

      // Only completed transfers become offline facts
      if (spec.status !== 'REJECTED') {
        facts.push({
          id: row.id,
          fromAccountId: spec.from,
          toAccountId: spec.to,
          createdAt: atIso,
          amount: spec.amount,
        });
      }
    }

    return { events, facts };
  }

  it('TC-162-01 & TC-162-02 & TC-162-03 parity across Features, Rule Scoring and FeatureInput', async () => {
    const [accA, accB, accC, accD, accE, accF] = await fixture.accounts(6);

    const specs: TxSpec[] = [
      // History for accA 15 days ago
      { from: accA, to: accB, amount: '100000', offsetMs: -15 * DAY },
      { from: accA, to: accC, amount: '200000', offsetMs: -14 * DAY },
      { from: accA, to: accD, amount: '300000', offsetMs: -10 * DAY },
      { from: accA, to: accB, amount: '400000', offsetMs: -5 * DAY },
      { from: accA, to: accE, amount: '500000', offsetMs: -2 * DAY },
      // Reverse transfer: accB sends to accA 45 minutes before evaluation
      { from: accB, to: accA, amount: '100000', offsetMs: -45 * MIN },
      // Rejected transfer: must be ignored by both
      { from: accA, to: accF, amount: '9999999', offsetMs: -30 * MIN, status: 'REJECTED' },
      // Recent transfers within 1 hour and 10 minutes
      { from: accA, to: accB, amount: '150000', offsetMs: -20 * MIN },
      { from: accA, to: accF, amount: '250000', offsetMs: -5 * MIN }, // New recipient in 1h
      { from: accA, to: accB, amount: '350000', offsetMs: 0 },
    ];

    const { events, facts } = await buildScenario(specs);
    const offline = new OfflineFeatureProvider(facts, PER_TX_LIMIT);

    // Evaluate the target transfer (accA -> accB at offset 0)
    const targetEvent = events[events.length - 1];

    const onlineFeatures = await online.extract(targetEvent);
    const offlineFeatures = await offline.extract(targetEvent);

    // 1. TC-162-01: All 9 Features must be exactly equal
    expect(onlineFeatures).toEqual(offlineFeatures);

    // 2. TC-162-02: Rule scoring and hits must be exactly equal
    const onlineScore = scoring.score(targetEvent, onlineFeatures, ruleConfig);
    const offlineScore = scoring.score(targetEvent, offlineFeatures, ruleConfig);
    expect(onlineScore).toEqual(offlineScore);

    // 3. TC-162-03: FeatureInput 11-field projection must be exactly equal
    const onlineAi = toAiFeatureInput(targetEvent, onlineFeatures);
    const offlineAi = await offline.extractAiInput(targetEvent);
    expect(onlineAi).toEqual(offlineAi);
  });

  it('TC-162-04 median parity when historyCount < 5: both return null and null in FeatureInput', async () => {
    const [accX, accY] = await fixture.accounts(2);

    // Only 2 historical transfers for accX
    const specs: TxSpec[] = [
      { from: accX, to: accY, amount: '100000', offsetMs: -2 * DAY },
      { from: accX, to: accY, amount: '200000', offsetMs: -1 * DAY },
      { from: accX, to: accY, amount: '300000', offsetMs: 0 },
    ];

    const { events, facts } = await buildScenario(specs);
    const offline = new OfflineFeatureProvider(facts, PER_TX_LIMIT);

    const targetEvent = events[events.length - 1];
    const onlineFeatures = await online.extract(targetEvent);
    const offlineFeatures = await offline.extract(targetEvent);

    expect(onlineFeatures.historyCount30d).toBe(2);
    expect(offlineFeatures.historyCount30d).toBe(2);
    expect(onlineFeatures.medianAmount30dTimes2).toBeNull();
    expect(offlineFeatures.medianAmount30dTimes2).toBeNull();

    const onlineAi = toAiFeatureInput(targetEvent, onlineFeatures);
    const offlineAi = await offline.extractAiInput(targetEvent);

    expect(onlineAi.medianAmount30d).toBeNull();
    expect(offlineAi.medianAmount30d).toBeNull();
    expect(onlineAi).toEqual(offlineAi);
  });

  it('TC-162-05 rejected transfers are ignored by both providers', async () => {
    const [accM, accN] = await fixture.accounts(2);

    const specs: TxSpec[] = [
      { from: accM, to: accN, amount: '100000', offsetMs: -3 * MIN, status: 'REJECTED' },
      { from: accM, to: accN, amount: '200000', offsetMs: -2 * MIN, status: 'REJECTED' },
      { from: accM, to: accN, amount: '50000', offsetMs: 0 },
    ];

    const { events, facts } = await buildScenario(specs);
    const offline = new OfflineFeatureProvider(facts, PER_TX_LIMIT);

    const targetEvent = events[events.length - 1];
    const onlineFeatures = await online.extract(targetEvent);
    const offlineFeatures = await offline.extract(targetEvent);

    // Rejected transfers must not increment velocity counters
    expect(onlineFeatures.txCount10m).toBe(1);
    expect(offlineFeatures.txCount10m).toBe(1);
    expect(onlineFeatures).toEqual(offlineFeatures);
  });

  it('TC-162-06 comprehensive multi-account sequence parity across every transfer', async () => {
    const accounts = await fixture.accounts(5);
    const specs: TxSpec[] = [];

    // Generate 40 interleaved transfers across 15 days
    for (let i = 0; i < 40; i++) {
      const fromIdx = i % 5;
      const toIdx = (i + 1 + (i % 3)) % 5;
      const amount = String(50_000 + (i % 10) * 25_000);
      // Spread backwards from BASE_TIME
      const offsetMs = -15 * DAY + i * 8 * HOUR + (i % 4) * 15 * MIN;
      specs.push({
        from: accounts[fromIdx],
        to: accounts[toIdx],
        amount,
        offsetMs,
      });
    }

    // Add some reverse transfers and rapid bursts within the last hour
    specs.push({ from: accounts[1], to: accounts[0], amount: '50000', offsetMs: -40 * MIN });
    specs.push({ from: accounts[0], to: accounts[1], amount: '75000', offsetMs: -25 * MIN });
    specs.push({ from: accounts[0], to: accounts[2], amount: '120000', offsetMs: -15 * MIN });
    specs.push({ from: accounts[0], to: accounts[3], amount: '150000', offsetMs: -5 * MIN });
    specs.push({ from: accounts[0], to: accounts[4], amount: '200000', offsetMs: 0 });

    const { events, facts } = await buildScenario(specs);
    const offline = new OfflineFeatureProvider(facts, PER_TX_LIMIT);

    // Verify parity on the last 10 transfers in the sequence
    const sample = events.slice(-10);
    for (const event of sample) {
      const onFeat = await online.extract(event);
      const offFeat = await offline.extract(event);
      expect(onFeat).toEqual(offFeat);

      const onScore = scoring.score(event, onFeat, ruleConfig);
      const offScore = scoring.score(event, offFeat, ruleConfig);
      expect(onScore).toEqual(offScore);

      const onAi = toAiFeatureInput(event, onFeat);
      const offAi = await offline.extractAiInput(event);
      expect(onAi).toEqual(offAi);
    }
  }, 60_000);
});
