import 'reflect-metadata';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import type { AccountOwnershipContext } from '@modules/accounts';
import { AuditReason } from '@modules/audit';
import { getErrorCode } from '@common/utils/pg-error.util';
import { safeErrorMetadata } from '@common/logging/logging.options';
import { ACCOUNT_FIXTURE as f } from '../support/accounts-service-probe';
import { requireDatabaseUrl } from '../support/temp-database';
import { startPostgresContainer, stopPostgresContainer } from '../support/postgres.container';
import {
  accountLookups,
  createOwnershipFixture,
  createOwnershipRole,
  ownershipAuditRows,
  ownershipContext,
  ownershipInvariants,
  ownershipProblem,
  rejected,
  safeOwnershipFailure,
  type OwnershipFixture,
  type OwnershipRole,
} from '../support/resource-ownership-probe';

function report(step: string, result: unknown): void {
  console.log(`${step} ${JSON.stringify(result)}`);
}

async function main(): Promise<void> {
  assert.equal(process.argv[2] ?? 'all', 'all', 'Only the all manual mode is supported');
  let ownsContainer = false;
  let fixture: OwnershipFixture | undefined;
  let role: OwnershipRole | undefined;
  const roleNames: string[] = [];
  let completed = false;
  let failed = false;
  let failure: unknown;
  try {
    if (!process.env.DATABASE_URL) {
      const started = await startPostgresContainer();
      process.env.DATABASE_URL = started.databaseUrl;
      ownsContainer = true;
    }
    fixture = await createOwnershipFixture();
    const probe = fixture;
    const balancesBefore = await probe.observer.query(
      'SELECT id,balance FROM accounts ORDER BY id',
    );
    const ownedContext = ownershipContext();
    const owned = await probe.accounts.getOwnedAccount(f.accountA, ownedContext);
    assert.equal(owned.balance, '0');
    assert.equal(owned.userId, f.userA);
    assert.deepEqual(Object.keys(owned).sort(), [
      'balance',
      'createdAt',
      'customerId',
      'id',
      'status',
      'type',
      'updatedAt',
      'userId',
    ]);
    assert.deepEqual(await ownershipAuditRows(probe.observer, ownedContext.correlationId), []);
    report('M-86-01 OWNED', { account: owned, auditCount: 0 });

    const deniedContext = ownershipContext();
    const deniedError = await rejected(probe.accounts.getOwnedAccount(f.accountB, deniedContext));
    assert(deniedError instanceof NotFoundException);
    const denialRows = await ownershipAuditRows(probe.observer, deniedContext.correlationId);
    assert.equal(denialRows.length, 1);
    assert.deepEqual(denialRows[0], {
      id: denialRows[0].id,
      actor: f.userA,
      role: 'customer',
      action: 'account.read',
      outcome: 'DENIED',
      targetType: 'account',
      targetId: f.accountB,
      correlationId: deniedContext.correlationId,
      metadata: { reason: AuditReason.NOT_OWNER },
    });
    const problem = ownershipProblem(deniedError, deniedContext.correlationId);
    assert.equal(problem.status, 404);
    assert.equal(problem.errorCode, undefined);
    report('M-86-02 FOREIGN', { problem, audit: denialRows[0] });

    const { correlationId: _requestId, ...expectedProblem } = problem;
    for (const [kind, id] of [
      ['missing', f.missing],
      ['SYSTEM', f.funding],
      ['malformed-email', 'khong-luu@example.invalid'],
      ['malformed-injection', "' OR 1=1 --"],
    ]) {
      const context = ownershipContext();
      const begin = probe.trace.length;
      const error = await rejected(probe.accounts.getOwnedAccount(id, context));
      assert(error instanceof NotFoundException);
      const body = ownershipProblem(error, context.correlationId);
      const { correlationId: _correlationId, ...safeBody } = body;
      assert.deepEqual(safeBody, expectedProblem);
      const rows = await ownershipAuditRows(probe.observer, context.correlationId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].metadata.reason, AuditReason.NOT_OWNER);
      assert.equal(rows[0].targetId, kind.startsWith('malformed') ? 'invalid' : id);
      if (kind.startsWith('malformed')) {
        assert.equal(accountLookups(probe.trace.slice(begin)).length, 0);
        assert(!JSON.stringify(rows).includes(id));
      }
      report('M-86-03 SAME_404', { kind, problem: body, audit: rows[0] });
    }

    const scratchRollback = new Error('Expected manual scratch rollback');
    assert.equal(
      await rejected(
        probe.tx.run(async manager => {
          await manager.query('INSERT INTO ownership_scratch(id) VALUES($1)', [
            deniedContext.correlationId,
          ]);
          throw scratchRollback;
        }),
      ),
      scratchRollback,
    );
    const scratch = await probe.observer.query('SELECT id FROM ownership_scratch WHERE id=$1', [
      deniedContext.correlationId,
    ]);
    const retained = await ownershipAuditRows(probe.observer, deniedContext.correlationId);
    assert.equal(scratch.length, 0);
    assert.equal(retained.length, 1);
    report('M-86-04 DENIAL_SURVIVES_ROLLBACK', {
      correlationId: deniedContext.correlationId,
      scratchCount: scratch.length,
      audit: retained[0],
    });

    role = await createOwnershipRole(probe);
    roleNames.push(role.name);
    const blockedContext = ownershipContext();
    const insertFailure = await rejected(role.accounts.getOwnedAccount(f.accountB, blockedContext));
    assert.equal(getErrorCode(insertFailure), '42501');
    assert(!(insertFailure instanceof NotFoundException));
    const blockedRows = await ownershipAuditRows(probe.observer, blockedContext.correlationId);
    assert.equal(blockedRows.length, 0);
    report('M-86-05 INSERT_REFUSED', {
      correlationId: blockedContext.correlationId,
      failure: safeOwnershipFailure(insertFailure),
      auditCount: blockedRows.length,
    });

    await role.grantAuditInsert();
    const recoveredContext = ownershipContext();
    const recovered = await rejected(role.accounts.getOwnedAccount(f.accountB, recoveredContext));
    assert(recovered instanceof NotFoundException);
    const recoveredRows = await ownershipAuditRows(probe.observer, recoveredContext.correlationId);
    assert.equal(recoveredRows.length, 1);
    report('M-86-06 RECOVERED', {
      failure: safeOwnershipFailure(recovered),
      audit: recoveredRows[0],
    });

    for (const [kind, context] of [
      ['absent', undefined],
      ['wrong-role', { ...ownershipContext(), role: 'admin' }],
      ['wrong-action', { ...ownershipContext(), action: 'untrusted' }],
    ] as const) {
      const begin = probe.trace.length;
      const error = await rejected(
        probe.accounts.getOwnedAccount(f.accountA, context as unknown as AccountOwnershipContext),
      );
      assert(error instanceof TypeError);
      assert.equal(error.message, 'Account ownership context is invalid');
      assert.equal(probe.trace.length, begin);
      report('M-86-07 CONTEXT_REFUSED', {
        kind,
        failure: safeOwnershipFailure(error),
        sqlCount: 0,
      });
    }
    const absentActor = ownershipContext({ userId: f.cognitoSubA });
    const actorFailure = await rejected(probe.accounts.getOwnedAccount(f.accountA, absentActor));
    assert.equal(getErrorCode(actorFailure), '23503');
    assert.equal((await ownershipAuditRows(probe.observer, absentActor.correlationId)).length, 0);
    report('M-86-07 ACTOR_FK_REFUSED', {
      correlationId: absentActor.correlationId,
      failure: safeOwnershipFailure(actorFailure),
      auditCount: 0,
    });

    for (const [kind, id] of [
      ['owned', f.accountA],
      ['foreign', f.accountB],
    ]) {
      const context = ownershipContext();
      const begin = probe.trace.length;
      const error = await rejected(
        probe.tx.run(async manager => {
          await manager.query('INSERT INTO ownership_scratch(id) VALUES($1)', [
            context.correlationId,
          ]);
          await probe.accounts.getOwnedAccount(id, context);
        }),
      );
      assert(error instanceof TypeError);
      assert.equal(error.message, 'Account ownership cannot run inside a transaction');
      assert.equal(accountLookups(probe.trace.slice(begin)).length, 0);
      const rows = await probe.observer.query('SELECT id FROM ownership_scratch WHERE id=$1', [
        context.correlationId,
      ]);
      assert.equal(rows.length, 0);
      assert.equal((await ownershipAuditRows(probe.observer, context.correlationId)).length, 0);
      report('M-86-08 TRANSACTION_REFUSED', {
        kind,
        correlationId: context.correlationId,
        failure: safeOwnershipFailure(error),
        accountSelects: 0,
        scratchCount: rows.length,
        auditCount: 0,
      });
    }

    const balancesAfter = await probe.observer.query('SELECT id,balance FROM accounts ORDER BY id');
    assert.deepEqual(balancesAfter, balancesBefore);
    const [{ transfers, ledgerEntries }] = await probe.observer.query<
      { transfers: string; ledgerEntries: string }[]
    >(`SELECT (SELECT count(*) FROM transfers) AS transfers,
       (SELECT count(*) FROM ledger_entries) AS "ledgerEntries"`);
    assert.equal(transfers, '0');
    assert.equal(ledgerEntries, '0');
    const invariants = await ownershipInvariants(probe.observer);
    assert.equal(invariants.status, 'PASS');
    assert.deepEqual(invariants.violations, []);
    report('M-86-09 INVARIANTS', { balances: balancesAfter, transfers, ledgerEntries, invariants });
    report('M-86-HTTP-TRANSFER PENDING', {
      status: 'chưa chạy',
      dependencies: ['DBS-61', 'DBS-60'],
    });
    report('M-86-HTTP-ACCOUNT PENDING', { status: 'chưa chạy', dependencies: ['DBS-64'] });
    report('M-86-HTTP-HISTORY PENDING', {
      status: 'chưa chạy',
      dependencies: ['DBS-87', 'DBS-61'],
    });
    completed = true;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const databaseName = fixture?.databaseName;
    const roleClosed = role ? await Promise.allSettled([role.close()]) : [];
    const fixtureClosed = fixture ? await Promise.allSettled([fixture.close()]) : [];
    let cleanupFailure: unknown;
    const failures = [...roleClosed, ...fixtureClosed].filter(
      result => result.status === 'rejected',
    );
    if (failures.length > 0) cleanupFailure = failures[0].reason;
    if (databaseName && cleanupFailure === undefined) {
      let admin: DataSource | undefined;
      try {
        admin = await new DataSource({
          type: 'postgres',
          url: requireDatabaseUrl(),
        }).initialize();
        const [{ databases, roles }] = await admin.query<{ databases: string; roles: string }[]>(
          `SELECT (SELECT count(*) FROM pg_database WHERE datname=$1) AS databases,
             (SELECT count(*) FROM pg_roles WHERE rolname=ANY($2::text[])) AS roles`,
          [databaseName, roleNames],
        );
        assert.equal(databases, '0');
        assert.equal(roles, '0');
        report('M-86-09 CLEANUP', { databases, roles });
      } catch (error) {
        cleanupFailure = error;
      } finally {
        if (admin?.isInitialized) {
          try {
            await admin.destroy();
          } catch (error) {
            cleanupFailure ??= error;
          }
        }
      }
    }
    if (ownsContainer) {
      try {
        await stopPostgresContainer();
        report('M-86-09 CONTAINER_STOPPED', { ownedByThisRun: true });
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure !== undefined) {
      failure = failed
        ? new AggregateError([failure, cleanupFailure], 'The manual run and cleanup failed')
        : cleanupFailure;
      failed = true;
    }
  }
  if (failed) {
    if (failure instanceof Error) throw failure;
    throw new Error('The ownership manual run failed', { cause: failure });
  }
  assert(completed);
}

void main().catch((error: unknown) => {
  console.error('DBS-86 manual failed', JSON.stringify(safeErrorMetadata(error)));
  process.exitCode = 1;
});
