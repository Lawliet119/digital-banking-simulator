import assert from 'node:assert/strict';
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

async function main(): Promise<void> {
  let db: TempDatabase | undefined;
  let source: DataSource | undefined;
  try {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const fixture = new TransferFixture(db.runner);
    const online = new OnlineFeatureProvider({
      facts: new TransferFacts(source),
      perTxLimit: PER_TX_LIMIT,
    });
    const scoring = new ScoringService();
    const ruleConfig = parseRuleSet(1, SEED_V1);

    const accounts = await fixture.accounts(4);
    const events: TransferEvent[] = [];
    const facts: OfflineTransferFact[] = [];

    // Create 30 transfers spanning across multiple windows
    for (let i = 0; i < 30; i++) {
      const from = accounts[i % 4];
      const to = accounts[(i + 1) % 4];
      const amount = String(100_000 + i * 20_000);
      const atMs = BASE_TIME - 10 * DAY + i * 8 * HOUR;
      const atIso = new Date(atMs).toISOString();

      const row = await fixture.transfer({
        from,
        to,
        amount,
        at: atIso.replace('Z', '456Z'),
      });

      events.push({
        eventType: 'TransferCompleted',
        correlationId: `parity-manual-${i}`,
        eventId: row.id,
        transferId: row.id,
        type: 'TRANSFER',
        fromUserId: `user-${from}`,
        toUserId: `user-${to}`,
        fromAccountId: from,
        toAccountId: to,
        amount,
        fromBalanceBefore: '500000000',
        sameOwner: false,
        occurredAt: atIso,
        fromAccountCreatedAt: new Date(BASE_TIME - 45 * DAY).toISOString(),
        toAccountCreatedAt: new Date(BASE_TIME - 45 * DAY).toISOString(),
      });

      facts.push({
        id: row.id,
        fromAccountId: from,
        toAccountId: to,
        createdAt: atIso,
        amount,
      });
    }

    const offline = new OfflineFeatureProvider(facts, PER_TX_LIMIT);

    let matchCount = 0;
    for (const event of events) {
      const onFeat = await online.extract(event);
      const offFeat = await offline.extract(event);
      assert.deepEqual(onFeat, offFeat);

      const onScore = scoring.score(event, onFeat, ruleConfig);
      const offScore = scoring.score(event, offFeat, ruleConfig);
      assert.deepEqual(onScore, offScore);

      const onAi = toAiFeatureInput(event, onFeat);
      const offAi = await offline.extractAiInput(event);
      assert.deepEqual(onAi, offAi);

      matchCount++;
    }

    console.log(`M-162 PASS: Verified ${matchCount}/${events.length} transfers with 100% parity`);
    console.log(
      'M-162 PASS: OnlineFeatureProvider and OfflineFeatureProvider agree on Features, Rule Scoring and FeatureInput',
    );
  } finally {
    if (source?.isInitialized) await source.destroy();
    await db?.drop();
  }
}

void main().catch(error => {
  console.error(`M-162 FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
});
