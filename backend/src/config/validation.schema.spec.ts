import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { ConfigValidationError, validateEnv } from './validation.schema';

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
  it('RSK-02 never approves egress or chooses a production quota implicitly', () => {
    const env = validateEnv(production);
    expect(env.RISK_AI_EGRESS_APPROVED).toBe(false);
    expect(env.RISK_AI_POLICY_REVISION).toBeUndefined();
    expect(env.RISK_AI_DAILY_REQUEST_CAP).toBeUndefined();
    expect(env.RISK_AI_CONCURRENCY).toBeUndefined();
    expect(env.RISK_AI_GATE_TIMEOUT_MS).toBeUndefined();
    expect(validateEnv({ ...base, RISK_AI_EGRESS_APPROVED: 'true' }).RISK_AI_EGRESS_APPROVED).toBe(
      true,
    );
  });

  it.each([
    ['RISK_AI_EGRESS_APPROVED', 'yes'],
    ['RISK_AI_POLICY_REVISION', 'invalid policy'],
    ['RISK_AI_DAILY_REQUEST_CAP', '0'],
    ['RISK_AI_CONCURRENCY', '-1'],
    ['RISK_AI_GATE_TIMEOUT_MS', '2147483648'],
  ])('RSK-02 rejects invalid %s without silently choosing a default', (key, value) => {
    expect(() => validateEnv({ ...base, [key]: value })).toThrow(ConfigValidationError);
  });

  describe('the shipped example file', () => {
    it('env/.env.example always passes the schema, so a new developer can copy it as-is', () => {
      const example = parse(readFileSync(resolve(__dirname, '../../env/.env.example')));
      expect(() => validateEnv(example)).not.toThrow();
    });
  });

  describe('TC-42-11 invalidKeys', () => {
    function failure(env: Record<string, unknown>): ConfigValidationError {
      try {
        validateEnv(env);
      } catch (error) {
        return error as ConfigValidationError;
      }
      throw new Error('expected validateEnv to throw');
    }

    it('names every failing key, in schema order, and keeps the combined message', () => {
      const error = failure({ ...base, PORT: 'not-a-number', LOG_LEVEL: 'INFO' });
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.invalidKeys).toEqual(['PORT', 'LOG_LEVEL']);
      expect(error.message).toMatch(/Invalid environment configuration/);
    });

    it('names a missing required key', () => {
      const { DATABASE_URL: _omitted, ...withoutDatabase } = base;
      expect(failure(withoutDatabase).invalidKeys).toEqual(['DATABASE_URL']);
    });

    it('labels the transfer-limit rule that spans two keys as <cross-field>', () => {
      const error = failure({
        ...base,
        TRANSFER_LIMIT_PER_TX: '987654321098',
        TRANSFER_LIMIT_PER_DAY: '123456789012',
      });
      expect(error.invalidKeys).toEqual(['<cross-field>']);
    });

    it('never puts a value in invalidKeys, even when the message quotes it', () => {
      const error = failure({ ...base, TRANSFER_LIMIT_PER_TX: 'sensitive-limit-fixture' });
      expect(error.invalidKeys).toEqual(['TRANSFER_LIMIT_PER_TX']);
      expect(JSON.stringify(error.invalidKeys)).not.toContain('sensitive-');
    });

    it('ignores keys outside the schema', () => {
      expect(failure({ ...base, PORT: 'x', NOT_IN_SCHEMA: 'y' }).invalidKeys).toEqual(['PORT']);
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

  describe('TC-92-06 outbox and processed-events retention (DBS-92)', () => {
    it('defaults both to 7 days', () => {
      expect(validateEnv(base)).toMatchObject({
        OUTBOX_RETENTION_DAYS: 7,
        PROCESSED_EVENTS_RETENTION_DAYS: 7,
      });
    });

    it.each(['0', '-1', '1.5', 'abc', '3651'])('rejects OUTBOX_RETENTION_DAYS=%s', value => {
      try {
        validateEnv({ ...base, OUTBOX_RETENTION_DAYS: value });
        throw new Error('expected a ConfigValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).invalidKeys).toEqual(['OUTBOX_RETENTION_DAYS']);
      }
    });

    it.each(['6', '0', '1.5', 'abc', '3651'])(
      'rejects PROCESSED_EVENTS_RETENTION_DAYS=%s (never shorter than the 6-day DLQ)',
      value => {
        try {
          validateEnv({ ...base, PROCESSED_EVENTS_RETENTION_DAYS: value });
          throw new Error('expected a ConfigValidationError');
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigValidationError);
          expect((error as ConfigValidationError).invalidKeys).toEqual([
            'PROCESSED_EVENTS_RETENTION_DAYS',
          ]);
        }
      },
    );

    it('accepts longer windows for both', () => {
      expect(
        validateEnv({
          ...base,
          OUTBOX_RETENTION_DAYS: '30',
          PROCESSED_EVENTS_RETENTION_DAYS: '30',
        }),
      ).toMatchObject({ OUTBOX_RETENTION_DAYS: 30, PROCESSED_EVENTS_RETENTION_DAYS: 30 });
    });
  });

  describe('TC-136-08 idempotency retention cannot shorten the seven-day guarantee', () => {
    it.each(['0', '1', '6', '-1', '1.5', 'abc', '3651'])(
      'rejects IDEMPOTENCY_KEY_RETENTION_DAYS=%s with the exact invalid key',
      value => {
        try {
          validateEnv({ ...base, IDEMPOTENCY_KEY_RETENTION_DAYS: value });
          throw new Error('Expected invalid retention');
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigValidationError);
          expect((error as ConfigValidationError).invalidKeys).toEqual([
            'IDEMPOTENCY_KEY_RETENTION_DAYS',
          ]);
        }
      },
    );
    it('defaults to seven and accepts a longer thirty-day window', () => {
      expect(validateEnv(base).IDEMPOTENCY_KEY_RETENTION_DAYS).toBe(7);
      expect(
        validateEnv({ ...base, IDEMPOTENCY_KEY_RETENTION_DAYS: '30' })
          .IDEMPOTENCY_KEY_RETENTION_DAYS,
      ).toBe(30);
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

  // DBS-53, ADR-06, threat T3: the local test-key path must never reach a deployed environment.
  describe('AUTH_MODE=local is for development and test only (TC-53-01…09)', () => {
    const KEYS_PATH = '.auth-local/jwks.json';
    const local = { ...base, AUTH_MODE: 'local', AUTH_LOCAL_JWKS_PATH: KEYS_PATH };
    // Only the two new keys, on top of a fully valid deployed environment (`local` itself carries
    // `base`, whose plain redis:// would be a second, unrelated error in production).
    const deployedLocal = { AUTH_MODE: 'local', AUTH_LOCAL_JWKS_PATH: KEYS_PATH };

    function invalidKeysOf(env: Record<string, unknown>): string[] {
      try {
        validateEnv(env);
      } catch (error) {
        return (error as ConfigValidationError).invalidKeys;
      }
      throw new Error('expected validateEnv to throw');
    }

    it.each(['development', 'test'])('TC-53-01 accepts local mode in %s', nodeEnv => {
      const env = validateEnv({ ...local, NODE_ENV: nodeEnv });
      expect(env.AUTH_MODE).toBe('local');
      expect(env.AUTH_LOCAL_JWKS_PATH).toBe(KEYS_PATH);
    });

    it('TC-53-02 refuses AUTH_MODE=local in staging', () => {
      const staging = { ...production, NODE_ENV: 'staging' };
      expect(invalidKeysOf({ ...staging, AUTH_MODE: 'local' })).toContain('AUTH_MODE');
    });

    it('TC-53-03 refuses AUTH_MODE=local in production, with or without a key path', () => {
      expect(invalidKeysOf({ ...production, AUTH_MODE: 'local' })).toContain('AUTH_MODE');
      expect(invalidKeysOf({ ...production, ...deployedLocal })).toContain('AUTH_MODE');
    });

    it.each(['staging', 'production'])(
      'TC-53-04 refuses a key path in %s even though the mode is cognito',
      nodeEnv => {
        const deployed = { ...production, NODE_ENV: nodeEnv };
        expect(() => validateEnv(deployed)).not.toThrow();
        expect(invalidKeysOf({ ...deployed, AUTH_LOCAL_JWKS_PATH: KEYS_PATH })).toEqual([
          'AUTH_LOCAL_JWKS_PATH',
        ]);
      },
    );

    it('TC-53-05 requires the key path when the mode is local', () => {
      const { AUTH_LOCAL_JWKS_PATH: _path, ...noPath } = local;
      expect(invalidKeysOf({ ...noPath, NODE_ENV: 'development' })).toEqual([
        'AUTH_LOCAL_JWKS_PATH',
      ]);
    });

    it('TC-53-06 refuses a key path when the mode is cognito (the default)', () => {
      expect(
        invalidKeysOf({ ...base, NODE_ENV: 'development', AUTH_LOCAL_JWKS_PATH: KEYS_PATH }),
      ).toEqual(['AUTH_LOCAL_JWKS_PATH']);
      expect(
        invalidKeysOf({
          ...base,
          NODE_ENV: 'test',
          AUTH_MODE: 'cognito',
          AUTH_LOCAL_JWKS_PATH: KEYS_PATH,
        }),
      ).toEqual(['AUTH_LOCAL_JWKS_PATH']);
    });

    it.each(['LOCAL', 'Local', 'none', '', ' local', 'local '])(
      'TC-53-07 rejects the AUTH_MODE value %j (exact match, no case folding or trimming)',
      value => {
        expect(invalidKeysOf({ ...base, AUTH_MODE: value })).toContain('AUTH_MODE');
        expect(invalidKeysOf({ ...production, AUTH_MODE: value })).toContain('AUTH_MODE');
      },
    );

    it('TC-53-08 refuses COGNITO_* next to AUTH_MODE=local', () => {
      expect(
        invalidKeysOf({ ...local, NODE_ENV: 'development', COGNITO_ISSUER: 'https://issuer.test' }),
      ).toEqual(['COGNITO_ISSUER']);
      expect(
        invalidKeysOf({
          ...local,
          NODE_ENV: 'test',
          COGNITO_USER_POOL_ID: 'pool',
          COGNITO_CLIENT_ID: 'client',
          COGNITO_ISSUER: 'https://issuer.test',
        }),
      ).toEqual(['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_ISSUER']);
    });

    it('TC-53-08b reports the missing COGNITO_* of a deployed environment, not the ones set correctly', () => {
      const {
        COGNITO_USER_POOL_ID: _p,
        COGNITO_CLIENT_ID: _c,
        COGNITO_ISSUER: _i,
        ...rest
      } = production;
      const missing = invalidKeysOf({ ...rest, AUTH_MODE: 'local' });
      expect(missing).toHaveLength(4);
      expect(missing).toEqual(
        expect.arrayContaining([
          'AUTH_MODE',
          'COGNITO_USER_POOL_ID',
          'COGNITO_CLIENT_ID',
          'COGNITO_ISSUER',
        ]),
      );
      expect(missing).not.toContain('AUTH_LOCAL_JWKS_PATH');
      // All three set correctly: only the new rules fire, never the Cognito keys themselves.
      expect(invalidKeysOf({ ...production, ...deployedLocal })).toEqual([
        'AUTH_MODE',
        'AUTH_LOCAL_JWKS_PATH',
      ]);
    });

    it('TC-53-09 defaults to cognito and leaves the existing rules alone', () => {
      expect(validateEnv({ ...base, NODE_ENV: 'development' }).AUTH_MODE).toBe('cognito');
      expect(validateEnv({ ...base, NODE_ENV: 'test' }).AUTH_MODE).toBe('cognito');
      expect(validateEnv(production).AUTH_MODE).toBe('cognito');
      const { COGNITO_ISSUER: _i, ...missing } = production;
      expect(invalidKeysOf(missing)).toEqual(['COGNITO_ISSUER']);
    });

    it('TC-53-09 the shipped env/.env.example does not switch local mode on', () => {
      const example = parse(readFileSync(resolve(__dirname, '../../env/.env.example')));
      expect(example.AUTH_MODE).toBeUndefined();
      expect(example.AUTH_LOCAL_JWKS_PATH).toBeUndefined();
      expect(validateEnv(example).AUTH_MODE).toBe('cognito');
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

  describe('business limits (BR-06, BL-007)', () => {
    it.each(['12.5', '-1', '0', '01', '1e6', 'abc', '9223372036854775808', '12345678901234567890'])(
      'rejects %j as a money value through parsePositiveMoney (digits only, no decimals, no zero, <= 2^63-1)',
      value => {
        expect(() => validateEnv({ ...base, TRANSFER_LIMIT_PER_TX: value })).toThrow(
          /TRANSFER_LIMIT_PER_TX/,
        );
      },
    );

    it('accepts a 19-digit money value up to 2^63 - 1 (MONEY_MAX)', () => {
      expect(() =>
        validateEnv({
          ...base,
          TRANSFER_LIMIT_PER_TX: '9223372036854775807',
          TRANSFER_LIMIT_PER_DAY: '9223372036854775807',
        }),
      ).not.toThrow();
    });

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

  describe('TC-75-10 REDIS_* parts', () => {
    const redisParts = {
      REDIS_HOST: 'master.dbs-dev.abc123.apse1.cache.amazonaws.com',
      REDIS_PORT: '6379',
      REDIS_AUTH_TOKEN: 'Q7rVd2kLm9XwTz4bN8pYh3sJc6fGa1uE',
    };

    it('accepts the parts next to REDIS_URL', () => {
      expect(() => validateEnv({ ...production, ...redisParts })).not.toThrow();
    });

    it('still refuses a plain redis:// url in production, parts or not', () => {
      expect(() =>
        validateEnv({ ...production, ...redisParts, REDIS_URL: 'redis://cache.internal:6379' }),
      ).toThrow(/REDIS_URL/);
    });

    it('still demands REDIS_URL when only the parts are given (they are joined by env.bootstrap)', () => {
      const { REDIS_URL: _url, ...withoutUrl } = production;
      expect(() => validateEnv({ ...withoutUrl, ...redisParts })).toThrow(/REDIS_URL/);
    });
  });

  describe('optional OPENAI_API_KEY (ADR-14, FRAUD-API-02)', () => {
    it('allows OPENAI_API_KEY to be omitted, empty or a non-whitespace token, and rejects whitespace', () => {
      expect(() => validateEnv(base)).not.toThrow();
      expect(() => validateEnv({ ...base, OPENAI_API_KEY: '' })).not.toThrow();
      expect(() => validateEnv({ ...base, OPENAI_API_KEY: 'sk-test-token-123' })).not.toThrow();
      expect(() => validateEnv({ ...base, OPENAI_API_KEY: 'sk-test-token-123 ' })).toThrow(
        /OPENAI_API_KEY/,
      );
    });
  });
});
