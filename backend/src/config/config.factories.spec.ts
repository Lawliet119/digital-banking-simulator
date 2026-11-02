import { appConfig } from './app.config';
import { authConfig } from './auth.config';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from './auth-local';
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

describe('authConfig (DBS-53, TC-53-10)', () => {
  it('cognito mode (the default) has no local section and keeps the Cognito values', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AUTH_MODE;
    delete process.env.AUTH_LOCAL_JWKS_PATH;
    process.env.COGNITO_USER_POOL_ID = 'ap-southeast-1_abc';
    process.env.COGNITO_CLIENT_ID = 'client-abc';
    process.env.COGNITO_ISSUER =
      'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_abc/';

    const cfg = authConfig();
    expect(cfg.local).toBeUndefined();
    expect(cfg.cognito.clientId).toBe('client-abc');
    expect(cfg.cognito.issuer).toBe(process.env.COGNITO_ISSUER);
    expect(cfg.cognito.jwksUri).toBe(
      'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_abc/.well-known/jwks.json',
    );
  });

  it('local mode exposes the key path and the fixed issuer and client id, and no remote JWKS', () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_MODE = 'local';
    process.env.AUTH_LOCAL_JWKS_PATH = '.auth-local/jwks.json';
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;
    delete process.env.COGNITO_ISSUER;

    const cfg = authConfig();
    expect(cfg.local).toEqual({ jwksPath: '.auth-local/jwks.json' });
    expect(cfg.cognito.issuer).toBe(LOCAL_ISSUER);
    expect(cfg.cognito.clientId).toBe(LOCAL_CLIENT_ID);
    expect(cfg.cognito.jwksUri).toBeUndefined();
  });
});
