import type { DataSource, EntityManager } from 'typeorm';
import { withTransaction } from './transaction.helper';

interface FakeRunner {
  manager: EntityManager;
  isTransactionActive: boolean;
  connect: jest.Mock;
  startTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
  release: jest.Mock;
}

/** A DataSource whose query runners are fakes; every runner it hands out is kept for assertions. */
function fakeDataSource(overrides: Partial<FakeRunner> = {}) {
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
        release: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      runners.push(runner);
      return runner;
    }),
  } as unknown as DataSource;
  return { dataSource, runners };
}

const pgError = (code: string): Error =>
  Object.assign(new Error(`pg ${code}`), { driverError: { code } });

const noSleep = (): Promise<void> => Promise.resolve();

describe('withTransaction', () => {
  it('commits and returns the result; the callback receives the runner manager', async () => {
    const { dataSource, runners } = fakeDataSource();

    const result = await withTransaction(dataSource, manager => Promise.resolve({ manager }));

    expect(result.manager).toBe(runners[0].manager);
    expect(runners[0].commitTransaction).toHaveBeenCalledTimes(1);
    expect(runners[0].rollbackTransaction).not.toHaveBeenCalled();
    expect(runners[0].release).toHaveBeenCalledTimes(1);
  });

  it('uses READ COMMITTED by default, and honours an explicit isolation level', async () => {
    const first = fakeDataSource();
    await withTransaction(first.dataSource, () => Promise.resolve());
    expect(first.runners[0].startTransaction).toHaveBeenCalledWith('READ COMMITTED');

    const second = fakeDataSource();
    await withTransaction(second.dataSource, () => Promise.resolve(), {
      isolationLevel: 'SERIALIZABLE',
    });
    expect(second.runners[0].startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
  });

  it('rolls back, releases, and rethrows a non-retryable error untouched', async () => {
    const { dataSource, runners } = fakeDataSource();
    const failure = pgError('23505');

    await expect(
      withTransaction(dataSource, () => Promise.reject(failure), { sleep: noSleep }),
    ).rejects.toBe(failure);

    expect(runners).toHaveLength(1); // not retried
    expect(runners[0].rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runners[0].commitTransaction).not.toHaveBeenCalled();
    expect(runners[0].release).toHaveBeenCalledTimes(1);
  });

  it('re-runs the whole callback in a NEW transaction after a deadlock (40P01)', async () => {
    const { dataSource, runners } = fakeDataSource();
    const fn = jest
      .fn<Promise<string>, [EntityManager]>()
      .mockRejectedValueOnce(pgError('40P01'))
      .mockResolvedValueOnce('done');

    const result = await withTransaction(dataSource, fn, { sleep: noSleep });

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(runners).toHaveLength(2);
    expect(fn.mock.calls[0][0]).toBe(runners[0].manager);
    expect(fn.mock.calls[1][0]).toBe(runners[1].manager); // fresh runner, not the aborted one
    expect(runners[0].rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runners[1].commitTransaction).toHaveBeenCalledTimes(1);
    runners.forEach(runner => expect(runner.release).toHaveBeenCalledTimes(1));
  });

  it('also retries a serialization failure (40001)', async () => {
    const { dataSource } = fakeDataSource();
    const fn = jest
      .fn<Promise<number>, [EntityManager]>()
      .mockRejectedValueOnce(pgError('40001'))
      .mockResolvedValueOnce(7);

    await expect(withTransaction(dataSource, fn, { sleep: noSleep })).resolves.toBe(7);
  });

  it('gives up after maxRetries and rethrows the deadlock', async () => {
    const { dataSource, runners } = fakeDataSource();
    const fn = jest.fn().mockRejectedValue(pgError('40P01'));

    await expect(
      withTransaction(dataSource, fn, { maxRetries: 2, sleep: noSleep }),
    ).rejects.toMatchObject({ driverError: { code: '40P01' } });

    expect(fn).toHaveBeenCalledTimes(3); // first attempt + 2 retries
    expect(runners).toHaveLength(3);
    runners.forEach(runner => expect(runner.release).toHaveBeenCalledTimes(1));
  });

  it('does not retry at all when maxRetries is 0', async () => {
    const { dataSource } = fakeDataSource();
    const fn = jest.fn().mockRejectedValue(pgError('40P01'));

    await expect(
      withTransaction(dataSource, fn, { maxRetries: 0, sleep: noSleep }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry through onRetry, and backs off with growing delays', async () => {
    const { dataSource } = fakeDataSource();
    const fn = jest
      .fn<Promise<string>, [EntityManager]>()
      .mockRejectedValueOnce(pgError('40P01'))
      .mockRejectedValueOnce(pgError('40P01'))
      .mockResolvedValueOnce('ok');
    const onRetry = jest.fn();
    const sleep = jest.fn((_ms: number) => noSleep());

    await withTransaction(dataSource, fn, { onRetry, sleep, baseDelayMs: 100 });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls.map(([info]: [{ attempt: number }]) => info.attempt)).toEqual([1, 2]);
    // delay = base * 2^attempt * (0.5 .. 1.5): attempt 0 → 50..150 ms, attempt 1 → 100..300 ms
    const [first, second] = sleep.mock.calls.map(([ms]) => ms);
    expect(first).toBeGreaterThanOrEqual(50);
    expect(first).toBeLessThan(150);
    expect(second).toBeGreaterThanOrEqual(100);
    expect(second).toBeLessThan(300);
  });

  it('a failing rollback never hides the original error', async () => {
    const { dataSource } = fakeDataSource({
      rollbackTransaction: jest.fn().mockRejectedValue(new Error('rollback exploded')),
    });
    const original = new Error('the real problem');

    await expect(withTransaction(dataSource, () => Promise.reject(original))).rejects.toBe(
      original,
    );
  });

  it('releases the connection even when it cannot be established', async () => {
    const { dataSource, runners } = fakeDataSource({
      connect: jest.fn().mockRejectedValue(new Error('no connection')),
    });

    await expect(withTransaction(dataSource, () => Promise.resolve())).rejects.toThrow(
      'no connection',
    );
    expect(runners[0].startTransaction).not.toHaveBeenCalled();
    expect(runners[0].release).toHaveBeenCalledTimes(1);
  });

  it('retries when the COMMIT itself is aborted by a serialization failure', async () => {
    const { dataSource, runners } = fakeDataSource();
    runners.length = 0;
    let call = 0;
    (dataSource.createQueryRunner as jest.Mock).mockImplementation(() => {
      const runner: FakeRunner = {
        manager: {} as EntityManager,
        isTransactionActive: false,
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockImplementation(() => {
          runner.isTransactionActive = true;
          return Promise.resolve();
        }),
        commitTransaction: jest
          .fn()
          .mockImplementation(() =>
            call++ === 0 ? Promise.reject(pgError('40001')) : Promise.resolve(),
          ),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
      };
      runners.push(runner);
      return runner;
    });
    const fn = jest.fn().mockResolvedValue('ok');

    await expect(withTransaction(dataSource, fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
