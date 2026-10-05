import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { fakeDataSource } from './support/fake-data-source';

/**
 * Unit tests build TransactionService by hand, so they cannot notice if Nest fails to inject the
 * database settings in the real application. This boots the real ConfigModule (validation and
 * typed config included) next to the real TransactionService, with only the DataSource faked.
 */
describe('TransactionService wiring (real ConfigModule, no database)', () => {
  const original = process.env;

  beforeAll(() => {
    process.env = {
      ...original,
      DATABASE_URL: 'postgres://u:p@localhost:5432/banking',
      REDIS_URL: 'redis://localhost:6379',
      SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk-events',
      SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification-events',
      DATABASE_LOCK_TIMEOUT_MS: '1234',
      DATABASE_STATEMENT_TIMEOUT_MS: '2345',
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '3456',
    };
  });

  afterAll(() => {
    process.env = original;
  });

  it('hands the timeouts from the environment to every transaction', async () => {
    // Imported after the environment is set: ConfigModule validates it as the file is loaded.
    const { ConfigModule } = await import('../src/config/config.module');
    const { TransactionService } = await import('../src/database/transaction.service');
    const { dataSource, runners } = fakeDataSource();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule],
      providers: [TransactionService, { provide: getDataSourceToken(), useValue: dataSource }],
    }).compile();

    await moduleRef.get(TransactionService).run(() => Promise.resolve());

    expect(runners[0].query.mock.calls[0][1]).toEqual(['1234ms', '2345ms', '3456ms']);
    await moduleRef.close();
  });
});
