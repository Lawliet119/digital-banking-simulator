import type { DataSource, EntityManager } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import type { databaseConfig } from '@config/database.config';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from './audit.service';
import { NestedTransactionError, type AuditRecordInput } from './audit.types';

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

    it('TC-56-07b rejects invalid metadata before ever calling manager.query', async () => {
      const query = jest.fn().mockResolvedValue(undefined);
      const manager = { query } as unknown as EntityManager;
      const service = new AuditService({} as TransactionService);
      const bad = { ...INPUT, metadata: { ...{ id: 'a' }, email: 'a@b.com' } as never };

      await expect(service.record(manager, bad)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    });
  });

  // A minimal stand-in for TypeORM's QueryRunner, local to this file: audit.service.spec.ts
  // lives inside the audit module, so it cannot reach test/support/fake-data-source.ts (the
  // module-boundary lint rule forbids a relative import leaving src/modules/audit/).
  function makeRunner(): {
    runner: {
      manager: EntityManager;
      isTransactionActive: boolean;
      connect: jest.Mock;
      startTransaction: jest.Mock;
      commitTransaction: jest.Mock;
      rollbackTransaction: jest.Mock;
      query: jest.Mock;
      release: jest.Mock;
    };
    dataSource: DataSource;
  } {
    const runner = {
      manager: { query: jest.fn().mockResolvedValue(undefined) } as unknown as EntityManager,
      isTransactionActive: false,
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockImplementation(() => {
        runner.isTransactionActive = true;
        return Promise.resolve();
      }),
      commitTransaction: jest.fn().mockImplementation(() => {
        runner.isTransactionActive = false;
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn().mockImplementation(() => {
        runner.isTransactionActive = false;
        return Promise.resolve();
      }),
      query: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = { createQueryRunner: () => runner } as unknown as DataSource;
    return { runner, dataSource };
  }

  describe('recordDenied (DBS-56 vòng 2, F-2: nested-transaction guard)', () => {
    const DENIED_INPUT: Omit<AuditRecordInput, 'outcome'> = {
      actor: INPUT.actor,
      role: INPUT.role,
      action: INPUT.action,
      target: INPUT.target,
      correlationId: INPUT.correlationId,
      metadata: INPUT.metadata,
    };

    it('TC-56-18 rejects NestedTransactionError when called inside an open run(), and run() is only invoked once total', async () => {
      const { dataSource } = makeRunner();
      const transactionService = new TransactionService(dataSource, CONFIG);
      const runSpy = jest.spyOn(transactionService, 'run');
      const service = new AuditService(transactionService);

      await expect(
        transactionService.run(() => service.recordDenied(DENIED_INPUT)),
      ).rejects.toBeInstanceOf(NestedTransactionError);

      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('TC-56-19 (positive control) runs normally when called outside any run()', async () => {
      const { dataSource, runner } = makeRunner();
      const transactionService = new TransactionService(dataSource, CONFIG);
      const service = new AuditService(transactionService);

      await service.recordDenied(DENIED_INPUT);

      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('TC-56-20 runs normally when called after an earlier run() has already resolved', async () => {
      const { dataSource } = makeRunner();
      const transactionService = new TransactionService(dataSource, CONFIG);
      const service = new AuditService(transactionService);

      await transactionService.run(() => Promise.resolve());
      await expect(service.recordDenied(DENIED_INPUT)).resolves.toBeUndefined();
    });

    it('TC-56-21 rejects NestedTransactionError even when nested through an awaited async helper (follows the async chain, not lexical scope)', async () => {
      const { dataSource } = makeRunner();
      const transactionService = new TransactionService(dataSource, CONFIG);
      const service = new AuditService(transactionService);

      async function helper(): Promise<void> {
        await service.recordDenied(DENIED_INPUT);
      }

      await expect(transactionService.run(() => helper())).rejects.toBeInstanceOf(
        NestedTransactionError,
      );
    });
  });

  describe('recordRoleDenied (BL-132)', () => {
    const DENIAL = {
      userId: '11111111-1111-1111-1111-111111111111',
      roles: ['operator', 'auditor'],
      method: 'POST',
      route: '/v1/operator/deposits',
      correlationId: '33333333-3333-3333-3333-333333333333',
    } as const;

    it('TC-132-01 commits one DENIED row in its own transaction: access.denied, route target, NO_PERMISSION', async () => {
      const { dataSource, runner } = makeRunner();
      const service = new AuditService(new TransactionService(dataSource, CONFIG));

      await service.recordRoleDenied({ ...DENIAL, roles: [...DENIAL.roles] });

      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
      const query = runner.manager.query as jest.Mock;
      expect(query).toHaveBeenCalledTimes(1);
      const [, params] = query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([
        DENIAL.userId,
        'operator,auditor',
        'access.denied',
        'DENIED',
        'route',
        'POST /v1/operator/deposits',
        DENIAL.correlationId,
        JSON.stringify({ reason: 'NO_PERMISSION' }),
      ]);
    });

    it('TC-132-02 stores a single derived role as is', async () => {
      const { dataSource, runner } = makeRunner();
      const service = new AuditService(new TransactionService(dataSource, CONFIG));

      await service.recordRoleDenied({ ...DENIAL, roles: ['customer'] });

      const [, params] = (runner.manager.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(params[1]).toBe('customer');
    });

    it('TC-132-03 rejects, rolled back, when the row cannot be written (fail-closed, like recordDenied)', async () => {
      const { dataSource, runner } = makeRunner();
      const failure = new Error('connection terminated');
      (runner.manager.query as jest.Mock).mockRejectedValue(failure);
      const service = new AuditService(new TransactionService(dataSource, CONFIG));

      await expect(service.recordRoleDenied({ ...DENIAL, roles: ['customer'] })).rejects.toBe(
        failure,
      );
      expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(runner.commitTransaction).not.toHaveBeenCalled();
    });
  });
});
