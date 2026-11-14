import { Logger } from '@nestjs/common';
import { SystemClock } from '@common/clock';
import { MetricsService } from '@common/metrics';
import type { EmfDocument } from '@common/metrics/emf';
import { parsePositiveMoney } from '@common/money';
import type { TransactionService } from '@database/transaction.service';
import { ReconciliationService } from '../../src/modules/ledger/reconciliation.service';

/**
 * Manual driver for DBS-123 (docs/features/DBS-123-reconciliation-alarms.md §5, M-123-01).
 * Runs the real `ReconciliationService.reconcileOnce` and the real `MetricsService` (the same
 * classes the worker uses) against a scripted ledger snapshot, and prints the EMF line the worker
 * would write to CloudWatch Logs. It needs no database: the snapshot is the input row of the thing
 * under test, not a balance. Usage: ts-node -r tsconfig-paths/register test/manual/reconciliation-emf.manual.ts OK|MISMATCH|ERROR
 */
const mode = process.argv[2] ?? 'OK';
if (!['OK', 'MISMATCH', 'ERROR'].includes(mode)) throw new Error('mode must be OK, MISMATCH or ERROR');

const snapshot = {
  total_debit: '350000000',
  total_credit: '350000000',
  total_balance: mode === 'MISMATCH' ? '1000000' : '0',
  debit_equals_credit: true,
  total_balance_is_zero: mode !== 'MISMATCH',
  completed_pairs_valid: true,
  mismatched_details:
    mode === 'MISMATCH' ? [{ accountId: 'a1', balance: '1000000', ledgerBalance: '0' }] : [],
};

const manager = {
  query: (sql: string): Promise<unknown> => {
    if (sql.includes('pg_try_advisory_xact_lock')) return Promise.resolve([{ acquired: true }]);
    if (sql.includes('INSERT INTO public.reconciliation_runs')) return Promise.resolve([]);
    if (mode === 'ERROR') return Promise.reject(new Error('statement timeout'));
    return Promise.resolve([snapshot]);
  },
};
const tx = { run: (fn: (m: unknown) => Promise<unknown>) => fn(manager) } as TransactionService;

async function main(): Promise<void> {
  Logger.overrideLogger(['log', 'warn', 'error']);
  const lines: EmfDocument[] = [];
  const metrics = new MetricsService(
    { enabled: true, flushMs: 60_000 },
    { role: 'worker' } as never,
    { logger: {} } as never,
    doc => lines.push(doc),
  );
  await metrics.start();
  const service = new ReconciliationService(tx, new SystemClock(), {
    reconciliationIntervalMs: 60_000,
    transfer: { perTx: parsePositiveMoney('50000000'), perDay: parsePositiveMoney('200000000') },
  } as never);
  const outcome = await service.reconcileOnce();
  console.error(`outcome: ${JSON.stringify({ executed: outcome.executed, status: 'status' in outcome ? outcome.status : null })}`);
  await metrics.flush(Date.now(), false);
  for (const doc of lines) console.log(JSON.stringify(doc));
  await metrics.onApplicationShutdown();
}

void main();
