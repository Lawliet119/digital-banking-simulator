// From backend/: DATABASE_URL=<postgres server> npx ts-node -r tsconfig-paths/register test/manual/online-feature-provider.manual.ts
// Needs `docker compose up -d` (Valkey on :6379, container dbs-valkey-1) and a PostgreSQL server for the throwaway DB.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { RedisClient, RedisMetrics, RedisUnavailableError } from '@libs/redis';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import { TransferFacts } from '@modules/risk/features/transfer-facts';
import type { CounterRedis } from '@modules/risk/features/window-counter';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate } from '../support/temp-database';

const CONTAINER = 'dbs-valkey-1';
const MIN = 60_000;
const BASE = Date.parse('2026-10-19T03:00:00.000Z');
const dead: CounterRedis = {
  get: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
  set: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
  incr: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
  zadd: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
  zrangebyscore: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
};

async function main(): Promise<void> {
  const db = await createTempDatabase();
  let source: DataSource | undefined;
  let client: RedisClient | undefined;
  let paused = false;
  try {
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const facts = new TransferFacts(source);
    const fixture = new TransferFixture(db.runner);
    client = new RedisClient(
      { url: 'redis://localhost:6379', commandTimeoutMs: 50 },
      new RedisMetrics(),
    );
    while (!client.isReady) await wait(20);
    const metrics = new RiskMetrics();
    const live = new OnlineFeatureProvider({
      facts,
      redis: client,
      perTxLimit: 500_000n,
      metrics,
    });
    const sqlOnly = new OnlineFeatureProvider({
      facts,
      redis: dead,
      perTxLimit: 500_000n,
      metrics: new RiskMetrics(),
    });
    const [an, binh, chi, dung] = await fixture.accounts(4);
    const send = async (from: string, to: string, atMs: number, status?: 'REJECTED') => {
      const row = await fixture.transfer({
        from,
        to,
        at: new Date(atMs).toISOString().replace('Z', '457Z'),
        amount: '40000',
        status,
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

    // M-109-01: seven transfers An -> Bình/Chi/Dũng, a reverse transfer and a rejected one.
    await send(binh, an, BASE - 20 * MIN); // reverse, 20 minutes before the first
    await send(an, binh, BASE, 'REJECTED');
    let last: TransferEvent | undefined;
    for (let i = 0; i < 7; i++)
      last = await send(an, [binh, chi, dung][i % 3], BASE + (i + 1) * MIN);
    const features = await live.extract(last!);
    assert.equal(features.txCount10m, 7);
    assert.equal(features.txCount1h, 7);
    assert.equal(features.newRecipients1h, 3);
    assert.equal(features.reverseTransferOccurredAt, new Date(BASE - 20 * MIN).toISOString());
    console.log(
      `M-109-01 PASS: txCount10m=${features.txCount10m} newRecipients1h=${features.newRecipients1h} reverse=${features.reverseTransferOccurredAt} (rejected transfer not counted)`,
    );

    // M-109-02: redelivery, then parity with SQL.
    const again = await live.extract(last!);
    assert.deepEqual(again, features);
    assert.deepEqual(await sqlOnly.extract(last!), features);
    console.log('M-109-02 PASS: same event again and SQL-only give identical features');

    // M-109-03: Valkey paused during two more transfers, then back.
    execFileSync('docker', ['pause', CONTAINER]);
    paused = true;
    const during1 = await send(an, binh, BASE + 8 * MIN);
    const during2 = await send(an, chi, BASE + 9 * MIN);
    for (const event of [during1, during2])
      assert.deepEqual(await live.extract(event), await sqlOnly.extract(event));
    const errors = await metrics.count('R1', 'error');
    assert.ok(errors >= 2);
    execFileSync('docker', ['unpause', CONTAINER]);
    paused = false;
    for (let i = 0; i < 80; i++) {
      try {
        await client.ping();
        break;
      } catch {
        await wait(250);
      }
    }
    const after = await send(an, dung, BASE + 10 * MIN);
    const recovered = await live.extract(after);
    assert.deepEqual(recovered, await sqlOnly.extract(after));
    assert.equal(recovered.txCount1h, 10);
    console.log(
      `M-109-03 PASS: Valkey paused -> exact features from SQL (R1 fallbacks=${errors}); after unpause txCount1h=${recovered.txCount1h} includes the transfers made during the outage`,
    );
  } finally {
    if (paused) execFileSync('docker', ['unpause', CONTAINER]);
    client?.onModuleDestroy();
    await source?.destroy();
    await db.drop();
    console.log('cleanup done: temp database dropped');
  }
}

main().catch((error: unknown) => {
  console.error('FAILED', error);
  process.exitCode = 1;
});
