import { Logger } from '@nestjs/common';
import type { Clock } from '@common/clock';
import { parsePositiveMoney } from '@common/money';
import type { TransactionService } from '@database/transaction.service';
import { ReconciliationService } from './reconciliation.service';

const config = {
  transfer: { perTx: parsePositiveMoney('50000000'), perDay: parsePositiveMoney('200000000') },
  idempotencyKeyRetentionDays: 7,
  outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
  rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
  reconciliationIntervalMs: 60_000,
};

const SNAPSHOT_OK = {
  total_debit: '100',
  total_credit: '100',
  total_balance: '0',
  debit_equals_credit: true,
  total_balance_is_zero: true,
  completed_pairs_valid: true,
  mismatched_details: [],
};

function make(script: (sql: string) => unknown): ReconciliationService {
  let tick = 0;
  // Each reading of the clock moves 250 ms, so a run that reads it twice lasts 250 ms.
  const clock: Clock = { now: () => new Date(Date.UTC(2026, 10, 14, 0, 0, 0) + 250 * tick++) };
  const manager = { query: jest.fn((sql: string) => Promise.resolve().then(() => script(sql))) };
  const tx = {
    run: jest.fn((fn: (m: unknown) => Promise<unknown>) => fn(manager)),
  } as unknown as TransactionService;
  return new ReconciliationService(tx, clock, config);
}

describe('structured log of a reconciliation run (DBS-123)', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('TC-123-01 an OK run writes one info line with status, duration and counts', async () => {
    const service = make(sql => {
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      if (sql.includes('INSERT INTO public.reconciliation_runs')) return [];
      return [SNAPSHOT_OK];
    });
    await service.reconcileOnce();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      { event: 'reconciliation_run', status: 'OK', durationMs: 250, mismatchedAccounts: 0 },
      'Ledger reconciliation run finished',
    );
  });

  it('TC-123-02 a MISMATCH run writes the same line with the account count and no account id', async () => {
    const service = make(sql => {
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      if (sql.includes('INSERT INTO public.reconciliation_runs')) return [];
      return [
        {
          ...SNAPSHOT_OK,
          total_balance: '5',
          total_balance_is_zero: false,
          mismatched_details: [{ accountId: 'acc-1', balance: '5', ledgerBalance: '0' }],
        },
      ];
    });
    await service.reconcileOnce();
    const [fields] = log.mock.calls[0] as [Record<string, unknown>];
    // The exact key set: nobody can add a balance or an account id to the line unnoticed.
    expect(fields).toEqual({
      event: 'reconciliation_run',
      status: 'MISMATCH',
      durationMs: 250,
      mismatchedAccounts: 1,
    });
    expect(JSON.stringify(fields)).not.toContain('acc-1');
  });

  it('TC-123-03 an ERROR run (query failed after the lock) writes the line with status ERROR', async () => {
    const service = make(sql => {
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      if (sql.includes('INSERT INTO public.reconciliation_runs')) return [];
      throw new Error('statement timeout');
    });
    await service.reconcileOnce();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({ status: 'ERROR', mismatchedAccounts: 0 });
  });

  it('TC-123-03b a total that overflows bigint is an ERROR run (no exception) and still writes the line', async () => {
    const service = make(sql => {
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      if (sql.includes('INSERT INTO public.reconciliation_runs')) return [];
      return [{ ...SNAPSHOT_OK, total_debit: '9223372036854775808' }];
    });
    await service.reconcileOnce();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({ status: 'ERROR', mismatchedAccounts: 0 });
  });

  it('TC-123-04 a run that finds the lock taken writes no line', async () => {
    const service = make(() => [{ acquired: false }]);
    await service.reconcileOnce();
    expect(log).not.toHaveBeenCalled();
  });
});
