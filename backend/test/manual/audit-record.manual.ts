import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from '../../src/modules/audit/audit.service';

/**
 * Manual test script for DBS-56 (see docs/features/DBS-56-audit-service-record.md §5). Runs
 * against the real docker-compose PostgreSQL via `DATABASE_URL`, not a temp database — the point
 * is to operate `AuditService` the way a real caller would. Needs a real `users.id` (first CLI
 * arg) and the `fc_scratch(id uuid PRIMARY KEY)` table, both seeded by hand first (§5).
 */
const log = (label: string, value?: unknown): void =>
  console.log(label, value === undefined ? '' : JSON.stringify(value));

async function main(): Promise<void> {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: ts-node test/manual/audit-record.manual.ts <users.id>');
    process.exitCode = 1;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const dataSource = await new DataSource({ type: 'postgres', url }).initialize();
  const transactionService = new TransactionService(dataSource, {
    url,
    poolMax: 5,
    ssl: false,
    sslCaPath: undefined,
    lockTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    idleInTransactionTimeoutMs: 10000,
  });
  const auditService = new AuditService(transactionService);

  try {
    // M-56-01: SUCCESS, written in the caller's own transaction.
    const m1CorrelationId = randomUUID();
    await transactionService.run(manager =>
      auditService.record(manager, {
        actor: userId,
        role: 'operator',
        action: 'ledger.transfer',
        outcome: 'SUCCESS',
        target: { type: 'account', id: randomUUID() },
        correlationId: m1CorrelationId,
      }),
    );
    log('M-56-01 correlationId (expect 1 row, outcome SUCCESS)', m1CorrelationId);

    // M-56-02: fail-closed — a real scratch-table write and a FK-violating record() share a
    // transaction; both must be gone after rollback.
    const m2ScratchId = randomUUID();
    const m2CorrelationId = randomUUID();
    try {
      await transactionService.run(async manager => {
        await manager.query('INSERT INTO fc_scratch(id) VALUES ($1)', [m2ScratchId]);
        await auditService.record(manager, {
          actor: randomUUID(), // not a real users.id -> FK violation
          role: 'operator',
          action: 'ledger.transfer',
          outcome: 'SUCCESS',
          target: { type: 'account', id: randomUUID() },
          correlationId: m2CorrelationId,
        });
      });
      log('M-56-02 UNEXPECTED: record() did not reject');
    } catch (error) {
      log('M-56-02 record() rejected as expected (fail-closed)', (error as Error).message);
    }
    log('M-56-02 scratchId (expect 0 rows in fc_scratch)', m2ScratchId);
    log('M-56-02 correlationId (expect 0 rows in audit_log)', m2CorrelationId);

    // M-56-03: a DENIED record survives even though the caller "fails" right after it commits.
    const m3CorrelationId = randomUUID();
    await auditService.recordDenied({
      actor: userId,
      role: 'customer',
      action: 'access.denied',
      target: { type: 'account', id: randomUUID() },
      correlationId: m3CorrelationId,
    });
    try {
      throw new Error('simulated 404: account does not belong to this customer');
    } catch (error) {
      log(
        'M-56-03 caller "failed" after recordDenied() had already committed',
        (error as Error).message,
      );
    }
    log('M-56-03 correlationId (expect 1 row, outcome DENIED)', m3CorrelationId);
  } finally {
    await dataSource.destroy();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
