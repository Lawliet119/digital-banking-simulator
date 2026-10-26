import type { DataSource, EntityManager } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import type { databaseConfig } from '@config/database.config';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from './audit.service';
import type { AuditRecordInput } from './audit.types';

const CONFIG: ConfigType<typeof databaseConfig> = {
  url: 'postgres://u:p@localhost:5432/banking',
  poolMax: 10,
  ssl: false,
  sslCaPath: undefined,
  lockTimeoutMs: 1500,
  statementTimeoutMs: 4000,
  idleInTransactionTimeoutMs: 7000,
};

const INPUT: AuditRecordInput = {
  actor: '11111111-1111-1111-1111-111111111111',
  role: 'operator',
  action: 'ledger.transfer',
  outcome: 'SUCCESS',
  target: { type: 'account', id: '22222222-2222-2222-2222-222222222222' },
  correlationId: '33333333-3333-3333-3333-333333333333',
  metadata: { count: 1 },
};

describe('AuditService (DBS-56)', () => {
  describe('record', () => {
    it('TC-56-01 inserts the exact columns, in order, with no RETURNING', async () => {
      const query = jest.fn().mockResolvedValue(undefined);
      const manager = { query } as unknown as EntityManager;
      const service = new AuditService({} as TransactionService);

      await service.record(manager, INPUT);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).not.toMatch(/RETURNING/i);
      expect(sql).toMatch(/INSERT INTO audit_log/i);
      expect(params).toEqual([
        INPUT.actor,
        INPUT.role,
        INPUT.action,
        INPUT.outcome,
        INPUT.target.type,
        INPUT.target.id,
        INPUT.correlationId,
        JSON.stringify(INPUT.metadata),
      ]);
    });

    it('TC-56-02 rejects with the exact error manager.query threw, unwrapped', async () => {
      const original = new Error('insert failed');
      const manager = { query: jest.fn().mockRejectedValue(original) } as unknown as EntityManager;
      const service = new AuditService({} as TransactionService);

      await expect(service.record(manager, INPUT)).rejects.toBe(original);
    });

    it('TC-56-03 a failing record() rolls back the whole transaction, uncaught', async () => {
      // A minimal stand-in for TypeORM's QueryRunner, local to this file: audit.service.spec.ts
      // lives inside the audit module, so it cannot reach test/support/fake-data-source.ts (the
      // module-boundary lint rule forbids a relative import leaving src/modules/audit/).
      const commitTransaction = jest.fn().mockResolvedValue(undefined);
      const rollbackTransaction = jest.fn().mockResolvedValue(undefined);
      const original = new Error('fk violation');
      const runner = {
        manager: { query: jest.fn().mockRejectedValue(original) } as unknown as EntityManager,
        isTransactionActive: false,
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockImplementation(() => {
          runner.isTransactionActive = true;
          return Promise.resolve();
        }),
        commitTransaction: commitTransaction.mockImplementation(() => {
          runner.isTransactionActive = false;
          return Promise.resolve();
        }),
        rollbackTransaction: rollbackTransaction.mockImplementation(() => {
          runner.isTransactionActive = false;
          return Promise.resolve();
        }),
        query: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
      };
      const dataSource = { createQueryRunner: () => runner } as unknown as DataSource;
      const transactionService = new TransactionService(dataSource, CONFIG);
      const service = new AuditService(transactionService);

      await expect(transactionService.run(manager => service.record(manager, INPUT))).rejects.toBe(
        original,
      );

      expect(rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(commitTransaction).not.toHaveBeenCalled();
    });
  });
});
