import { randomUUID } from 'node:crypto';
import { parsePositiveMoney } from '@common/money';
import { SystemClock } from '@common/clock';
import { TransactionService } from '@database/transaction.service';
import { ReconciliationService } from '@modules/ledger';
import type { QueryRunner } from 'typeorm';
import { counterOf } from '../support/daily-debit-counter';
import { checkLedgerInvariants } from '../support/invariants';
import {
  INVARIANT_FUNDING_ID,
  seedInvariantAccounts,
  seedInvariantLedger,
} from '../support/invariant-fixtures';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * BL-421: the reconciliation job (worker, every interval) also checks the daily debit counter
 * `accounts.sent_today` / `sent_day` (BL-418) against the DEBIT lines of `ledger_entries`: the same
 * rule as check 6 of `check:invariants` (`daily_debit_totals`), so a counter that counts too little
 * (trigger off, `session_replication_role = replica`, a hand edit with the owner role) can no longer
 * let the daily limit be passed without a signal.
 */
describe('BL-421 reconciliation checks the daily debit counter (real PostgreSQL)', () => {
  let db: TempDatabase;
  let service: ReconciliationService;

  const q = (sql: string, args: unknown[] = []) => db.runner.connection.query(sql, args);

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    const tx = new TransactionService(db.runner.connection, {
      url: db.url,
      poolMax: 10,
      ssl: false,
      sslCaPath: undefined,
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    });
    service = new ReconciliationService(tx, new SystemClock(), {
      transfer: { perTx: parsePositiveMoney('50000000'), perDay: parsePositiveMoney('200000000') },
      idempotencyKeyRetentionDays: 7,
      outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
      rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
      reconciliationIntervalMs: 300_000,
    });
  });

  afterEach(async () => {
    if (db?.runner.isTransactionActive) {
      await db.runner.rollbackTransaction();
    }
    await db?.drop();
  });

  async function committed<T>(fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
    await db.runner.startTransaction();
    try {
      const result = await fn(db.runner);
      await db.runner.commitTransaction();
      return result;
    } catch (error) {
      if (db.runner.isTransactionActive) await db.runner.rollbackTransaction();
      throw error;
    }
  }

  /**
   * A COMPLETED transfer posted at an exact instant with both lines and both balances, so that
   * everything but the counter stays consistent (checks 1 to 4 keep passing).
   */
  async function postAt(input: {
    actorId: string;
    from: string;
    to: string;
    amount: string;
    at: string;
  }): Promise<void> {
    const [transfer] = await q(
      `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id,created_at)
       VALUES('TRANSFER',$1,$2,$3,'COMPLETED',$4,$5,$6::timestamptz) RETURNING id`,
      [input.from, input.to, input.amount, input.actorId, randomUUID(), input.at],
    );
    for (const [account, direction, delta] of [
      [input.from, 'DEBIT', `-${input.amount}`],
      [input.to, 'CREDIT', input.amount],
    ] as const) {
      const [row] = await q(
        'WITH changed AS (UPDATE accounts SET balance = balance + $2::bigint WHERE id = $1 RETURNING balance) SELECT balance::text AS balance FROM changed',
        [account, delta],
      );
      await q(
        `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount,balance_after,created_at)
         VALUES($1,$2,$3,$4,$5,$6::timestamptz)`,
        [transfer.id, account, direction, input.amount, row.balance, input.at],
      );
    }
  }

  /** The two outcomes that must agree: the periodic job and the manual checker. */
  async function both() {
    const run = await service.reconcileOnce();
    const report = await checkLedgerInvariants(db.runner);
    return { run, report };
  }

  const counterChecks = (report: Awaited<ReturnType<typeof checkLedgerInvariants>>) =>
    report.violations.filter(v => v.check === 'daily_debit_totals');

  it('TC-421-02 a counter that equals the DEBIT lines reconciles OK; an owner edit of sent_today is a MISMATCH that check:invariants also names; the fix recovers', async () => {
    const refs = await committed(runner => seedInvariantLedger(runner));
    const before = await counterOf(db.runner, refs.senderId);
    expect(before.sentToday).toBe('250000'); // a real counter: the fixture debited the sender

    const clean = await both();
    expect(clean.run).toMatchObject({ executed: true, status: 'OK', mismatchedAccounts: 0 });
    expect(clean.report.status).toBe('PASS');

    await q('UPDATE public.accounts SET sent_today = sent_today + 1 WHERE id = $1', [
      refs.senderId,
    ]);
    const tampered = await both();
    // Totals and balances are right, so the run names no account: the row says MISMATCH and the
    // operator opens `check:invariants` for the account (the log line carries the failed check).
    expect(tampered.run).toMatchObject({
      executed: true,
      status: 'MISMATCH',
      totalDebit: '1250000',
      totalCredit: '1250000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });
    expect(tampered.report.status).toBe('FAIL');
    expect(tampered.report.violations).toEqual([
      expect.objectContaining({ check: 'daily_debit_totals', accountId: refs.senderId }),
    ]);

    await q('UPDATE public.accounts SET sent_today = $2::bigint WHERE id = $1', [
      refs.senderId,
      before.sentToday,
    ]);
    const recovered = await both();
    expect(recovered.run).toMatchObject({ executed: true, status: 'OK' });
    expect(recovered.report.status).toBe('PASS');
  });

  it('TC-421-03 detects an UNDER-count: counter reset, day moved back, trigger off while a transfer posts', async () => {
    const refs = await committed(runner => seedInvariantLedger(runner));
    const good = await counterOf(db.runner, refs.senderId);

    // (a) reset to "never sent".
    await q('UPDATE public.accounts SET sent_today = 0, sent_day = NULL WHERE id = $1', [
      refs.senderId,
    ]);
    expect((await both()).run).toMatchObject({ executed: true, status: 'MISMATCH' });
    await q(
      'UPDATE public.accounts SET sent_today = $2::bigint, sent_day = $3::date WHERE id = $1',
      [refs.senderId, good.sentToday, good.sentDay],
    );
    expect((await both()).run).toMatchObject({ executed: true, status: 'OK' });

    // (b) the day moved back by one: same total, wrong day.
    await q('UPDATE public.accounts SET sent_day = sent_day - 1 WHERE id = $1', [refs.senderId]);
    expect((await both()).run).toMatchObject({ executed: true, status: 'MISMATCH' });
    await q('UPDATE public.accounts SET sent_day = $2::date WHERE id = $1', [
      refs.senderId,
      good.sentDay,
    ]);
    expect((await both()).run).toMatchObject({ executed: true, status: 'OK' });

    // (c) the trigger is off while a balanced transfer posts: only the counter falls behind.
    await q('ALTER TABLE public.ledger_entries DISABLE TRIGGER ledger_entries_daily_debit_counter');
    try {
      await postAt({
        actorId: refs.actorId,
        from: refs.senderId,
        to: refs.recipientId,
        amount: '1000',
        at: new Date().toISOString(),
      });
    } finally {
      await q(
        'ALTER TABLE public.ledger_entries ENABLE TRIGGER ledger_entries_daily_debit_counter',
      );
    }
    const offTrigger = await both();
    expect(offTrigger.report.violations.map(v => v.check)).toEqual(['daily_debit_totals']);
    expect(offTrigger.run).toMatchObject({
      executed: true,
      status: 'MISMATCH',
      mismatchedAccounts: 0, // balances and totals are right: the counter is the only fault
    });
  });

  it('TC-421-04 agrees with check:invariants across a Vietnam midnight and over several days; SYSTEM accounts carry no counter', async () => {
    const refs = await committed(runner => seedInvariantAccounts(runner));
    const input = { actorId: refs.actorId, from: refs.senderId, to: refs.recipientId };
    // The sender is funded first (the SYSTEM account has no counter), so no balance goes negative.
    await postAt({
      actorId: refs.actorId,
      from: INVARIANT_FUNDING_ID,
      to: refs.senderId,
      amount: '1000000',
      at: '2026-11-19T00:00:00Z',
    });
    // 17:00Z is 00:00 in Vietnam: one second before it, exactly at it, later that day, then a later day.
    const posts = [
      ['2026-11-20T16:59:59Z', '3000'],
      ['2026-11-20T17:00:00Z', '5000'],
      ['2026-11-20T23:00:00Z', '700'],
      ['2026-11-22T01:00:00Z', '40'],
      ['2026-11-22T01:00:01Z', '2'],
    ] as const;
    const seen: string[] = [];
    for (const [at, amount] of posts) {
      await postAt({ ...input, amount, at });
      const counter = await counterOf(db.runner, refs.senderId);
      seen.push(`${counter.sentDay}:${counter.sentToday}`);
      const { run, report } = await both();
      expect(counterChecks(report)).toEqual([]); // the trigger kept the counter right
      expect(run).toMatchObject({ executed: true, status: 'OK' }); // so the job agrees
    }
    // 16:59:59Z is still the 20th in Vietnam, 17:00:00Z already the 21st, and the 22nd resets it.
    expect(seen).toEqual([
      '2026-11-20:3000',
      '2026-11-21:5000',
      '2026-11-21:5700',
      '2026-11-22:40',
      '2026-11-22:42',
    ]);

    // Moving the counter to the day before the last debit is caught by both, on the same account.
    await q(`UPDATE public.accounts SET sent_day = DATE '2026-11-21' WHERE id = $1`, [
      refs.senderId,
    ]);
    const wrongDay = await both();
    expect(counterChecks(wrongDay.report)).toEqual([
      expect.objectContaining({ accountId: refs.senderId }),
    ]);
    expect(wrongDay.run).toMatchObject({ executed: true, status: 'MISMATCH' });
    await q(`UPDATE public.accounts SET sent_day = DATE '2026-11-22' WHERE id = $1`, [
      refs.senderId,
    ]);

    // A SYSTEM account has DEBIT lines but no counter: editing its counter is not a mismatch.
    const [system] = await q(`SELECT id FROM public.accounts WHERE type = 'SYSTEM'`);
    await q(
      `UPDATE public.accounts SET sent_today = 5, sent_day = DATE '2026-11-22' WHERE id = $1`,
      [system.id],
    );
    const afterSystemEdit = await both();
    expect(counterChecks(afterSystemEdit.report)).toEqual([]);
    expect(afterSystemEdit.run).toMatchObject({ executed: true, status: 'OK' });
  });
});
