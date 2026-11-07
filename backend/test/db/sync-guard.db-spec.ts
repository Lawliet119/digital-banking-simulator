import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { TransactionService } from '@database/transaction.service';
import { AccountNotLockedError, AccountsService } from '@modules/accounts';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Target = Awaited<ReturnType<typeof seedDepositTarget>> & { token: string };

describe('DBS-82 synchronous guard: reasons, order and the lock it depends on', () => {
  let db: TempDatabase, app: App, operator: string;
  const tx = () => app.app.get(TransactionService, { strict: false });
  const accounts = () => app.app.get(AccountsService, { strict: false });

  /** An ACTIVE or LOCKED account; money only ever arrives through the operator deposit API. */
  async function account(amount = '0', status: 'ACTIVE' | 'LOCKED' = 'ACTIVE'): Promise<Target> {
    const row = await seedDepositTarget(db.runner, status);
    if (amount !== '0' && status === 'ACTIVE')
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operator, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: row.accountId, amount })
        .expect(201);
    return { ...row, token: await app.issuer.token('customer', { sub: row.sub }) };
  }

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterEach(async () => {
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

  describe('AccountsService.assertLocked', () => {
    it('TC-82-11 passes for accounts this transaction locked and throws for the others', async () => {
      const locked = await account('1000'),
        other = await account('1000');
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
