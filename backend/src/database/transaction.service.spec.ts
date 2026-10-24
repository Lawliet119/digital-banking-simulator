import type { ConfigType } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { fakeDataSource } from '../../test/support/fake-data-source';
import type { databaseConfig } from '../config/database.config';
import { TransactionService } from './transaction.service';

const config: ConfigType<typeof databaseConfig> = {
  url: 'postgres://u:p@localhost:5432/banking',
  poolMax: 10,
  ssl: false,
  sslCaPath: undefined,
  lockTimeoutMs: 1500,
  statementTimeoutMs: 4000,
  idleInTransactionTimeoutMs: 7000,
};

describe('TransactionService', () => {
  it('TC-42-08 retries without logging raw database error messages or credentials', async () => {
    const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { dataSource } = fakeDataSource();
      const service = new TransactionService(dataSource, config);
      let calls = 0;
      await service.run(
        () => {
          if (calls++ === 0)
            throw Object.assign(new Error('sensitive-retry-fixture'), {
              driverError: { code: '40P01' },
            });
          return Promise.resolve();
        },
        { sleep: () => Promise.resolve() },
      );
      expect(log).toHaveBeenCalledWith(
        { attempt: 1, errorType: 'Error', code: '40P01' },
        'Transaction retry',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive-');
      expect(calls).toBe(2);
    } finally {
      log.mockRestore();
    }
  });
  it('applies the timeouts from configuration to every transaction it opens', async () => {
    const { dataSource, runners } = fakeDataSource();
    const service = new TransactionService(dataSource, config);

    await service.run(() => Promise.resolve());
    await service.run(() => Promise.resolve());

    // A service that forgot to pass the configured values would fall back to the helper's
    // defaults, so the numbers are chosen to differ from any default.
    const sentTimeouts = runners.map(
      runner => (runner.query.mock.calls[0] as [string, string[]])[1],
    );
    expect(sentTimeouts).toEqual([
      ['1500ms', '4000ms', '7000ms'],
      ['1500ms', '4000ms', '7000ms'],
    ]);
  });

  it('lets a caller override one setting without losing the configured others', async () => {
    const { dataSource, runners } = fakeDataSource();
    const service = new TransactionService(dataSource, config);

    await service.run(() => Promise.resolve(), { statementTimeoutMs: 60000 });

    expect(runners[0].query.mock.calls[0][1]).toEqual(['1500ms', '60000ms', '7000ms']);
  });
});
