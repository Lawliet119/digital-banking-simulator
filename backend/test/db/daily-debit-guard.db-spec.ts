import { Clock } from '@common/clock';
import { parsePositiveMoney } from '@common/money';
import { TransactionService } from '@database/transaction.service';
import { AccountsService } from '@modules/accounts';
import { SENT_TODAY_SQL, SyncGuardService } from '@modules/ledger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { debitAt } from '../support/daily-debit-counter';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Row = Awaited<ReturnType<typeof seedDepositTarget>>;

/** Small seeded generator: the same "random" scenario on every run, so a red run can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * BL-418, TC-418-04 and TC-418-05. The guard reads the day total from the row it has locked.
 * It must answer exactly as the SUM of DBS-84 did at every instant, and on the normal path it must
 * not read `ledger_entries` at all.
 */
describe('BL-418 the guard reads the day total from the locked account row', () => {
  let db: TempDatabase, app: App;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const tx = () => app.app.get(TransactionService, { strict: false });
  const accounts = () => app.app.get(AccountsService, { strict: false });
  const guard = () => app.app.get(SyncGuardService, { strict: false });
  const clock = () => app.app.get(Clock, { strict: false });
  const BASE = Date.parse('2026-03-10T10:00:00Z');
  const HOUR = 3_600_000;

  /** The verdict of the guard for `amount`, with `now` as the clock, plus every SQL it ran after the lock. */
  async function ask(source: Row, sink: Row, amount: bigint, now: Date) {
    jest.spyOn(clock(), 'now').mockReturnValue(now);
    const statements: string[] = [];
    const verdict = await tx().run(async manager => {
      const locked = await accounts().lockForUpdate([source.accountId, sink.accountId], manager);
      const original = manager.query.bind(manager) as (sql: string, params?: unknown[]) => unknown;
      jest.spyOn(manager, 'query').mockImplementation(((sql: string, params?: unknown[]) => {
        statements.push(sql);
        return original(sql, params);
      }) as never);
      return guard().checkGuards(
        manager,
        locked.find(a => a.id === source.accountId)!,
        locked.find(a => a.id === sink.accountId),
        parsePositiveMoney(amount.toString()),
      );
    });
    return { verdict, statements };
  }
  const readsLedger = (statements: string[]) => statements.some(s => /ledger_entries/i.test(s));

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
  });
  beforeEach(() => {
    // a day limit that no seeded line can reach, and a per-transfer limit above it
    app.limits.transfer.perTx = 2n * 10n ** 12n;
    app.limits.transfer.perDay = 10n ** 12n;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-418-04 runs no statement on ledger_entries when the counter is today, older, or empty', async () => {
    const source = await seedDepositTarget(db.runner),
      sink = await seedDepositTarget(db.runner),
      idle = await seedDepositTarget(db.runner);
    app.limits.transfer.perDay = 5_000n;
    await debitAt(db.runner, {
      actorId: source.userId,
      from: source.accountId,
      to: sink.accountId,
      amount: '4000',
      at: '2026-03-10T03:00:00Z',
    });
    // today (10 Mar in Vietnam): 4,000 + 1,001 is above 5,000, 4,000 + 1,000 is not
    const today = await ask(source, sink, 1_001n, new Date(BASE));
    expect(today.verdict).toBe('LIMIT_PER_DAY_EXCEEDED');
    expect(readsLedger(today.statements)).toBe(false);
    // the next Vietnam day: the counter is a day old, nothing was sent today
    const tomorrow = await ask(source, sink, 5_000n, new Date(BASE + 24 * HOUR));
    expect(tomorrow.verdict).not.toBe('LIMIT_PER_DAY_EXCEEDED');
    expect(readsLedger(tomorrow.statements)).toBe(false);
    // an account that never sent anything
    const never = await ask(idle, sink, 5_000n, new Date(BASE));
    expect(never.verdict).not.toBe('LIMIT_PER_DAY_EXCEEDED');
    expect(readsLedger(never.statements)).toBe(false);
  });

  it('TC-418-04 runs exactly SENT_TODAY_SQL when the clock is behind the counter (the slow, exact path)', async () => {
    const source = await seedDepositTarget(db.runner),
      sink = await seedDepositTarget(db.runner);
    app.limits.transfer.perDay = 5_000n;
    // a line dated the 12th: the counter is the 12th. The clock says the 10th.
    await debitAt(db.runner, {
      actorId: source.userId,
      from: source.accountId,
      to: sink.accountId,
      amount: '4000',
      at: '2026-03-12T03:00:00Z',
    });
    const behind = await ask(source, sink, 1_001n, new Date(BASE));
    expect(behind.statements).toEqual([SENT_TODAY_SQL]);
    // SENT_TODAY_SQL counts every line from the clock's midnight on, the 12th included
    expect(behind.verdict).toBe('LIMIT_PER_DAY_EXCEEDED');
  });

  it('TC-418-05 answers like the SUM of DBS-84 at every instant of a random ledger (seeded)', async () => {
    const random = mulberry32(418);
    const source = await seedDepositTarget(db.runner),
      sink = await seedDepositTarget(db.runner);
    // 48 debit lines in random order over 6 days around BASE: past, present and future of every clock below
    for (let i = 0; i < 48; i++) {
      const at = new Date(BASE + Math.floor((random() - 0.5) * 6 * 24 * HOUR)).toISOString();
      await debitAt(db.runner, {
        actorId: source.userId,
        from: source.accountId,
        to: sink.accountId,
        amount: String(1 + Math.floor(random() * 5_000_000)),
        at,
      });
    }
    // every Vietnam midnight in range, one second before / on / after it, and some random instants
    const clocks: number[] = [];
    for (let d = -3; d <= 3; d++) {
      const midnight = Date.parse('2026-03-10T17:00:00Z') + d * 24 * HOUR;
      clocks.push(midnight - 1000, midnight, midnight + 1000);
    }
    for (let i = 0; i < 12; i++) clocks.push(BASE + Math.floor((random() - 0.5) * 6 * 24 * HOUR));
    let slowPath = 0;
    for (const instant of clocks) {
      const now = new Date(instant);
      const [{ total }] = await q(SENT_TODAY_SQL, [source.accountId, now.toISOString()]);
      const sent = BigInt(total as string);
      const perDay = app.limits.transfer.perDay;
      // exactly at the limit is allowed, one dong more is not
      const over = await ask(source, sink, perDay - sent + 1n, now);
      const at = await ask(source, sink, perDay - sent, now);
      expect({ instant: now.toISOString(), over: over.verdict }).toEqual({
        instant: now.toISOString(),
        over: 'LIMIT_PER_DAY_EXCEEDED',
      });
      expect({ instant: now.toISOString(), at: at.verdict }).not.toEqual({
        instant: now.toISOString(),
        at: 'LIMIT_PER_DAY_EXCEEDED',
      });
      if (readsLedger(over.statements)) slowPath++;
    }
    // both paths were really exercised: some clocks are behind the counter, most are not
    expect(slowPath).toBeGreaterThan(0);
    expect(slowPath).toBeLessThan(clocks.length);
    // and the guard never invented a refusal for an account that sent nothing
    const idle = await seedDepositTarget(db.runner);
    expect((await ask(idle, sink, app.limits.transfer.perDay, new Date(BASE))).verdict).not.toBe(
      'LIMIT_PER_DAY_EXCEEDED',
    );
  }, 120_000);
});
