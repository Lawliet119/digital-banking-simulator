import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { validateEnv } from './validation.schema';

/** The smallest environment that is valid for the default role (`both`) in development. */
const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/banking',
  REDIS_URL: 'redis://localhost:6379',
  SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk-events',
  SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification-events',
};

/** Everything production additionally demands. */
const production = {
  ...base,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.internal:5432/banking',
  DATABASE_SSL: 'true',
  TRUST_PROXY_HOPS: '1',
  REDIS_URL: 'rediss://cache.internal:6379',
  COGNITO_USER_POOL_ID: 'ap-southeast-1_abc',
  COGNITO_CLIENT_ID: 'client-id',
  COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_abc',
};

describe('validateEnv', () => {
  describe('the shipped example file', () => {
    it('env/.env.example always passes the schema, so a new developer can copy it as-is', () => {
      const example = parse(readFileSync(resolve(__dirname, '../../env/.env.example')));
      expect(() => validateEnv(example)).not.toThrow();
    });
  });

  describe('defaults and conversion', () => {
    it('accepts the minimal development environment and fills in defaults', () => {
      const env = validateEnv(base);
      expect(env).toMatchObject({
        NODE_ENV: 'development',
        PORT: 3000,
        APP_ROLE: 'both',
        DATABASE_POOL_MAX: 10,
        DATABASE_SSL: false,
        REDIS_COMMAND_TIMEOUT_MS: 50,
        ACCESS_TOKEN_TTL_SECONDS: 900,
        TRANSFER_LIMIT_PER_TX: '50000000',
        TRANSFER_LIMIT_PER_DAY: '200000000',
        IDEMPOTENCY_KEY_RETENTION_DAYS: 7,
      });
    });

    it('converts numeric and boolean strings (process.env is all strings)', () => {
      const env = validateEnv({
        ...base,
        PORT: '8080',
        DATABASE_SSL: 'true',
        DATABASE_POOL_MAX: '20',
      });
      expect(env.PORT).toBe(8080);
      expect(env.DATABASE_SSL).toBe(true);
      expect(env.DATABASE_POOL_MAX).toBe(20);
    });

    it('ignores unrelated variables that process.env always contains', () => {
      expect(() => validateEnv({ ...base, PATH: '/usr/bin', HOME: '/root' })).not.toThrow();
    });
  });

  describe('required values', () => {
    it('refuses to boot without DATABASE_URL or REDIS_URL, listing every problem at once', () => {
      const run = () => validateEnv({});
      expect(run).toThrow(/Invalid environment configuration/);
      expect(run).toThrow(/DATABASE_URL/);
      expect(run).toThrow(/REDIS_URL/);
    });

    it('rejects a DATABASE_URL that is not a postgres URL', () => {
      expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
        /DATABASE_URL/,
      );
    });

    it('rejects an unknown APP_ROLE', () => {
      expect(() => validateEnv({ ...base, APP_ROLE: 'apii' })).toThrow(/APP_ROLE/);
    });
  });

  describe('APP_ROLE decides whether queues are required', () => {
    const { SQS_RISK_QUEUE_URL: _r, SQS_NOTIFICATION_QUEUE_URL: _n, ...noQueues } = base;

    it('an api-only instance does not need SQS settings', () => {
      expect(() => validateEnv({ ...noQueues, APP_ROLE: 'api' })).not.toThrow();
    });

    it.each(['worker', 'both'])('a %s instance requires both queue URLs', role => {
      const run = () => validateEnv({ ...noQueues, APP_ROLE: role });
      expect(run).toThrow(/SQS_RISK_QUEUE_URL/);
      expect(run).toThrow(/SQS_NOTIFICATION_QUEUE_URL/);
    });
  });

  describe('production hardening (NFR-SEC-03)', () => {
    it('accepts a fully configured production environment', () => {
      expect(() => validateEnv(production)).not.toThrow();
    });

    it('requires TLS to the database', () => {
      expect(() => validateEnv({ ...production, DATABASE_SSL: 'false' })).toThrow(/DATABASE_SSL/);
      const { DATABASE_SSL: _ssl, ...missing } = production;
      expect(() => validateEnv(missing)).toThrow(/DATABASE_SSL/);
    });

    it('requires TLS to Redis (rediss://)', () => {
      expect(() =>
        validateEnv({ ...production, REDIS_URL: 'redis://cache.internal:6379' }),
      ).toThrow(/REDIS_URL/);
    });

    it('requires Cognito settings', () => {
      const { COGNITO_ISSUER: _i, ...missing } = production;
      expect(() => validateEnv(missing)).toThrow(/COGNITO_ISSUER/);
    });

    it('does not demand any of this in development', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
    });

    // Staging runs on the same cloud network as production, so it gets the same transport rules.
    describe('staging is a deployed environment too', () => {
      const staging = { ...production, NODE_ENV: 'staging' };

      it('accepts a fully configured staging environment', () => {
        expect(() => validateEnv(staging)).not.toThrow();
      });

      it.each([
        ['DATABASE_SSL', { DATABASE_SSL: 'false' }],
        ['REDIS_URL', { REDIS_URL: 'redis://cache.internal:6379' }],
        ['TRUST_PROXY_HOPS', { TRUST_PROXY_HOPS: '0' }],
      ])('rejects staging without %s hardening', (name, override) => {
        expect(() => validateEnv({ ...staging, ...override })).toThrow(new RegExp(name));
      });
    });
  });

  describe('client IP behind the load balancer (per-IP rate limiting depends on it)', () => {
    it('production must say how many proxies sit in front: forgetting makes every client share the ALB address', () => {
      const { TRUST_PROXY_HOPS: _hops, ...forgotten } = production;
      expect(() => validateEnv(forgotten)).toThrow(/TRUST_PROXY_HOPS/);
    });

    it('production rejects 0 hops, which would key every rate limit on the load balancer itself', () => {
      expect(() => validateEnv({ ...production, TRUST_PROXY_HOPS: '0' })).toThrow(
        /TRUST_PROXY_HOPS/,
      );
    });

    it('development needs no proxy', () => {
      expect(validateEnv(base).TRUST_PROXY_HOPS).toBe(0);
    });
  });

  describe('database protection against a stuck transaction', () => {
    it('has a positive timeout for every kind of wait even when nothing is configured', () => {
      const env = validateEnv(base);
      expect(env.DATABASE_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
      expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
      expect(env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it.each([
      'DATABASE_LOCK_TIMEOUT_MS',
      'DATABASE_STATEMENT_TIMEOUT_MS',
      'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS',
    ])('refuses to switch %s off with 0 (PostgreSQL treats 0 as "wait forever")', name => {
      expect(() => validateEnv({ ...base, [name]: '0' })).toThrow(new RegExp(name));
    });

    it('reads the configured values as numbers', () => {
      const env = validateEnv({ ...base, DATABASE_LOCK_TIMEOUT_MS: '1234' });
      expect(env.DATABASE_LOCK_TIMEOUT_MS).toBe(1234);
    });
  });

  describe('database TLS trust', () => {
    it('accepts a CA file together with TLS', () => {
      expect(() =>
        validateEnv({ ...base, DATABASE_SSL: 'true', DATABASE_SSL_CA_PATH: '/etc/ssl/rds.pem' }),
      ).not.toThrow();
    });

    it('rejects a CA file without TLS: it would be silently ignored while the connection stays unencrypted', () => {
      expect(() => validateEnv({ ...base, DATABASE_SSL_CA_PATH: '/etc/ssl/rds.pem' })).toThrow(
        /DATABASE_SSL_CA_PATH/,
      );
    });
  });

  describe('business limits (BR-06)', () => {
    it.each(['12.5', '-1', '0', '1e6', 'abc', '1234567890123456789'])(
      'rejects %j as a money value (digits only, no decimals, no zero)',
      value => {
        expect(() => validateEnv({ ...base, TRANSFER_LIMIT_PER_TX: value })).toThrow(
          /TRANSFER_LIMIT_PER_TX/,
        );
      },
    );

    it('rejects a per-transaction limit larger than the daily limit', () => {
      expect(() =>
        validateEnv({
          ...base,
          TRANSFER_LIMIT_PER_TX: '300000000',
          TRANSFER_LIMIT_PER_DAY: '200000000',
        }),
      ).toThrow(/must not be greater than TRANSFER_LIMIT_PER_DAY/);
    });

    it('accepts equal limits', () => {
      expect(() =>
        validateEnv({ ...base, TRANSFER_LIMIT_PER_TX: '1000', TRANSFER_LIMIT_PER_DAY: '1000' }),
      ).not.toThrow();
    });
  });
});
