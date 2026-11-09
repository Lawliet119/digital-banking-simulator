import { metricsConfig } from './metrics.config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/banking',
  REDIS_URL: 'redis://localhost:6379',
  SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk-events',
  SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification-events',
};

const deployed = {
  ...base,
  DATABASE_URL: 'postgres://u:p@db.internal:5432/banking',
  DATABASE_SSL: 'true',
  TRUST_PROXY_HOPS: '1',
  REDIS_URL: 'rediss://cache.internal:6379',
  COGNITO_USER_POOL_ID: 'ap-southeast-1_abc',
  COGNITO_CLIENT_ID: 'client-id',
  COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_abc',
};

/** TC-144-08: when the EMF export is on, and how often it flushes. */
describe('metricsConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  function load(env: Record<string, string>): { enabled: boolean; flushMs: number } {
    process.env = { ...env };
    return metricsConfig();
  }

  it('is off in development and test when METRICS_EMF is not set', () => {
    expect(load({ ...base, NODE_ENV: 'development' }).enabled).toBe(false);
    expect(load({ ...base, NODE_ENV: 'test' }).enabled).toBe(false);
  });

  it('is on in staging and production when METRICS_EMF is not set', () => {
    expect(load({ ...deployed, NODE_ENV: 'staging' }).enabled).toBe(true);
    expect(load({ ...deployed, NODE_ENV: 'production' }).enabled).toBe(true);
  });

  it('METRICS_EMF decides when it is set, in both directions', () => {
    expect(load({ ...deployed, NODE_ENV: 'production', METRICS_EMF: 'false' }).enabled).toBe(false);
    expect(load({ ...base, NODE_ENV: 'development', METRICS_EMF: 'true' }).enabled).toBe(true);
  });

  it('flushes every 60 s unless METRICS_FLUSH_MS says otherwise', () => {
    expect(load({ ...base }).flushMs).toBe(60_000);
    expect(load({ ...base, METRICS_FLUSH_MS: '5000' }).flushMs).toBe(5000);
  });

  it('rejects a flush interval outside 1000..600000', () => {
    expect(() => load({ ...base, METRICS_FLUSH_MS: '999' })).toThrow(/METRICS_FLUSH_MS/);
    expect(() => load({ ...base, METRICS_FLUSH_MS: '600001' })).toThrow(/METRICS_FLUSH_MS/);
  });

  it('rejects a METRICS_EMF that is not a boolean', () => {
    expect(() => load({ ...base, METRICS_EMF: 'maybe' })).toThrow(/METRICS_EMF/);
  });
});
