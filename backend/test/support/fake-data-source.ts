import type { DataSource, EntityManager } from 'typeorm';

/**
 * Test-only stand-in for TypeORM's QueryRunner. It records what the code under test sends, so a
 * test can assert the contract at the database boundary (which statements, in which order). It
 * proves nothing about how PostgreSQL itself behaves — that needs a real database (Testcontainers).
 */
export interface FakeRunner {
  manager: EntityManager;
  isTransactionActive: boolean;
  connect: jest.Mock;
  startTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
  query: jest.Mock;
  release: jest.Mock;
}

/** A DataSource whose runners are fakes; every runner it hands out is kept for assertions. */
export function fakeDataSource(overrides: Partial<FakeRunner> = {}) {
  const runners: FakeRunner[] = [];
  const dataSource = {
    createQueryRunner: jest.fn(() => {
      const runner: FakeRunner = {
        manager: { id: runners.length + 1 } as unknown as EntityManager,
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
        ...overrides,
      };
      runners.push(runner);
      return runner;
    }),
  } as unknown as DataSource;
  return { dataSource, runners };
}

/** Mimics TypeORM's QueryFailedError: the SQLSTATE sits on `driverError`, not on the error. */
export const pgError = (code: string): Error =>
  Object.assign(new Error(`pg ${code}`), { driverError: { code } });

export const noSleep = (): Promise<void> => Promise.resolve();
