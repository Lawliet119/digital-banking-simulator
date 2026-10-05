import type { EntityManager } from 'typeorm';
import { fakeDataSource, noSleep, pgError } from '../../test/support/fake-data-source';
import { withTransaction } from './transaction.helper';

describe('withTransaction', () => {
  describe('commit and rollback', () => {
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
  });

  describe('retry on deadlock', () => {
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
      expect(onRetry.mock.calls.map(([info]: [{ attempt: number }]) => info.attempt)).toEqual([
        1, 2,
      ]);
      // delay = base * 2^attempt * (0.5 .. 1.5): attempt 0 → 50..150 ms, attempt 1 → 100..300 ms
      const [first, second] = sleep.mock.calls.map(([ms]) => ms);
      expect(first).toBeGreaterThanOrEqual(50);
      expect(first).toBeLessThan(150);
      expect(second).toBeGreaterThanOrEqual(100);
      expect(second).toBeLessThan(300);
    });

    it('retries when the COMMIT itself is aborted by a serialization failure', async () => {
      const { dataSource } = fakeDataSource({
        commitTransaction: jest
          .fn()
          .mockRejectedValueOnce(pgError('40001'))
          .mockResolvedValue(undefined),
      });
      const fn = jest.fn().mockResolvedValue('ok');

      await expect(withTransaction(dataSource, fn, { sleep: noSleep })).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('protection against a stuck transaction (a hot account must not exhaust the pool)', () => {
    it('applies lock, statement and idle-in-transaction timeouts INSIDE the transaction, before the callback', async () => {
      const { dataSource, runners } = fakeDataSource();
      const fn = jest.fn().mockResolvedValue(undefined);

      await withTransaction(dataSource, fn);

      const runner = runners[0];
      expect(runner.query).toHaveBeenCalledTimes(1);
      const [sql, params] = runner.query.mock.calls[0] as [string, string[]];
      // `true` = local to this transaction. `false` would leave the timeout on the pooled
      // connection and silently change what the next request on it can do.
      expect(sql).toMatch(/set_config\('lock_timeout', \$1, true\)/);
      expect(sql).toMatch(/set_config\('statement_timeout', \$2, true\)/);
      expect(sql).toMatch(/set_config\('idle_in_transaction_session_timeout', \$3, true\)/);
      // Secure by default: with no options at all, every timeout is a real, positive duration.
      expect(params).toHaveLength(3);
      for (const value of params) {
        expect(value).toMatch(/^[1-9]\d*ms$/);
      }
      // Order matters: the settings only exist once the transaction has begun, and must be in
      // force before the first lock is requested.
      expect(runner.startTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        runner.query.mock.invocationCallOrder[0],
      );
      expect(runner.query.mock.invocationCallOrder[0]).toBeLessThan(fn.mock.invocationCallOrder[0]);
    });

    it('lets one transaction raise its own timeout (e.g. the reconciliation job)', async () => {
      const { dataSource, runners } = fakeDataSource();

      await withTransaction(dataSource, () => Promise.resolve(), {
        lockTimeoutMs: 1500,
        statementTimeoutMs: 60000,
        idleInTransactionTimeoutMs: 90000,
      });

      expect(runners[0].query.mock.calls[0][1]).toEqual(['1500ms', '60000ms', '90000ms']);
    });

    it('sets the timeouts again in every retry, because each attempt is a fresh transaction', async () => {
      const { dataSource, runners } = fakeDataSource();
      const fn = jest
        .fn<Promise<string>, [EntityManager]>()
        .mockRejectedValueOnce(pgError('40P01'))
        .mockResolvedValueOnce('ok');

      await withTransaction(dataSource, fn, { sleep: noSleep });

      expect(runners).toHaveLength(2);
      runners.forEach(runner => expect(runner.query).toHaveBeenCalledTimes(1));
    });

    it('does NOT retry a lock timeout: waiting again would only deepen the queue on a hot account', async () => {
      const { dataSource, runners } = fakeDataSource();
      const timeout = pgError('55P03');
      const fn = jest.fn().mockRejectedValue(timeout);

      await expect(withTransaction(dataSource, fn, { sleep: noSleep })).rejects.toBe(timeout);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(runners).toHaveLength(1);
      expect(runners[0].rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(runners[0].release).toHaveBeenCalledTimes(1);
    });

    it('never runs the callback when the timeouts could not be applied, and still frees the connection', async () => {
      const { dataSource, runners } = fakeDataSource({
        query: jest.fn().mockRejectedValue(new Error('set_config failed')),
      });
      const fn = jest.fn();

      await expect(withTransaction(dataSource, fn)).rejects.toThrow('set_config failed');

      expect(fn).not.toHaveBeenCalled(); // unprotected work must not start
      expect(runners[0].rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(runners[0].release).toHaveBeenCalledTimes(1);
    });
  });
});
