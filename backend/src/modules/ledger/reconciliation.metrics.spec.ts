import { Logger } from '@nestjs/common';
import { register } from 'prom-client';
import type { Clock } from '@common/clock';
import { parsePositiveMoney } from '@common/money';
import type { TransactionService } from '@database/transaction.service';
import { countReconciliationRun, RECONCILIATION_RUNS_METRIC } from './reconciliation.metrics';
import { ReconciliationService } from './reconciliation.service';

const config = {
  transfer: { perTx: parsePositiveMoney('50000000'), perDay: parsePositiveMoney('200000000') },
  idempotencyKeyRetentionDays: 7,
  outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
  rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
  reconciliationIntervalMs: 300_000,
};
const clock: Clock = { now: () => new Date('2026-11-14T00:00:00.000Z') };

async function runsOf(status: string): Promise<number> {
  const metric = register.getSingleMetric(RECONCILIATION_RUNS_METRIC);
  const values = (await metric?.get())?.values ?? [];
  return values.find(v => v.labels.status === status)?.value ?? 0;
}

const SNAPSHOT_OK = {
  total_debit: '100',
  total_credit: '100',
  total_balance: '0',
  debit_equals_credit: true,
  total_balance_is_zero: true,
  completed_pairs_valid: true,
  mismatched_details: [],
};

/** A transaction service that runs the callback against a scripted manager. */
function fake(script: (sql: string, call: number) => unknown): {
  service: ReconciliationService;
  queries: string[];
} {
  const queries: string[] = [];
  const manager = {
    query: jest.fn((sql: string) => {
      queries.push(sql);
      return Promise.resolve().then(() => script(sql, queries.length));
    }),
  };
  const tx = {
    run: jest.fn((fn: (m: unknown) => Promise<unknown>) => fn(manager)),
  } as unknown as TransactionService;
  return { service: new ReconciliationService(tx, clock, config), queries };
}

describe('reconciliation_runs_total (BL-127)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('TC-127-M1 an OK run counts once with Status OK', async () => {
    const before = await runsOf('OK');
    const { service } = fake(sql => {
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      if (sql.includes('INSERT INTO public.reconciliation_runs')) return [];
      return [SNAPSHOT_OK];
    });
    expect(await service.reconcileOnce()).toMatchObject({ executed: true, status: 'OK' });
    expect(await runsOf('OK')).toBe(before + 1);
  });

  it('TC-127-M2 a MISMATCH run counts once with Status MISMATCH', async () => {
    const before = await runsOf('MISMATCH');
    const { service } = fake(sql => {
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      if (sql.includes('INSERT INTO public.reconciliation_runs')) return [];
      return [
        {
          ...SNAPSHOT_OK,
          total_balance: '5',
          total_balance_is_zero: false,
          mismatched_details: [{ accountId: 'a', balance: '5', ledgerBalance: '0' }],
        },
      ];
    });
    expect(await service.reconcileOnce()).toMatchObject({ executed: true, status: 'MISMATCH' });
    expect(await runsOf('MISMATCH')).toBe(before + 1);
  });

  it('TC-127-M3 a query that fails after the lock records an ERROR run and counts Status ERROR once', async () => {
    const before = await runsOf('ERROR');
    const { service, queries } = fake(sql => {
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      if (sql.includes('INSERT INTO public.reconciliation_runs')) return [];
      throw new Error('statement timeout');
    });
    expect(await service.reconcileOnce()).toMatchObject({ executed: true, status: 'ERROR' });
    expect(queries.some(q => q.includes('INSERT INTO public.reconciliation_runs'))).toBe(true);
    expect(await runsOf('ERROR')).toBe(before + 1);
  });

  it('TC-127-M4 a run that finds the lock taken wrote no row and counts nothing', async () => {
    const before = ['OK', 'MISMATCH', 'ERROR'].map(runsOf);
    const { service } = fake(() => [{ acquired: false }]);
    expect(await service.reconcileOnce()).toEqual({ executed: false });
    expect(await Promise.all(['OK', 'MISMATCH', 'ERROR'].map(runsOf))).toEqual(
      await Promise.all(before),
    );
  });

  it('TC-127-M5 the label is one of three fixed words; anything else becomes ERROR, never a free value', async () => {
    const before = await runsOf('ERROR');
    countReconciliationRun('3f2b8c1e-9a4d-4e21-8c7a-1b2c3d4e5f60' as never);
    expect(await runsOf('ERROR')).toBe(before + 1);
    const values = (await register.getSingleMetric(RECONCILIATION_RUNS_METRIC)?.get())?.values;
    expect(
      values?.map(v => v.labels.status).every(s => ['OK', 'MISMATCH', 'ERROR'].includes(String(s))),
    ).toBe(true);
  });
});
