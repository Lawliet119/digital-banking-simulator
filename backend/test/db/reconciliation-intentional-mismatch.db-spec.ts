import { parsePositiveMoney } from '@common/money';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { TransactionService } from '@database/transaction.service';
import { SystemClock } from '@common/clock';
import {
  ReconciliationService,
  type ReconciliationOutcome,
  type ClassifiedReconciliationRun,
} from '@modules/ledger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Target = Awaited<ReturnType<typeof seedDepositTarget>> & { token: string };

function assertExecuted(run: ReconciliationOutcome): asserts run is {
  executed: true;
  startedAt: Date;
  finishedAt: Date;
} & ClassifiedReconciliationRun {
  expect(run.executed).toBe(true);
  if (!run.executed) {
    throw new Error('Expected reconciliation run to be executed');
  }
}

/** Runs the tasks with at most `limit` in flight, keeping the order of the results. */
async function limited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }),
  );
  return results;
}

interface ReconciliationRunRecord {
  id: string;
  started_at: Date;
  finished_at: Date;
  status: string;
  total_debit: string | null;
  total_credit: string | null;
  total_balance: string | null;
  mismatched_accounts: number;
  details: unknown;
}

describe('DBS-118: intentional mismatch and concurrent transfers lifecycle', () => {
  let db: TempDatabase;
  let app: App;
  let operatorToken: string;
  let service: ReconciliationService;
  let userA: Target;
  let userB: Target;
  const otherUsers: Target[] = [];

  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  async function createCustomerTarget(initialDeposit = '0'): Promise<Target> {
    const row = await seedDepositTarget(db.runner);
    if (initialDeposit !== '0') {
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operatorToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: row.accountId, amount: initialDeposit })
        .expect(201);
    }
    const token = await app.issuer.token('customer', { sub: row.sub });
    return { ...row, token };
  }

  const sendTransfer = (from: Target, toAccountId: string, amount: string, key = randomUUID()) =>
    request(app.url)
      .post('/v1/transfers')
      .auth(from.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ fromAccountId: from.accountId, toAccountId, amount });

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });

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

    // 1. Initial setup: 2 customers, A funded 5,000,000 and transferred 1,500,000 to B
    userA = await createCustomerTarget('5000000');
    userB = await createCustomerTarget('0');
    await sendTransfer(userA, userB.accountId, '1500000').expect(201);
  });

  afterAll(async () => {
    await app?.close();
    if (db?.runner.isTransactionActive) {
      await db.runner.rollbackTransaction();
    }
    await db?.drop();
  });

  afterEach(async () => {
    // Repository invariant check after every test
    const report = await checkLedgerInvariants(db.runner);
    expect(report.status).toBe('PASS');
    expect(report.violations).toEqual([]);
  });

  it('TC-118-01 (DoD #1 & DoD #2): alters balance with table-owner role -> detects MISMATCH with exact details and 0 PII; restores balance -> next run OK', async () => {
    // Initial run: balanced ledger
    const initialRun = await service.reconcileOnce();
    expect(initialRun).toMatchObject({
      executed: true,
      status: 'OK',
      totalDebit: '6500000',
      totalCredit: '6500000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });

    // (a) Intentionally corrupt balance of userA (+100,000) using table-owner role
    await q('UPDATE public.accounts SET balance = balance + 100000 WHERE id = $1', [
      userA.accountId,
    ]);

    try {
      const mismatchRun = await service.reconcileOnce();
      assertExecuted(mismatchRun);
      expect(mismatchRun).toMatchObject({
        executed: true,
        status: 'MISMATCH',
        totalDebit: '6500000',
        totalCredit: '6500000',
        totalBalance: '100000',
        mismatchedAccounts: 1,
        details: [
          {
            accountId: userA.accountId,
            balance: '3600000',
            ledgerBalance: '3500000',
          },
        ],
      });

      // Verify zero PII in details
      const detail = mismatchRun.details![0];
      expect(Object.keys(detail).sort()).toEqual(['accountId', 'balance', 'ledgerBalance']);
      expect('name' in detail).toBe(false);
      expect('email' in detail).toBe(false);

      // Verify row persisted in public.reconciliation_runs
      const runs = (await q(
        'SELECT * FROM public.reconciliation_runs WHERE status = $1 ORDER BY id DESC LIMIT 1',
        ['MISMATCH'],
      )) as ReconciliationRunRecord[];
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('MISMATCH');
      expect(runs[0].total_balance).toBe('100000');
      expect(runs[0].mismatched_accounts).toBe(1);
    } finally {
      // (b) Restore balance back to exact ledger amount
      await q('UPDATE public.accounts SET balance = balance - 100000 WHERE id = $1', [
        userA.accountId,
      ]);
    }

    // Subsequent run must recover to OK
    const recoveredRun = await service.reconcileOnce();
    expect(recoveredRun).toMatchObject({
      executed: true,
      status: 'OK',
      totalDebit: '6500000',
      totalCredit: '6500000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });
  });

  it('TC-118-02 (DoD #3): runs after 50 concurrent cross transfers with a hot recipient on the same DB -> returns OK', async () => {
    // Create 3 additional customers: userC, userD, userE (total 5 customer pool)
    const userC = await createCustomerTarget('10000000');
    const userD = await createCustomerTarget('10000000');
    const userE = await createCustomerTarget('10000000');
    otherUsers.push(userC, userD, userE);

    // Also fund userA and userB with additional amounts for the concurrent transfer batch
    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operatorToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: userA.accountId, amount: '10000000' })
      .expect(201);

    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operatorToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: userB.accountId, amount: '5000000' })
      .expect(201);

    // userB (Thu Hà) acts as the HOT account receiving frequent transfers
    const hotAccount = userB;
    const senders = [userA, userC, userD, userE];

    // Build 50 concurrent transfer requests:
    // - 30 transfers to the hot account (userB)
    // - 20 cross transfers between senders
    const tasks: (() => Promise<number>)[] = [];
    for (let i = 0; i < 50; i++) {
      const sender = senders[i % senders.length];
      const targetId = i < 30 ? hotAccount.accountId : senders[(i + 1) % senders.length].accountId;
      const amount = `${10_000 + (i % 5) * 5_000}`; // 10,000 - 30,000 VND
      tasks.push(async () => {
        const res = await sendTransfer(sender, targetId, amount);
        return res.status;
      });
    }

    // Execute with limited 10 in-flight connections (respecting DB pool size)
    const statuses = await limited(tasks, 10);
    // All 50 transfers should succeed (201) because accounts are well-funded
    const completedCount = statuses.filter(s => s === 201).length;
    expect(completedCount).toBe(50);

    // Verify reconciliation on the same database after high concurrency
    const concurrentRun = await service.reconcileOnce();
    assertExecuted(concurrentRun);
    expect(concurrentRun.status).toBe('OK');
    expect(concurrentRun.totalDebit).toBe(concurrentRun.totalCredit);
    expect(concurrentRun.totalBalance).toBe('0');
    expect(concurrentRun.mismatchedAccounts).toBe(0);
    expect(concurrentRun.details).toEqual([]);

    // Check no negative customer balance exists
    const negativeAccounts = (await q(
      `SELECT id, balance::text FROM public.accounts WHERE type = 'CUSTOMER' AND balance < 0`,
    )) as { id: string; balance: string }[];
    expect(negativeAccounts).toHaveLength(0);
  });

  it('TC-118-03 (DoD #1 & DoD #3): alters hot account balance after concurrent load -> detects MISMATCH; restores -> OK', async () => {
    const hotAccount = userB;

    // Intentionally corrupt hot account balance (-50,000)
    await q('UPDATE public.accounts SET balance = balance - 50000 WHERE id = $1', [
      hotAccount.accountId,
    ]);

    try {
      const mismatchRun = await service.reconcileOnce();
      assertExecuted(mismatchRun);
      expect(mismatchRun.status).toBe('MISMATCH');
      expect(mismatchRun.totalBalance).toBe('-50000');
      expect(mismatchRun.mismatchedAccounts).toBe(1);
      expect(mismatchRun.details).toHaveLength(1);
      expect(mismatchRun.details![0].accountId).toBe(hotAccount.accountId);
      expect(
        BigInt(mismatchRun.details![0].ledgerBalance) - BigInt(mismatchRun.details![0].balance),
      ).toBe(50000n);
    } finally {
      // Restore hot account balance
      await q('UPDATE public.accounts SET balance = balance + 50000 WHERE id = $1', [
        hotAccount.accountId,
      ]);
    }

    // Must recover to OK
    const restoredRun = await service.reconcileOnce();
    expect(restoredRun).toMatchObject({
      executed: true,
      status: 'OK',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });
  });
});

describe('DBS-118: boundary case - large signed integer precision', () => {
  let db: TempDatabase;
  let app: App;
  let operatorToken: string;
  let service: ReconciliationService;
  let userA: Target;
  let userB: Target;

  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operatorToken = await app.issuer.token('operator', { sub: randomUUID() });

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

    const rowA = await seedDepositTarget(db.runner);
    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operatorToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: rowA.accountId, amount: '5000000' })
      .expect(201);
    userA = { ...rowA, token: await app.issuer.token('customer', { sub: rowA.sub }) };

    const rowB = await seedDepositTarget(db.runner);
    userB = { ...rowB, token: await app.issuer.token('customer', { sub: rowB.sub }) };

    await request(app.url)
      .post('/v1/transfers')
      .auth(userA.token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ fromAccountId: userA.accountId, toAccountId: userB.accountId, amount: '1500000' })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    if (db?.runner.isTransactionActive) {
      await db.runner.rollbackTransaction();
    }
    await db?.drop();
  });

  afterEach(async () => {
    const report = await checkLedgerInvariants(db.runner);
    expect(report.status).toBe('PASS');
    expect(report.violations).toEqual([]);
  });

  it('TC-118-04 (DoD #1, DoD #2 & Boundary): alters multiple accounts including funding beyond 2^53 -> preserves 64-bit precision in details; restores -> OK', async () => {
    const fundingRow = (await q(`SELECT id FROM public.accounts WHERE type = 'SYSTEM'`)) as {
      id: string;
    }[];
    expect(fundingRow).toHaveLength(1);
    const fundingId = fundingRow[0].id;

    // Alter both userB (-200,000) and funding (-9007199254740993 > 2^53)
    const largeDelta = '9007199254740993'; // 2^53 + 1
    await q('UPDATE public.accounts SET balance = balance - 200000 WHERE id = $1', [
      userB.accountId,
    ]);
    await q(`UPDATE public.accounts SET balance = balance - ${largeDelta} WHERE id = $1`, [
      fundingId,
    ]);

    try {
      const mismatchRun = await service.reconcileOnce();
      assertExecuted(mismatchRun);
      expect(mismatchRun.status).toBe('MISMATCH');
      expect(mismatchRun.mismatchedAccounts).toBe(2);
      expect(mismatchRun.details).toHaveLength(2);

      // Verify sorting by accountId ASC
      const [d1, d2] = mismatchRun.details!;
      expect(d1.accountId.localeCompare(d2.accountId)).toBeLessThan(0);

      // Locate funding detail and verify 64-bit precision preservation
      const fundingDetail = mismatchRun.details!.find(d => d.accountId === fundingId);
      expect(fundingDetail).toBeDefined();
      expect(typeof fundingDetail!.balance).toBe('string');
      expect(typeof fundingDetail!.ledgerBalance).toBe('string');
      // ledgerBalance was -5,000,000; altered by -9,007,199,254,740,993 -> balance must be exactly -9,007,199,259,740,993
      expect(fundingDetail!.balance).toBe('-9007199259740993');
      expect(fundingDetail!.ledgerBalance).toBe('-5000000');
    } finally {
      // Restore both accounts
      await q('UPDATE public.accounts SET balance = balance + 200000 WHERE id = $1', [
        userB.accountId,
      ]);
      await q(`UPDATE public.accounts SET balance = balance + ${largeDelta} WHERE id = $1`, [
        fundingId,
      ]);
    }

    // Restored run must be OK
    const restoredRun = await service.reconcileOnce();
    expect(restoredRun).toMatchObject({
      executed: true,
      status: 'OK',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });
  });
});
