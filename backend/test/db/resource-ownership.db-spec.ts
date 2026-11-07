import { randomUUID } from 'node:crypto';
import { HttpException, NotFoundException } from '@nestjs/common';
import { AccountsService, type AccountOwnershipContext } from '@modules/accounts';
import { AuditReason, AuditService } from '@modules/audit';
import { TransactionService } from '@database/transaction.service';
import { getErrorCode } from '@common/utils/pg-error.util';
import { ACCOUNT_FIXTURE as f } from '../support/accounts-service-probe';
import {
  accountLookups,
  createOwnershipFixture,
  createOwnershipRole,
  ownershipAuditRows,
  ownershipContext,
  ownershipInvariants,
  ownershipProblem,
  proveOwnershipSnapshot,
  rejected,
  type OwnershipFixture,
} from '../support/resource-ownership-probe';

describe('DBS-86 service ownership on real PostgreSQL', () => {
  let fixture: OwnershipFixture;

  beforeAll(async () => {
    fixture = await createOwnershipFixture();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  afterEach(async () => {
    expect(await ownershipInvariants(fixture.observer)).toMatchObject({
      status: 'PASS',
      violations: [],
      totals: { debit: '0', credit: '0', balance: '0' },
    });
    const [{ transfers, entries }] = await fixture.observer.query<
      { transfers: string; entries: string }[]
    >(`SELECT (SELECT count(*) FROM transfers) AS transfers,
       (SELECT count(*) FROM ledger_entries) AS entries`);
    expect({ transfers, entries }).toEqual({ transfers: '0', entries: '0' });
  });

  it('TC-86-01 returns owned ACTIVE and LOCKED snapshots without writing audit', async () => {
    for (const [id, userId, status] of [
      [f.accountA, f.userA, 'ACTIVE'],
      [f.accountB, f.userB, 'LOCKED'],
    ]) {
      const context = ownershipContext({ userId });
      const account = await fixture.accounts.getOwnedAccount(id, context);
      expect(account).toMatchObject({ id, userId, status, balance: '0' });
      expect(account.createdAt).toBeInstanceOf(Date);
      expect(account.updatedAt).toBeInstanceOf(Date);
      expect(Object.keys(account).sort()).toEqual([
        'balance',
        'createdAt',
        'customerId',
        'id',
        'status',
        'type',
        'updatedAt',
        'userId',
      ]);
      expect(await ownershipAuditRows(fixture.observer, context.correlationId)).toEqual([]);
    }
  });

  it('TC-86-02 commits exactly one attributed DENIED before returning the foreign-account 404', async () => {
    const context = ownershipContext();
    const error = await rejected(fixture.accounts.getOwnedAccount(f.accountB, context));
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as HttpException).getStatus()).toBe(404);
    const rows = await ownershipAuditRows(fixture.observer, context.correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: expect.stringMatching(/^\d+$/),
      actor: f.userA,
      role: 'customer',
      action: 'account.read',
      outcome: 'DENIED',
      targetType: 'account',
      targetId: f.accountB,
      correlationId: context.correlationId,
      metadata: { reason: AuditReason.NOT_OWNER },
    });
  });

  it('TC-86-03 foreign, absent and SYSTEM accounts have identical safe raw and formatted 404s', async () => {
    const responses: unknown[] = [];
    const problems: unknown[] = [];
    for (const id of [f.accountB, f.missing, f.funding]) {
      const context = ownershipContext();
      const error = await rejected(fixture.accounts.getOwnedAccount(id, context));
      expect(error).toBeInstanceOf(NotFoundException);
      responses.push((error as HttpException).getResponse());
      const problem = ownershipProblem(error, context.correlationId);
      expect(problem.status).toBe(404);
      expect(problem.correlationId).toBe(context.correlationId);
      expect(problem.errorCode).toBeUndefined();
      const { correlationId: _correlationId, ...safe } = problem;
      problems.push(safe);
      expect(await ownershipAuditRows(fixture.observer, context.correlationId)).toHaveLength(1);
    }
    expect(responses).toEqual([responses[0], responses[0], responses[0]]);
    expect(problems).toEqual([problems[0], problems[0], problems[0]]);
    expect(JSON.stringify(problems)).not.toMatch(
      /3b000000|10000000|Trần|Nguyễn|balance|customer|SELECT|fraud/,
    );
  });

  it.each([
    null,
    undefined,
    '',
    'an@example.invalid',
    "' OR 1=1 --",
    'x'.repeat(1024),
    'not-uuid',
    `${f.accountA}\n`,
  ])(
    'TC-86-04 malformed resource %p does not SELECT accounts and audits only the sentinel',
    async id => {
      const context = ownershipContext();
      const begin = fixture.trace.length;
      const error = await rejected(
        fixture.accounts.getOwnedAccount(id as unknown as string, context),
      );
      expect(error).toBeInstanceOf(NotFoundException);
      expect(accountLookups(fixture.trace.slice(begin))).toEqual([]);
      const rows = await ownershipAuditRows(fixture.observer, context.correlationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: f.userA,
        targetId: 'invalid',
        outcome: 'DENIED',
        metadata: { reason: AuditReason.NOT_OWNER },
      });
      expect(ownershipProblem(error, context.correlationId)).toMatchObject({ status: 404 });
      if (typeof id === 'string' && id.length > 0) {
        expect(JSON.stringify(rows)).not.toContain(id);
        expect(JSON.stringify((error as HttpException).getResponse())).not.toContain(id);
      }
    },
  );

  it('TC-86-05 normalizes valid account, actor and correlation UUIDs once', async () => {
    const context = ownershipContext({
      userId: f.userA.toUpperCase(),
      correlationId: 'ABCDEF00-0000-4000-8000-000000000001',
      action: 'account.transactions',
    });
    expect((await fixture.accounts.getOwnedAccount(f.accountA.toUpperCase(), context)).id).toBe(
      f.accountA,
    );
    const begin = fixture.trace.length;
    const error = await rejected(
      fixture.accounts.getOwnedAccount(f.accountB.toUpperCase(), context),
    );
    expect(error).toBeInstanceOf(NotFoundException);
    const [query] = accountLookups(fixture.trace.slice(begin));
    expect(query.parameters).toEqual([f.accountB, f.userA]);
    const [row] = await ownershipAuditRows(fixture.observer, context.correlationId);
    expect(row).toMatchObject({
      actor: f.userA,
      targetId: f.accountB,
      correlationId: context.correlationId.toLowerCase(),
      action: 'account.transactions',
    });
  });

  it('TC-86-06 the committed denial survives a later independent scratch rollback', async () => {
    const context = ownershipContext({ action: 'ledger.transfer' });
    expect(await rejected(fixture.accounts.getOwnedAccount(f.accountB, context))).toBeInstanceOf(
      NotFoundException,
    );
    const rollback = new Error('Expected scratch rollback');
    expect(
      await rejected(
        fixture.tx.run(async manager => {
          await manager.query('INSERT INTO ownership_scratch(id) VALUES($1)', [
            context.correlationId,
          ]);
          throw rollback;
        }),
      ),
    ).toBe(rollback);
    expect(
      await fixture.observer.query('SELECT id FROM ownership_scratch WHERE id=$1', [
        context.correlationId,
      ]),
    ).toEqual([]);
    expect(await ownershipAuditRows(fixture.observer, context.correlationId)).toHaveLength(1);
  });

  it('TC-86-07 real INSERT refusal fails closed; granting INSERT recovers to 404 and one denial', async () => {
    const role = await createOwnershipRole(fixture);
    try {
      const blocked = ownershipContext();
      expect((await role.accounts.getOwnedAccount(f.accountA, blocked)).balance).toBe('0');
      const failure = await rejected(role.accounts.getOwnedAccount(f.accountB, blocked));
      expect(getErrorCode(failure)).toBe('42501');
      expect(failure).not.toBeInstanceOf(HttpException);
      expect(await ownershipAuditRows(fixture.observer, blocked.correlationId)).toEqual([]);
      await role.grantAuditInsert();
      const recovered = ownershipContext();
      expect(await rejected(role.accounts.getOwnedAccount(f.accountB, recovered))).toBeInstanceOf(
        NotFoundException,
      );
      expect(await ownershipAuditRows(fixture.observer, recovered.correlationId)).toHaveLength(1);
      expect(await ownershipAuditRows(fixture.observer, blocked.correlationId)).toEqual([]);
    } finally {
      await role.close();
    }
  });

  it.each([
    undefined,
    null,
    f.userA,
    {},
    ownershipContext({ userId: '' }),
    ownershipContext({ userId: 'an@example.invalid' }),
    ownershipContext({ userId: `${f.userA}\n` }),
    ownershipContext({ correlationId: 'client-header-not-uuid' }),
    ownershipContext({ correlationId: `${randomUUID()}\n` }),
    { ...ownershipContext(), role: 'admin' },
    { ...ownershipContext(), role: 'operator' },
    { ...ownershipContext(), action: 'an@example.invalid' },
  ])('TC-86-08 rejects invalid trusted context before any SQL (%p)', async context => {
    const begin = fixture.trace.length;
    const error = await rejected(
      fixture.accounts.getOwnedAccount(f.accountA, context as AccountOwnershipContext),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('Account ownership context is invalid');
    expect(fixture.trace.slice(begin)).toEqual([]);
  });

  it.each([f.missing, f.cognitoSubA])(
    'TC-86-09 a missing internal actor %s is an audit FK failure, never a clean 404',
    async userId => {
      const context = ownershipContext({ userId });
      const error = await rejected(fixture.accounts.getOwnedAccount(f.accountA, context));
      expect(getErrorCode(error)).toBe('23503');
      expect(error).toMatchObject({
        driverError: { constraint: 'audit_log_actor_user_id_fkey' },
      });
      expect(error).not.toBeInstanceOf(HttpException);
      expect(await ownershipAuditRows(fixture.observer, context.correlationId)).toEqual([]);
      expect(await fixture.observer.query('SELECT id FROM users WHERE id=$1', [userId])).toEqual(
        [],
      );
    },
  );

  it('TC-86-10 lookup permission errors propagate without a fallback denial', async () => {
    const role = await createOwnershipRole(fixture);
    try {
      await role.grantAuditInsert();
      await role.revokeAccountSelect();
      const context = ownershipContext();
      const error = await rejected(role.accounts.getOwnedAccount(f.accountB, context));
      expect(getErrorCode(error)).toBe('42501');
      expect(error).not.toBeInstanceOf(HttpException);
      expect(await ownershipAuditRows(fixture.observer, context.correlationId)).toEqual([]);
    } finally {
      await role.close();
    }
  });

  it.each([f.accountA, f.accountB, 'invalid-resource'])(
    'TC-86-11 refuses ownership inside an active transaction before SELECT (%s)',
    async id => {
      const context = ownershipContext();
      const begin = fixture.trace.length;
      const error = await rejected(
        fixture.tx.run(async manager => {
          await manager.query('INSERT INTO ownership_scratch(id) VALUES($1)', [
            context.correlationId,
          ]);
          await fixture.accounts.getOwnedAccount(id, context);
        }),
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe('Account ownership cannot run inside a transaction');
      expect(accountLookups(fixture.trace.slice(begin))).toEqual([]);
      expect(
        await fixture.observer.query('SELECT id FROM ownership_scratch WHERE id=$1', [
          context.correlationId,
        ]),
      ).toEqual([]);
      expect(await ownershipAuditRows(fixture.observer, context.correlationId)).toEqual([]);
    },
  );

  it('TC-86-12 a PostgreSQL lock barrier proves scalar snapshots and no context serialization', async () => {
    const result = await proveOwnershipSnapshot(fixture);
    expect(result.error).toBeInstanceOf(NotFoundException);
    expect(result.reads).toEqual({ userId: 1, role: 1, action: 1, correlationId: 1 });
    expect(result.serialized).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      actor: result.original.userId,
      action: result.original.action,
      correlationId: result.original.correlationId,
      targetId: f.accountB,
    });
    expect(await ownershipAuditRows(fixture.observer, result.changedCorrelationId)).toEqual([]);
  });

  it('TC-86-13 ten parallel denials keep exact per-invocation attribution', async () => {
    const calls = Array.from({ length: 10 }, (_, n) => ({
      id: n % 2 === 0 ? f.accountB : f.accountA,
      context: ownershipContext({
        userId: n % 2 === 0 ? f.userA : f.userB,
        action: n % 2 === 0 ? 'account.read' : 'account.transactions',
        correlationId: randomUUID(),
      }),
    }));
    let launch!: () => void;
    const barrier = new Promise<void>(resolve => {
      launch = resolve;
    });
    const pending = calls.map(call =>
      barrier.then(() => rejected(fixture.accounts.getOwnedAccount(call.id, call.context))),
    );
    launch();
    const errors = await Promise.all(pending);
    expect(errors).toHaveLength(10);
    for (const error of errors) expect(error).toBeInstanceOf(NotFoundException);
    const allRows = await Promise.all(
      calls.map(call => ownershipAuditRows(fixture.observer, call.context.correlationId)),
    );
    expect(allRows.flat()).toHaveLength(10);
    for (const [n, rows] of allRows.entries()) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: calls[n].context.userId,
        action: calls[n].context.action,
        correlationId: calls[n].context.correlationId,
        targetId: calls[n].id,
        role: 'customer',
        outcome: 'DENIED',
      });
    }
  });

  it('TC-86-14 resolves AccountsModule with real public Audit and Transaction providers', async () => {
    expect(fixture.context.get(AccountsService)).toBeInstanceOf(AccountsService);
    expect(fixture.context.get(AuditService)).toBeInstanceOf(AuditService);
    expect(fixture.context.get(TransactionService)).toBeInstanceOf(TransactionService);
    const context = ownershipContext();
    expect(
      await rejected(fixture.context.get(AccountsService).getOwnedAccount(f.accountB, context)),
    ).toBeInstanceOf(NotFoundException);
    expect(await ownershipAuditRows(fixture.observer, context.correlationId)).toHaveLength(1);
  });
});
