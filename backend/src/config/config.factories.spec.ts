import { appConfig } from './app.config';
import { databaseConfig } from './database.config';
import { limitsConfig } from './limits.config';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: 'postgres://u:p@localhost:5432/banking',
    REDIS_URL: 'redis://localhost:6379',
    SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk-events',
    SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification-events',
  };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('appConfig', () => {
  it('splits and trims CORS_ORIGINS and drops empty entries', () => {
    process.env.CORS_ORIGINS = ' https://a.example.com , https://b.example.com,, ';
    expect(appConfig().corsOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('is empty when CORS_ORIGINS is unset', () => {
    delete process.env.CORS_ORIGINS;
    expect(appConfig().corsOrigins).toEqual([]);
  });

  it('flags production', () => {
    process.env.NODE_ENV = 'development';
    expect(appConfig().isProduction).toBe(false);
  });
});

describe('databaseConfig', () => {
  it('passes each timeout and the CA path from its own environment variable', () => {
    process.env.DATABASE_SSL = 'true';
    process.env.DATABASE_SSL_CA_PATH = '/etc/ssl/rds.pem';
    process.env.DATABASE_LOCK_TIMEOUT_MS = '1111';
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '2222';
    process.env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = '3333';

    expect(databaseConfig()).toMatchObject({
      sslCaPath: '/etc/ssl/rds.pem',
      lockTimeoutMs: 1111,
      statementTimeoutMs: 2222,
      idleInTransactionTimeoutMs: 3333,
    });
  });
});

describe('limitsConfig', () => {
  it('exposes transfer limits as bigint, never as a floating-point number (BR-01)', () => {
    const { transfer } = limitsConfig();
    expect(typeof transfer.perTx).toBe('bigint');
    expect(transfer.perTx).toBe(50_000_000n);
    expect(transfer.perDay).toBe(200_000_000n);
  });

  it('keeps full precision for amounts above 2^53', () => {
    process.env.TRANSFER_LIMIT_PER_TX = '9007199254740993';
    process.env.TRANSFER_LIMIT_PER_DAY = '9007199254740993';
    expect(limitsConfig().transfer.perTx).toBe(9_007_199_254_740_993n);
  });
});
