import { setTimeout as wait } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { RedisClient, RedisMetrics, RedisUnavailableError } from '@libs/redis';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import { countTransfersInWindow } from '@modules/risk/features/velocity-count';
import { TransferFacts } from '@modules/risk/features/transfer-facts';
import type { CounterRedis } from '@modules/risk/features/window-counter';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

const MIN = 60_000;
const BASE = Date.parse('2026-10-19T03:00:00.000Z');
const PER_TX = 500_000n;

/** A Redis that never answers: the reference provider built on it is "SQL only". */
const deadRedis: CounterRedis = {
  get: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
  set: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
  incr: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
  zadd: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
  zrangebyscore: () => Promise.reject(new RedisUnavailableError('UNAVAILABLE')),
};

/** DBS-109: the Redis counters and the SQL fallback give the same features, whatever Redis does. */
describe('OnlineFeatureProvider (real PostgreSQL + Valkey)', () => {
  let valkey: StartedValkey;
  let db: TempDatabase;
  let source: DataSource;
  let fixture: TransferFixture;
  let client: RedisClient;
  let facts: TransferFacts;
  let live: OnlineFeatureProvider;
  let sqlOnly: OnlineFeatureProvider;
  let metrics: RiskMetrics;

  beforeAll(async () => {
    valkey = await startValkeyContainer();
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    fixture = new TransferFixture(db.runner);
    facts = new TransferFacts(source);
    client = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    const deadline = Date.now() + 10_000;
    while (!client.isReady && Date.now() < deadline) await wait(20);
  });
  afterAll(async () => {
    client?.onModuleDestroy();
    await source?.destroy();
    await db?.drop();
    await valkey?.stop();
  });
  beforeEach(() => {
    metrics = new RiskMetrics();
    live = new OnlineFeatureProvider({ facts, redis: client, perTxLimit: PER_TX, metrics });
    sqlOnly = new OnlineFeatureProvider({
      facts,
      redis: deadRedis,
      perTxLimit: PER_TX,
      metrics: new RiskMetrics(),
    });
  });

  /** The event that goes with a transfer row (the fields the provider reads). */
  const eventFor = (
    transfer: { id: string; from: string; to: string },
    atMs: number,
  ): TransferEvent =>
    ({
      ...TRANSFER_SAMPLE,
      eventId: transfer.id,
      transferId: transfer.id,
      fromAccountId: transfer.from,
      toAccountId: transfer.to,
      occurredAt: new Date(atMs).toISOString(),
    }) as TransferEvent;

  /** Writes one transfer (microsecond digits like the real column) and returns its event. */
  async function send(from: string, to: string, atMs: number, amount = '40000') {
    const row = await fixture.transfer({
      from,
      to,
      amount,
      at: new Date(atMs).toISOString().replace('Z', '321Z'),
    });
    return eventFor(row, atMs);
  }

  async function healthy(): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await client.ping();
        return;
      } catch {
        if (Date.now() > deadline) throw new Error('Valkey did not come back');
        await wait(250);
      }
    }
  }

  it('TC-109-06 in order, Redis and SQL give the same features at every step, and match the reference count', async () => {
    const [a, ...recipients] = await fixture.accounts(7);
    const history: { transferId: string; occurredAt: string }[] = [];
    // 16 transfers a few minutes apart; recipients repeat, so some are new and some are not.
    for (let i = 0; i < 16; i++) {
      const to = recipients[(i * 5) % 6];
      const event = await send(a, to, BASE + i * 7 * MIN);
      const fromRedis = await live.extract(event);
      expect(fromRedis).toEqual(await sqlOnly.extract(event));
      history.push({ transferId: event.transferId, occurredAt: event.occurredAt });
      const stamps = history.slice(0, -1);
      const current = history[history.length - 1];
      expect(fromRedis.txCount10m).toBe(countTransfersInWindow(current, stamps, 10));
      expect(fromRedis.txCount1h).toBe(countTransfersInWindow(current, stamps, 60));
      // A redelivery of the same event changes nothing: the member is the transferId.
      expect(await live.extract(event)).toEqual(fromRedis);
    }
    expect(await metrics.count('R1', 'cold')).toBe(1);
    expect(await metrics.count('R1', 'error')).toBe(0);
  });

  it('TC-109-06 seven new recipients inside an hour are counted by Redis exactly as by SQL', async () => {
    const [a, ...recipients] = await fixture.accounts(8);
    let last = 0;
    for (const [i, to] of recipients.entries()) {
      const event = await send(a, to, BASE + i * 3 * MIN);
      const features = await live.extract(event);
      expect(features).toEqual(await sqlOnly.extract(event));
      last = features.newRecipients1h;
    }
    expect(last).toBe(7);
  });

  it('TC-109-09 an event delivered much later gives the same features as one handled at once', async () => {
    const [a, b, c] = await fixture.accounts(3);
    const early = await send(a, b, BASE);
    const middle = await send(a, c, BASE + 20 * MIN);
    const newest = await send(a, b, BASE + 3 * 60 * MIN);
    // The newest is handled first, so the set is loaded for its window only.
    const handledFirst = await live.extract(newest);
    expect(handledFirst).toEqual(await sqlOnly.extract(newest));
    for (const event of [middle, early]) {
      expect(await live.extract(event)).toEqual(await sqlOnly.extract(event));
    }
  });

  it('TC-109-07 with Redis paused the features stay exact; after it returns, transfers handled meanwhile still count', async () => {
    const [a, ...recipients] = await fixture.accounts(6);
    const first = await send(a, recipients[0], BASE);
    const second = await send(a, recipients[1], BASE + 2 * MIN);
    for (const event of [first, second]) {
      expect(await live.extract(event)).toEqual(await sqlOnly.extract(event));
    }

    await valkey.pause();
    try {
      const during: TransferEvent[] = [];
      for (let i = 0; i < 14; i++) {
        const event = await send(a, recipients[2 + (i % 3)], BASE + (4 + i) * MIN);
        during.push(event);
        expect(await live.extract(event)).toEqual(await sqlOnly.extract(event));
      }
      expect(await metrics.count('R1', 'error')).toBeGreaterThanOrEqual(14);
      expect(await metrics.count('R5', 'error')).toBeGreaterThanOrEqual(14);
    } finally {
      await valkey.resume();
    }
    await healthy();

    const after = await send(a, recipients[0], BASE + 30 * MIN);
    const features = await live.extract(after);
    expect(features).toEqual(await sqlOnly.extract(after));
    expect(features.txCount1h).toBe(17); // 2 before the outage + 14 during + this one
    // And the next one is served from the reloaded set, still exact.
    const next = await send(a, recipients[4], BASE + 31 * MIN);
    expect(await live.extract(next)).toEqual(await sqlOnly.extract(next));
  });

  it('TC-109-08 an open breaker answers from SQL quickly instead of waiting on Redis', async () => {
    // A client of its own, so the breaker starts closed whatever the other tests did to the shared one.
    const own = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    const deadline = Date.now() + 10_000;
    while (!own.isReady && Date.now() < deadline) await wait(20);
    const provider = new OnlineFeatureProvider({
      facts,
      redis: own,
      perTxLimit: PER_TX,
      metrics: new RiskMetrics(),
    });
    const [a, b] = await fixture.accounts(2);
    await valkey.pause();
    try {
      // Ten timeouts open the breaker; the rest are rejected at once.
      for (let i = 0; i < 40 && own.circuitState !== 'open'; i++) {
        await provider.extract(await send(a, b, BASE + i * MIN));
      }
      expect(own.circuitState).toBe('open');
      const event = await send(a, b, BASE + 50 * MIN);
      const started = Date.now();
      const features = await provider.extract(event);
      expect(Date.now() - started).toBeLessThan(500);
      expect(features).toEqual(await sqlOnly.extract(event));
    } finally {
      await valkey.resume();
      own.onModuleDestroy();
    }
    await healthy();
  });
});
