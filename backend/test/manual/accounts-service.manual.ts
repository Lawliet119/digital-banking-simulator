import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Module, HttpException, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AccountBalanceNegativeError,
  AccountBalanceOverflowError,
  AccountNotLockedError,
  AccountsModule,
  AccountsService,
} from '@modules/accounts';
import { safeErrorMetadata } from '@common/logging/logging.options';
import {
  ACCOUNT_FIXTURE as f,
  assertAccountsInvariants,
  createAccountsFixture,
  proveAccountLockOrder,
  proveCrossedAccountLocks,
  proveUpdatedAtFollowsCommitOrder,
  withMoneyProbe,
  type AccountsFixture,
} from '../support/accounts-service-probe';

@Module({})
class AccountsManualModule {}

function report(step: string, result: unknown): void {
  console.log(`${step} ${JSON.stringify(result)}`);
}

function assertCleanupSucceeded(results: PromiseSettledResult<unknown>[]): void {
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

async function expectRejection(
  step: string,
  work: () => Promise<unknown>,
  expected: {
    status?: number;
    code?: string;
    constraint?: string;
    type?: new (...args: never[]) => Error;
    message?: RegExp;
  },
): Promise<void> {
  let rejected = false;
  let caught: unknown;
  try {
    await work();
  } catch (error) {
    rejected = true;
    caught = error;
  }
  assert(rejected, 'The rejection probe unexpectedly succeeded');
  if (expected.type) assert(caught instanceof expected.type);
  if (expected.message) assert.match((caught as Error).message, expected.message);
  if (expected.status !== undefined) {
    assert(caught instanceof HttpException);
    assert.equal(caught.getStatus(), expected.status);
  }
  // Typed account errors keep the driver failure as `cause`; raw driver errors carry it directly.
  const outer = caught as Record<string, unknown>;
  const record = (outer.cause ?? outer) as Record<string, unknown>;
  if (expected.code !== undefined) assert.equal(record.code, expected.code);
  if (expected.constraint !== undefined) assert.equal(record.constraint, expected.constraint);
  report(step, {
    name: caught instanceof Error ? caught.name : typeof caught,
    ...safeErrorMetadata(caught),
    ...(caught instanceof HttpException ? { status: caught.getStatus() } : {}),
    ...(expected.constraint !== undefined ? { constraint: record.constraint } : {}),
  });
}

async function main(): Promise<void> {
  // This assertion also permits a failure/exit check before a database is touched.
  assert.equal(process.argv[2] ?? 'all', 'all', 'Only the all manual mode is supported');
  let fixture: AccountsFixture | undefined;
  let context: INestApplicationContext | undefined;
  let failed = false;
  try {
    fixture = await createAccountsFixture();
    const source = fixture.source;
    context = await NestFactory.createApplicationContext(
      {
        module: AccountsManualModule,
        imports: [
          TypeOrmModule.forRoot({ ...source.options, synchronize: false, migrationsRun: false }),
          AccountsModule,
        ],
      },
      // Reject initialization failures so our fixture cleanup runs instead of Nest exiting early.
      { logger: false, abortOnError: false },
    );
    const accounts = context.get(AccountsService);

    const owned = await accounts.getOwnedAccount(f.accountA, f.userA);
    assert.equal(owned.balance, '0');
    report('M-55-01 OWNED', owned);
    await expectRejection('M-55-01 FOREIGN', () => accounts.getOwnedAccount(f.accountA, f.userB), {
      status: 404,
    });
    await expectRejection('M-55-01 MISSING', () => accounts.getOwnedAccount(f.missing, f.userA), {
      status: 404,
    });
    await expectRejection('M-55-01 SYSTEM', () => accounts.getOwnedAccount(f.funding, f.userA), {
      status: 404,
    });
    await expectRejection(
      'M-55-01 COGNITO_SUB_IS_NOT_USER_ID',
      () => accounts.getOwnedAccount(f.accountA, f.cognitoSubA),
      { status: 404 },
    );

    report('M-55-02 LOCK_ORDER', await proveAccountLockOrder(source, accounts));
    report('M-55-02 CROSSED_LOCKS', await proveCrossedAccountLocks(source, accounts));

    for (const amount of [300000n, 9007199254740993n]) {
      await withMoneyProbe(source, async manager => {
        await accounts.lockForUpdate([f.accountA, f.funding], manager);
        await accounts.applyBalanceChange(f.funding, -amount, manager);
        await accounts.applyBalanceChange(f.accountA, amount, manager);
        const snapshots = await accounts.lockForUpdate([f.funding, f.accountA], manager);
        assert.deepEqual(
          snapshots.map(row => row.balance),
          [(-amount).toString(), amount.toString()],
        );
        const outside = await source.query<{ id: string; balance: string }[]>(
          'SELECT id,balance FROM accounts ORDER BY id',
        );
        assert(outside.every(row => row.balance === '0'));
        assert.equal((await accounts.getOwnedAccount(f.accountA, f.userA)).balance, '0');
        report('M-55-03 TENTATIVE_SNAPSHOTS', snapshots);
        report('M-55-03 COMMITTED_OBSERVER', outside);
      });
      const after = await source.query<{ id: string; balance: string }[]>(
        'SELECT id,balance FROM accounts ORDER BY id',
      );
      assert(after.every(row => row.balance === '0'));
      report('M-55-03 AFTER_ROLLBACK', after);
    }

    await expectRejection(
      'M-55-04 CUSTOMER_NEGATIVE',
      () =>
        withMoneyProbe(source, async manager => {
          await accounts.lockForUpdate([f.accountA], manager);
          await accounts.applyBalanceChange(f.accountA, -1n, manager);
        }),
      {
        type: AccountBalanceNegativeError,
        code: '23514',
        constraint: 'accounts_balance_non_negative',
      },
    );
    await expectRejection(
      'M-55-04 OVERFLOW',
      () =>
        withMoneyProbe(source, async manager => {
          await accounts.lockForUpdate([f.funding, f.accountA], manager);
          await accounts.applyBalanceChange(f.funding, -9223372036854775807n, manager);
          await accounts.applyBalanceChange(f.accountA, 9223372036854775807n, manager);
          await accounts.applyBalanceChange(f.accountA, 1n, manager);
        }),
      { type: AccountBalanceOverflowError, code: '22003' },
    );
    await expectRejection(
      'M-55-04 INACTIVE_MANAGER',
      () => accounts.applyBalanceChange(f.accountA, 0n, source.manager),
      { type: Error },
    );
    await expectRejection(
      'M-55-04 HOSTILE_ID',
      () => withMoneyProbe(source, manager => accounts.lockForUpdate(["' OR 1=1 --"], manager)),
      { type: TypeError },
    );
    await expectRejection(
      'M-55-04 SPARSE_IDS',
      () =>
        withMoneyProbe(source, manager => accounts.lockForUpdate(Array(1) as string[], manager)),
      { type: TypeError },
    );
    await expectRejection(
      'M-55-04 NUMBER_DELTA',
      () =>
        withMoneyProbe(source, manager =>
          accounts.applyBalanceChange(f.accountA, 300000 as unknown as bigint, manager),
        ),
      { type: TypeError },
    );
    await expectRejection(
      'M-55-07 APPLY_WITHOUT_LOCK',
      () => withMoneyProbe(source, manager => accounts.applyBalanceChange(f.accountA, 0n, manager)),
      { type: AccountNotLockedError },
    );
    await expectRejection(
      'M-55-07 LOCK_ON_OTHER_RUNNER',
      () =>
        withMoneyProbe(source, async manager => {
          await withMoneyProbe(source, other => accounts.lockForUpdate([f.accountA], other));
          await accounts.applyBalanceChange(f.accountA, 0n, manager);
        }),
      { type: AccountNotLockedError },
    );
    await expectRejection(
      'M-55-07 NESTED_TRANSACTION',
      () =>
        withMoneyProbe(source, manager =>
          manager.transaction(nested => accounts.lockForUpdate([f.accountA], nested)),
        ),
      { type: Error, message: /outermost transaction/ },
    );
    await expectRejection(
      'M-55-07 SEVENTEEN_IDS',
      () =>
        withMoneyProbe(source, manager =>
          accounts.lockForUpdate(
            Array.from(
              { length: 17 },
              (_, n) => `ffffffff-ffff-4fff-8fff-${n.toString(16).padStart(12, '0')}`,
            ),
            manager,
          ),
        ),
      { type: TypeError, message: /At most 16 account ids/ },
    );

    const order = await proveUpdatedAtFollowsCommitOrder(source, accounts);
    assert(order.earlyStamp.getTime() > order.lateStamp.getTime());
    report('M-55-08 UPDATED_AT_ORDER', {
      earlyTxPid: order.earlyPid,
      waitedBehindPid: order.latePid,
      lateCommitStamp: order.lateStamp.toISOString(),
      earlyCommitStamp: order.earlyStamp.toISOString(),
      earlyAfterLate: true,
    });

    const recovered = await accounts.getOwnedAccount(f.accountA, f.userA);
    assert.equal(recovered.balance, '0');
    report('M-55-04 RECOVERED', { accountId: recovered.id, balance: recovered.balance });

    await assertAccountsInvariants(source);
    report('M-55-05 POST_ROLLBACK_CHECKS', {
      entriesEqual: true,
      totalZero: true,
      customersNonnegative: true,
      balancesMatchEntries: true,
      scope: 'zero-balance fixture after rollback; no double-entry claim for tentative changes',
    });
    report('M-55-06 PENDING', {
      status: 'chưa chạy',
      dependencies: ['DBS-60', 'DBS-61', 'AuditService'],
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const appClosed = context ? await Promise.allSettled([context.close()]) : [];
    const fixtureClosed = fixture ? await Promise.allSettled([fixture.close()]) : [];
    if (!failed) assertCleanupSucceeded([...appClosed, ...fixtureClosed]);
  }
}

void main().catch((error: unknown) => {
  console.error('DBS-55 manual failed', JSON.stringify(safeErrorMetadata(error)));
  process.exitCode = 1;
});
