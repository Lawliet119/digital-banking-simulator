import { DataSource, type QueryRunner } from 'typeorm';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { OnlineFeatureProvider } from '@modules/risk/features/online-feature-provider';
import { TransferFacts, type Queryable } from '@modules/risk/features/transfer-facts';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const MIN = 60_000;
const BASE = Date.parse('2026-11-09T03:00:00.000Z');
const at = (deltaMs: number): string => new Date(BASE + deltaMs).toISOString();

/**
 * BL-187: the five SELECTs of `OnlineFeatureProvider.extract` read one snapshot. A transfer that
 * commits on another connection while the extraction runs must be counted by all five or by none.
 */
describe('OnlineFeatureProvider reads one snapshot (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  let fixture: TransferFixture;
  let from: string;
  let to: string;
  let other: string;
  let third: string;
  let event: TransferEvent;

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 10 },
    }).initialize();
    fixture = new TransferFixture(db.runner);
    [from, to, other, third] = await fixture.accounts(4);
    // History, a recipient inside the hour, and the event's own transfer.
    await fixture.transfer({ from, to, at: at(-3 * 24 * 60 * MIN) });
    await fixture.transfer({ from, to, at: at(-20 * MIN) });
    await fixture.transfer({ from: to, to: from, at: at(-30 * MIN) });
    const current = await fixture.transfer({ from, to, at: at(0) });
    event = {
      ...TRANSFER_SAMPLE,
      eventId: current.id,
      transferId: current.id,
      fromAccountId: from,
      toAccountId: to,
      occurredAt: at(0),
    } as TransferEvent;
  });
  afterEach(async () => {
    try {
      await source?.destroy();
    } finally {
      await db?.drop();
    }
  });

  /** A source whose connections run `afterQuery(sql)` once the database has answered each query. */
  function spiedSource(afterQuery: (sql: string) => Promise<void>) {
    const sql: string[] = [];
    let leased = 0;
    const lent = {
      query: (text: string, params?: unknown[]): Promise<unknown> => source.query(text, params),
      createQueryRunner: (): QueryRunner => {
        leased++;
        const runner = source.createQueryRunner();
        const run = runner.query.bind(runner);
        runner.query = (async (text: string, params?: unknown[]) => {
          const rows: unknown = await run(text, params);
          sql.push(text);
          await afterQuery(text);
          return rows;
        }) as QueryRunner['query'];
        return runner;
      },
    };
    return { lent, sql, leases: () => leased };
  }

  /** The `pg` pool behind the DataSource, to see whether a connection was left busy. */
  const pool = () =>
    (source.driver as unknown as { master: { totalCount: number; idleCount: number } }).master;

  const features = (facts: Queryable) =>
    new OnlineFeatureProvider({ facts: new TransferFacts(facts), perTxLimit: 500_000n }).extract(
      event,
    );

  it('TC-187-01 a transfer committed after the snapshot opened is invisible to all five SELECTs', async () => {
    const before = await features(source);
    let committed = false;
    const spy = spiedSource(async text => {
      // The statement that opens the snapshot has just returned; commit a new transfer elsewhere.
      if (!committed && text.startsWith('START TRANSACTION')) {
        committed = true;
        await fixture.transfer({ from, to: other, at: at(-1 * MIN), amount: '40000' });
      }
    });

    const during = await features(spy.lent);

    expect(committed).toBe(true);
    expect(during).toEqual(before);
    // The committed transfer is real: a new extraction, after the first one ended, sees it in
    // R1 (velocity), R5 (new recipients) and R6 (outflow) at once.
    const after = await features(source);
    expect(after.txCount10m).toBe(before.txCount10m + 1);
    expect(after.txCount1h).toBe(before.txCount1h + 1);
    expect(after.newRecipients1h).toBe(before.newRecipients1h + 1);
    expect(after.distinctRecipients24h).toBe(before.distinctRecipients24h + 1);
    expect(after.smallTxCount24h).toBe(before.smallTxCount24h + 1);
    expect(BigInt(after.sumOut24h)).toBe(BigInt(before.sumOut24h) + 40_000n);
  });

  it('TC-187-02 without a snapshot the same commit splits the five SELECTs (the test can fail)', async () => {
    const before = await features(source);
    const facts = new TransferFacts(source);
    // What the provider did before BL-187: one autocommitted statement per query.
    const first = await facts.velocity(from, event.transferId, BASE);
    await fixture.transfer({ from, to: other, at: at(-1 * MIN) });
    const second = await facts.newRecipientCount(from, BASE);
    expect(first.hour).toBe(before.txCount1h);
    expect(second).toBe(before.newRecipients1h + 1);

    // Inside one snapshot the same two reads agree.
    await expect(
      facts.snapshot(async inner => {
        const a = await inner.velocity(from, event.transferId, BASE);
        await fixture.transfer({ from, to: third, at: at(-2 * MIN) });
        const b = await inner.newRecipientCount(from, BASE);
        return { hour: a.hour, recipients: b };
      }),
    ).resolves.toEqual({ hour: before.txCount1h + 1, recipients: before.newRecipients1h + 1 });
  });

  it('TC-187-03 one extraction leases one connection and runs begin, five SELECTs and commit on it', async () => {
    const spy = spiedSource(() => Promise.resolve());
    await features(spy.lent);

    expect(spy.leases()).toBe(1);
    expect(spy.sql[0]).toMatch(/^START TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
    expect(spy.sql.slice(1, 6).every(text => /v_transfer_facts/.test(text))).toBe(true);
    expect(spy.sql.slice(1, 6)).toHaveLength(5);
    expect(spy.sql[6]).toBe('COMMIT');
    expect(spy.sql).toHaveLength(7);
  });

  it('TC-187-04 the snapshot is read only and its timeouts do not outlive it', async () => {
    const facts = new TransferFacts(source);
    // `max: 1` would hide a leak; use the pool as it is and look at the leased connection twice.
    const leaked = await facts.snapshot(async inner => {
      const rows = (await (inner as unknown as { db: Queryable }).db.query(
        `SELECT current_setting('transaction_read_only') AS ro,
                current_setting('transaction_isolation') AS iso,
                current_setting('statement_timeout') AS st`,
      )) as Record<string, string>[];
      return rows[0];
    });
    expect(leaked).toEqual({ ro: 'on', iso: 'repeatable read', st: '5s' });

    await expect(
      facts.snapshot(async inner => {
        await (inner as unknown as { db: Queryable }).db.query(
          `INSERT INTO users(id, cognito_sub) VALUES (gen_random_uuid(), 'x')`,
        );
      }),
    ).rejects.toMatchObject({ code: '25006' });

    // Every connection of the pool answers with the default again: nothing leaked, nothing stuck.
    const settings = await Promise.all(
      Array.from({ length: 10 }, () =>
        source.query(`SELECT current_setting('statement_timeout') AS st`),
      ),
    );
    expect(settings.every((rows: { st: string }[]) => rows[0].st === '0')).toBe(true);
    expect(pool().totalCount).toBeLessThanOrEqual(10);
    expect(pool().idleCount).toBe(pool().totalCount);
  });

  it('TC-187-05 a failing query rolls back, frees the connection and rejects the whole extraction', async () => {
    const failing = new TransferFacts(source);
    const failure = new Error('boom');
    await expect(
      failing.snapshot(async inner => {
        await inner.velocity(from, event.transferId, BASE);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(pool().idleCount).toBe(pool().totalCount);
    // The released connection is back outside any transaction.
    const [row] = await source.query<{ fresh: boolean }[]>(
      `SELECT now() = statement_timestamp() AS fresh`,
    );
    expect(row.fresh).toBe(true);
  });
});
