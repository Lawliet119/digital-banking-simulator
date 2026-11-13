import { Counter, register } from 'prom-client';
import type { ReconciliationStatus } from './reconciliation.types';

export const RECONCILIATION_RUNS_METRIC = 'reconciliation_runs_total';

const STATUSES: readonly ReconciliationStatus[] = ['OK', 'MISMATCH', 'ERROR'];

function sharedCounter(): Counter<'status'> {
  const existing = register.getSingleMetric(RECONCILIATION_RUNS_METRIC);
  if (existing instanceof Counter) return existing;
  return new Counter({
    name: RECONCILIATION_RUNS_METRIC,
    help: 'Reconciliation runs recorded in reconciliation_runs, by status',
    labelNames: ['status'],
    registers: [register],
  });
}

const runs = sharedCounter();

/**
 * One run that was written to `reconciliation_runs` (BL-127). `MetricsService` writes it as the
 * metric `reconciliation_runs_total` with the dimensions `Role` and `Status`; the status is one of
 * three fixed words, so the label cannot hold data about an account.
 */
export function countReconciliationRun(status: ReconciliationStatus): void {
  runs.inc({ status: STATUSES.includes(status) ? status : 'ERROR' });
}
