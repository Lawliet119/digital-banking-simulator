import { parsePositiveMoney } from '@common/money';
import { validateEnv } from '@config/validation.schema';
import { ReconciliationService } from './reconciliation.service';
import {
  classifyReconciliationSnapshot,
  isSignedBigIntString,
  RECONCILIATION_ADVISORY_LOCK_KEY,
  type RawReconciliationSnapshot,
} from './reconciliation.types';
import type { TransactionService } from '@database/transaction.service';
import type { Clock } from '@common/clock';

const BASE_ENV = {
  DATABASE_URL: 'postgres://banking:banking_local_only@localhost:5432/banking',
  REDIS_URL: 'redis://localhost:6379',
  SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk-events',
  SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification-events',
};

describe('reconciliation.types & ReconciliationService lifecycle (DBS-117)', () => {
  describe('TC-117-12: isSignedBigIntString & classifyReconciliationSnapshot & RECONCILIATION_INTERVAL_MS', () => {
    it('validates signed 64-bit bigint boundary strings accurately (including > 2^53)', () => {
      expect(RECONCILIATION_ADVISORY_LOCK_KEY).toEqual([20261108, 117]);
      expect(isSignedBigIntString('0')).toBe(true);
      expect(isSignedBigIntString('9007199254740993')).toBe(true); // 2^53 + 1
      expect(isSignedBigIntString('9223372036854775807')).toBe(true); // max signed int64
      expect(isSignedBigIntString('-9223372036854775808')).toBe(true); // min signed int64

      expect(isSignedBigIntString('9223372036854775808')).toBe(false); // max + 1
      expect(isSignedBigIntString('-9223372036854775809')).toBe(false); // min - 1
      expect(isSignedBigIntString('-0')).toBe(false);
      expect(isSignedBigIntString('01')).toBe(false);
      expect(isSignedBigIntString('12.34')).toBe(false);
      expect(isSignedBigIntString('')).toBe(false);
    });

    it('classifies a clean ledger snapshot as OK with empty details array', () => {
      const raw: RawReconciliationSnapshot = {
        total_debit: '9007199254740993',
        total_credit: '9007199254740993',
        total_balance: '0',
        debit_equals_credit: true,
        total_balance_is_zero: true,
        completed_pairs_valid: true,
        mismatched_details: [],
      };

      expect(classifyReconciliationSnapshot(raw)).toEqual({
        status: 'OK',
        totalDebit: '9007199254740993',
        totalCredit: '9007199254740993',
        totalBalance: '0',
        mismatchedAccounts: 0,
        details: [],
      });
    });

    it('classifies each of the 4 invariant violations as MISMATCH when totals fit in bigint', () => {
      const base: RawReconciliationSnapshot = {
        total_debit: '1000',
        total_credit: '1000',
        total_balance: '0',
        debit_equals_credit: true,
        total_balance_is_zero: true,
        completed_pairs_valid: true,
        mismatched_details: [],
      };

      expect(
        classifyReconciliationSnapshot({
          ...base,
          total_debit: '1500',
          debit_equals_credit: false,
        }).status,
      ).toBe('MISMATCH');

      expect(
        classifyReconciliationSnapshot({
          ...base,
          total_balance: '500',
          total_balance_is_zero: false,
        }).status,
      ).toBe('MISMATCH');

      expect(
        classifyReconciliationSnapshot({
          ...base,
          completed_pairs_valid: false,
        }),
      ).toEqual({
        status: 'MISMATCH',
        totalDebit: '1000',
        totalCredit: '1000',
        totalBalance: '0',
        mismatchedAccounts: 0,
        details: [],
      });

      const mismatched = classifyReconciliationSnapshot({
        ...base,
        mismatched_details: [
          {
            accountId: '11111111-1111-4111-8111-111111111111',
            balance: '1200',
            ledgerBalance: '1000',
          },
        ],
      });
      expect(mismatched).toEqual({
        status: 'MISMATCH',
        totalDebit: '1000',
        totalCredit: '1000',
        totalBalance: '0',
        mismatchedAccounts: 1,
        details: [
          {
            accountId: '11111111-1111-4111-8111-111111111111',
            balance: '1200',
            ledgerBalance: '1000',
          },
        ],
      });
    });

    it('classifies signed 64-bit bigint overflow in totals or ledgerBalance as ERROR with NULLs (BL-165)', () => {
      const overflowTotals = classifyReconciliationSnapshot({
        total_debit: '9223372036854775808',
        total_credit: '9223372036854775808',
        total_balance: '0',
        debit_equals_credit: true,
        total_balance_is_zero: true,
        completed_pairs_valid: true,
        mismatched_details: [],
      });
      expect(overflowTotals).toEqual({
        status: 'ERROR',
        totalDebit: null,
        totalCredit: null,
        totalBalance: '0',
        mismatchedAccounts: 0,
        details: null,
      });

      const overflowDetail = classifyReconciliationSnapshot({
        total_debit: '1000',
        total_credit: '1000',
        total_balance: '0',
        debit_equals_credit: true,
        total_balance_is_zero: true,
        completed_pairs_valid: true,
        mismatched_details: [
          {
            accountId: '11111111-1111-4111-8111-111111111111',
            balance: '0',
            ledgerBalance: '-9223372036854775809',
          },
        ],
      });
      expect(overflowDetail).toEqual({
        status: 'ERROR',
        totalDebit: '1000',
        totalCredit: '1000',
        totalBalance: '0',
        mismatchedAccounts: 0,
        details: null,
      });
    });

    it('validates RECONCILIATION_INTERVAL_MS default (300000) and range (1000..86400000)', () => {
      const defaults = validateEnv(BASE_ENV);
      expect(defaults.RECONCILIATION_INTERVAL_MS).toBe(300_000);

      const custom = validateEnv({ ...BASE_ENV, RECONCILIATION_INTERVAL_MS: '60000' });
      expect(custom.RECONCILIATION_INTERVAL_MS).toBe(60_000);

      expect(() => validateEnv({ ...BASE_ENV, RECONCILIATION_INTERVAL_MS: '999' })).toThrow(
        /RECONCILIATION_INTERVAL_MS/,
      );
      expect(() => validateEnv({ ...BASE_ENV, RECONCILIATION_INTERVAL_MS: '86400001' })).toThrow(
        /RECONCILIATION_INTERVAL_MS/,
      );
    });
  });

  describe('TC-117-01: ReconciliationService role guard & polling lifecycle', () => {
    const originalRole = process.env.APP_ROLE;

    afterEach(() => {
      if (originalRole === undefined) {
        delete process.env.APP_ROLE;
      } else {
        process.env.APP_ROLE = originalRole;
      }
    });

    it('does not start polling when APP_ROLE=api, and starts/stops cleanly when APP_ROLE=worker', async () => {
      const tx = {
        run: jest.fn().mockResolvedValue({ executed: false }),
      } as unknown as TransactionService;
      const clock: Clock = { now: () => new Date('2026-11-08T00:00:00.000Z') };
      const config = {
        transfer: {
          perTx: parsePositiveMoney('50000000'),
          perDay: parsePositiveMoney('200000000'),
        },
        idempotencyKeyRetentionDays: 7,
        outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
        rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
        reconciliationIntervalMs: 300_000,
      };

      process.env.APP_ROLE = 'api';
      const apiService = new ReconciliationService(tx, clock, config);
      apiService.onApplicationBootstrap();
      await apiService.onApplicationShutdown();
      expect(tx.run).not.toHaveBeenCalled();

      process.env.APP_ROLE = 'worker';
      const workerService = new ReconciliationService(tx, clock, config);
      workerService.onApplicationBootstrap();
      await workerService.onApplicationShutdown();
      expect(tx.run).toHaveBeenCalledTimes(1);
    });
  });
});
