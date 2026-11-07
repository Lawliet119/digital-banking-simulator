import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { TransactionService } from '@database/transaction.service';
import { AccountNotLockedError, AccountsService } from '@modules/accounts';
import { SyncGuardService } from '@modules/ledger';
import { parsePositiveMoney } from '@common/money';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Row = Awaited<ReturnType<typeof seedDepositTarget>>;
type Reason = string | null;

/**
 * `checkGuards` is called inside a real transaction that really locked the accounts, on rows whose
 * balance and "already sent today" come from the deposit and transfer APIs. The limits are lowered
 * so that one small number can break several rules at once: per transfer 1000, per day 1500.
 */
describe('DBS-82 synchronous guard: reasons, order and the lock it depends on', () => {
  let db: TempDatabase, app: App, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const tx = () => app.app.get(TransactionService, { strict: false });
  const accounts = () => app.app.get(AccountsService, { strict: false });
  const guard = () => app.app.get(SyncGuardService, { strict: false });
  const customerToken = (row: Row) => app.issuer.token('customer', { sub: row.sub });
  const defaults = { perTx: 0n, perDay: 0n };

  const deposit = (to: string, amount: string) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: to, amount })
      .expect(201);

  interface Case {
    name: string;
    source?: 'ACTIVE' | 'LOCKED';
    target?: 'ACTIVE' | 'LOCKED' | 'NONE';
    balance: number;
    sentToday?: number;
    amount: number;
    expected: Reason;
  }
  /** Builds the two accounts for a case and asks the guard inside a locking transaction. */
  async function ask(c: Case): Promise<Reason> {
    const source = await seedDepositTarget(db.runner),
      target = await seedDepositTarget(db.runner, c.target === 'LOCKED' ? 'LOCKED' : 'ACTIVE');
    const sent = c.sentToday ?? 0;
    if (c.balance + sent > 0) await deposit(source.accountId, String(c.balance + sent));
    if (sent > 0) {
      const sink = await seedDepositTarget(db.runner);
      await request(app.url)
        .post('/v1/transfers')
        .auth(await customerToken(source), { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({
          fromAccountId: source.accountId,
          toAccountId: sink.accountId,
          amount: String(sent),
        })
        .expect(201);
    }
    // SQL INPUT: the status of the source (money could not be deposited into a LOCKED account).
    if (c.source === 'LOCKED')
      await q("UPDATE accounts SET status='LOCKED' WHERE id=$1", [source.accountId]);
    return tx().run(async manager => {
      const ids = [source.accountId, ...(c.target === 'NONE' ? [] : [target.accountId])];
      const locked = await accounts().lockForUpdate(ids, manager);
      return guard().checkGuards(
        manager,
        locked.find(a => a.id === source.accountId)!,
        locked.find(a => a.id === target.accountId),
        parsePositiveMoney(String(c.amount)),
      );
    });
  }
  const EVERYTHING_ELSE_WRONG = { balance: 500, sentToday: 1000, amount: 2000 };

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
    defaults.perTx = app.limits.transfer.perTx;
    defaults.perDay = app.limits.transfer.perDay;
  });
  beforeEach(() => {
    app.limits.transfer.perTx = 1000n;
    app.limits.transfer.perDay = 1500n;
  });
  afterEach(async () => {
    Object.assign(app.limits.transfer, defaults);
    const result = await checkLedgerInvariants(db.runner);
    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  const N = 'ACCOUNT_NOT_ACTIVE',
    TX = 'LIMIT_PER_TX_EXCEEDED',
    DAY = 'LIMIT_PER_DAY_EXCEEDED',
    FUNDS = 'INSUFFICIENT_FUNDS';
  const table: [string, Case][] = [
    // TC-82-01 account state wins over everything, including a destination that does not exist
    [
      'TC-82-01',
      { name: 'source LOCKED', source: 'LOCKED', ...EVERYTHING_ELSE_WRONG, expected: N },
    ],
    [
      'TC-82-01',
      { name: 'target LOCKED', target: 'LOCKED', ...EVERYTHING_ELSE_WRONG, expected: N },
    ],
    [
      'TC-82-01',
      { name: 'target does not exist', target: 'NONE', ...EVERYTHING_ELSE_WRONG, expected: N },
    ],
    // TC-82-02 per-transfer limit, then its boundary
    [
      'TC-82-02',
      {
        name: 'perTx + 1 (also over the day, short of money)',
        balance: 500,
        amount: 1001,
        expected: TX,
      },
    ],
    [
      'TC-82-02',
      {
        name: 'exactly perTx passes this step (then short of money)',
        balance: 500,
        amount: 1000,
        expected: FUNDS,
      },
    ],
    // TC-82-03 per-day limit, then its boundary
    [
      'TC-82-03',
      {
        name: 'sent 1000 + 501 > 1500 (also short of money)',
        balance: 500,
        sentToday: 1000,
        amount: 501,
        expected: DAY,
      },
    ],
    [
      'TC-82-03',
      {
        name: 'sent 1000 + 500 == 1500 passes and 500 is affordable',
        balance: 500,
        sentToday: 1000,
        amount: 500,
        expected: null,
      },
    ],
    // TC-82-04 funds, then its boundary
    [
      'TC-82-04',
      { name: 'one dong more than the balance', balance: 500, amount: 501, expected: FUNDS },
    ],
    ['TC-82-04', { name: 'exactly the balance', balance: 500, amount: 500, expected: null }],
    // TC-82-05 order when several reasons hold at once
    ['TC-82-05', { name: 'TX before DAY before FUNDS', ...EVERYTHING_ELSE_WRONG, expected: TX }],
    [
      'TC-82-05',
      { name: 'DAY before FUNDS', balance: 500, sentToday: 1000, amount: 900, expected: DAY },
    ],
    ['TC-82-05', { name: 'FUNDS last', balance: 300, amount: 400, expected: FUNDS }],
    ['TC-82-05', { name: 'nothing wrong', balance: 400, amount: 400, expected: null }],
  ];
  it.each(table)('%s %s', async (_id, c) => {
    expect(await ask(c)).toBe(c.expected);
  });

  it('TC-82-08 reads the limits when it is called, so a new limit changes the answer', async () => {
    const c: Case = { name: 'x', balance: 5000, amount: 1500, expected: TX };
    expect(await ask(c)).toBe(TX);
    app.limits.transfer.perTx = 2000n;
    expect(await ask(c)).toBeNull();
    app.limits.transfer.perDay = 1000n; // now the day limit is the smaller one
    expect(await ask(c)).toBe(DAY);
  });

  describe('it refuses to answer for accounts this transaction has not locked (AC-5.6 depends on it)', () => {
    async function pair() {
      const from = await seedDepositTarget(db.runner),
        to = await seedDepositTarget(db.runner);
      await deposit(from.accountId, '900');
      return { from, to };
    }
    it('TC-82-06 neither account locked, even with snapshots from an earlier transaction', async () => {
      const { from, to } = await pair();
      const stale = await tx().run(m =>
        accounts().lockForUpdate([from.accountId, to.accountId], m),
      );
      await expect(
        tx().run(m => guard().checkGuards(m, stale[0], stale[1], parsePositiveMoney('100'))),
      ).rejects.toBeInstanceOf(AccountNotLockedError);
    });
    it('TC-82-06 only the source locked', async () => {
      const { from, to } = await pair();
      const [theirs] = await tx().run(m => accounts().lockForUpdate([to.accountId], m));
      await expect(
        tx().run(async m => {
          const [source] = await accounts().lockForUpdate([from.accountId], m);
          return guard().checkGuards(m, source, theirs, parsePositiveMoney('100'));
        }),
      ).rejects.toBeInstanceOf(AccountNotLockedError);
    });
    it('TC-82-06 outside any transaction', async () => {
      const { from, to } = await pair();
      const locked = await tx().run(m =>
        accounts().lockForUpdate([from.accountId, to.accountId], m),
      );
      await expect(
        guard().checkGuards(app.source.manager, locked[0], locked[1], parsePositiveMoney('100')),
      ).rejects.toThrow('An active caller transaction is required');
    });
  });

  describe('AccountsService.assertLocked', () => {
    it('TC-82-11 passes for accounts this transaction locked and throws for the others', async () => {
      const locked = await seedDepositTarget(db.runner),
        other = await seedDepositTarget(db.runner);
      await tx().run(async manager => {
        await accounts().lockForUpdate([locked.accountId], manager);
        expect(() => accounts().assertLocked([locked.accountId], manager)).not.toThrow();
        expect(() =>
          accounts().assertLocked([locked.accountId.toUpperCase()], manager),
        ).not.toThrow();
        expect(() => accounts().assertLocked([locked.accountId, other.accountId], manager)).toThrow(
          AccountNotLockedError,
        );
        expect(() => accounts().assertLocked([randomUUID()], manager)).toThrow(
          AccountNotLockedError,
        );
      });
      // A lock taken by an earlier transaction does not carry over to a new one.
      await tx().run(manager => {
        expect(() => accounts().assertLocked([locked.accountId], manager)).toThrow(
          AccountNotLockedError,
        );
        return Promise.resolve();
      });
    });
  });
});
