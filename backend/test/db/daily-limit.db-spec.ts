import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Clock } from '@common/clock';
import { parsePositiveMoney } from '@common/money';
import { TransactionService } from '@database/transaction.service';
import { AccountsService } from '@modules/accounts';
import { SENT_TODAY_SQL, SyncGuardService } from '@modules/ledger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { loadDailyDebitLedger, planNodes } from '../support/daily-debit-fixture';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Row = Awaited<ReturnType<typeof seedDepositTarget>>;

describe('DBS-84 daily limit: index-only scan, clock read after the lock, only debits count', () => {
  let db: TempDatabase, app: App, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const tx = () => app.app.get(TransactionService, { strict: false });
  const accounts = () => app.app.get(AccountsService, { strict: false });
  const guard = () => app.app.get(SyncGuardService, { strict: false });
  const clock = () => app.app.get(Clock, { strict: false });
  const DAY_MS = 86_400_000;

  const deposit = (to: string, amount: string) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: to, amount })
      .expect(201);
  const send = async (from: Row, to: string, amount: string) =>
    request(app.url)
      .post('/v1/transfers')
      .auth(await app.issuer.token('customer', { sub: from.sub }), { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ fromAccountId: from.accountId, toAccountId: to, amount });

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-84-03 sums the DEBIT lines since Vietnam midnight of the clock; credits do not count', async () => {
    const source = await seedDepositTarget(db.runner),
      sink = await seedDepositTarget(db.runner);
    // Three deposits of 100,000,000 are CREDIT lines of the source: 300,000,000, above the day limit.
    for (let i = 0; i < 3; i++) await deposit(source.accountId, '100000000');
    expect((await send(source, sink.accountId, '50000000')).status).toBe(201);
    app.limits.transfer.perTx = 100_000_000n;
    app.limits.transfer.perDay = 100_000_000n;
    try {
      const ask = (amount: string) =>
        tx().run(async manager => {
          const locked = await accounts().lockForUpdate(
            [source.accountId, sink.accountId],
            manager,
          );
          return guard().checkGuards(
            manager,
            locked.find(a => a.id === source.accountId)!,
            locked.find(a => a.id === sink.accountId),
            parsePositiveMoney(amount),
          );
        });
      // 50,000,000 sent today; the credits are not added, so 50,000,000 more fits ...
      expect(await ask('50000000')).toBeNull();
      // ... and one dong more does not.
      expect(await ask('50000001')).toBe('LIMIT_PER_DAY_EXCEEDED');
      // The guard uses the Clock it is given: one day later today's debit is in the past.
      jest.spyOn(clock(), 'now').mockReturnValue(new Date(Date.now() + DAY_MS));
      expect(await ask('100000000')).toBeNull();
      jest.restoreAllMocks();
      // The query itself: DEBIT only, from Vietnam midnight of the instant it is given.
      const sum = async (now: Date) =>
        BigInt((await q(SENT_TODAY_SQL, [source.accountId, now.toISOString()]))[0].total);
      expect(await sum(new Date())).toBe(50_000_000n);
      expect(await sum(new Date(Date.now() + DAY_MS))).toBe(0n);
    } finally {
      Object.assign(app.limits.transfer, { perTx: 50_000_000n, perDay: 200_000_000n });
    }
  });

  it('TC-84-04 reads the clock after the accounts are locked', async () => {
    const source = await seedDepositTarget(db.runner),
      sink = await seedDepositTarget(db.runner);
    await deposit(source.accountId, '1000000');
    const lock = jest.spyOn(accounts(), 'lockForUpdate');
    const now = jest.spyOn(clock(), 'now');
    expect((await send(source, sink.accountId, '1000')).status).toBe(201);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(1);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(now.mock.invocationCallOrder[0]);
  });

  it('TC-84-01 the daily query is an index-only scan on a ledger of 200,000 lines', async () => {
    await db.runner.startTransaction();
    const { hotAccountId } = await loadDailyDebitLedger(db.runner, {
      hotRows: 100_000,
      noiseRows: 100_000,
      noiseAccounts: 500,
      todayRows: 20,
      spanDays: 730,
    });
    await db.runner.commitTransaction();
    // The plan depends on statistics, as it does in production after autovacuum.
    await q('VACUUM (ANALYZE) ledger_entries');
    const [{ 'QUERY PLAN': explain }] = await q(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SENT_TODAY_SQL}`,
      [hotAccountId, new Date().toISOString()],
    );
    const nodes = planNodes(explain[0]);
    const kinds = nodes.map(n => n['Node Type']);
    expect(kinds).not.toContain('Seq Scan');
    expect(kinds).not.toContain('Bitmap Heap Scan');
    const scan = nodes.find(n => n['Node Type'] === 'Index Only Scan');
    expect(scan).toBeDefined();
    expect(scan!['Index Name']).toBe('ledger_entries_daily_debit_idx');
    // The day boundary is an index condition: the scan does not read the account's older lines.
    expect(String(scan!['Index Cond'])).toMatch(/created_at >=/);
    expect(scan!['Heap Fetches']).toBe(0);
  }, 120_000);
});
