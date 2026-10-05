import type { ConfigType } from '@nestjs/config';
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
