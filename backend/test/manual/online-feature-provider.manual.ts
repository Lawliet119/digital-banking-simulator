// Run with NODE_ENV=test and DATABASE_URL pointing only at an isolated PostgreSQL server.
// See docs/features/BUG-20261110-fraud-feature-order.md for scope and unmeasured load limits.
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import { TransferFacts } from '@modules/risk/features/transfer-facts';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate } from '../support/temp-database';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = Date.parse('2026-11-09T03:00:00.000Z');

async function main(): Promise<void> {
  const db = await createTempDatabase();
  let source: DataSource | undefined;
  try {
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const fixture = new TransferFixture(db.runner);
    const provider = new OnlineFeatureProvider({
      facts: new TransferFacts(source),
      perTxLimit: 500_000n,
    });
    const send = async (from: string, to: string, atMs: number): Promise<TransferEvent> => {
      const row = await fixture.transfer({
        from,
        to,
        amount: '40000',
        at: new Date(atMs).toISOString(),
      });
      return {
        ...TRANSFER_SAMPLE,
        eventId: row.id,
        transferId: row.id,
        fromAccountId: from,
        toAccountId: to,
        occurredAt: new Date(atMs).toISOString(),
      } as TransferEvent;
    };
    const [a, b, c, d] = await fixture.accounts(4);
    const historical = await send(a, b, BASE - 31 * DAY);
    const first = await send(a, b, BASE);
    assert.equal((await provider.extract(first)).newRecipients1h, 1);
    const undelivered = await send(a, c, BASE + MIN);
    const latest = await send(a, d, BASE + 2 * MIN);
    const features = await provider.extract(latest);
    assert.equal(features.txCount10m, 3);
    assert.equal(features.txCount1h, 3);
    assert.equal(features.newRecipients1h, 3);
    assert.equal(features.sumOut24h, '120000');
    assert.deepEqual(await provider.extract(latest), features);
    console.log(
      'M-ORDER-01 PASS: committed undelivered rows counted by R1/R5; redelivery unchanged',
    );
    assert.equal((await provider.extract(undelivered)).txCount10m, 2);
    assert.equal((await provider.extract(historical)).newRecipients1h, 1);
    assert.deepEqual(await provider.extract(latest), features);
    console.log('M-ORDER-02 PASS: historical replay does not mutate future windows');

    // M-ORDER-03 (BL-212): the error and recovery path. A SQL failure rejects `extract` (the consumer
    // then rolls back and retries; nothing partial is scored), and the same call succeeds, with the
    // same features, once the database answers again. There is no Redis here since BUG-20261110.
    let failing = true;
    const flaky = new OnlineFeatureProvider({
      facts: new TransferFacts({
        query: (sql: string, params?: unknown[]) =>
          failing
            ? Promise.reject(new Error('connection lost'))
            : (source as DataSource).query(sql, params),
      }),
      perTxLimit: 500_000n,
    });
    await assert.rejects(() => flaky.extract(latest), /connection lost/);
    failing = false;
    assert.deepEqual(await flaky.extract(latest), features);
    console.log(
      'M-ORDER-03 PASS: SQL failure -> extract rejects; after recovery the features equal the healthy ones',
    );
  } finally {
    try {
      if (source?.isInitialized) await source.destroy();
    } finally {
      await db.drop();
    }
    console.log('cleanup: isolated temporary database dropped');
  }
}

main().catch((error: unknown) => {
  console.error('FAILED', error);
  process.exitCode = 1;
});
