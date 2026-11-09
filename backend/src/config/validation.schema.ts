import * as Joi from 'joi';
import { MoneyError, parsePositiveMoney } from '../common/money';

function validatePositiveMoneyString(
  value: string,
  helpers: Joi.CustomHelpers,
): string | Joi.ErrorReport {
  try {
    parsePositiveMoney(value);
    return value;
  } catch (error) {
    if (error instanceof MoneyError) {
      return helpers.error('any.invalid');
    }
    throw error;
  }
}

/**
 * The validated shape of the environment. Money-like values stay strings here and become
 * `bigint` in the config factories (BR-01: money is an integer number of dong, never a float).
 */
export interface Env {
  NODE_ENV: 'development' | 'test' | 'staging' | 'production';
  PORT: number;
  APP_ROLE: 'api' | 'worker' | 'both';
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';
  CORS_ORIGINS: string;
  TRUST_PROXY_HOPS: number;

  DATABASE_URL: string;
  DB_HOST?: string;
  DB_PORT?: string;
  DB_NAME?: string;
  DB_USER?: string;
  DB_PASSWORD?: string;
  REDIS_HOST?: string;
  REDIS_PORT?: string;
  REDIS_AUTH_TOKEN?: string;
  DATABASE_POOL_MAX: number;
  DATABASE_SSL: boolean;
  DATABASE_SSL_CA_PATH?: string;
  DATABASE_LOCK_TIMEOUT_MS: number;
  DATABASE_STATEMENT_TIMEOUT_MS: number;
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: number;

  REDIS_URL: string;
  REDIS_COMMAND_TIMEOUT_MS: number;

  AWS_REGION: string;
  SQS_ENDPOINT?: string;
  SQS_RISK_QUEUE_URL?: string;
  SQS_NOTIFICATION_QUEUE_URL?: string;

  COGNITO_USER_POOL_ID?: string;
  COGNITO_CLIENT_ID?: string;
  COGNITO_ISSUER?: string;
  AUTH_MODE: 'cognito' | 'local';
  AUTH_LOCAL_JWKS_PATH?: string;
  ACCESS_TOKEN_TTL_SECONDS: number;
  JWKS_REFETCH_COOLDOWN_MS: number;

  TRANSFER_LIMIT_PER_TX: string;
  TRANSFER_LIMIT_PER_DAY: string;
  IDEMPOTENCY_KEY_RETENTION_DAYS: number;
  OUTBOX_RETENTION_DAYS: number;
  PROCESSED_EVENTS_RETENTION_DAYS: number;
  RATE_LIMIT_TRANSFERS_PER_MINUTE: number;
  RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE: number;

  OPENAI_API_KEY?: string;
  RECONCILIATION_INTERVAL_MS: number;
  METRICS_EMF?: boolean;
  METRICS_FLUSH_MS: number;
}

const isDeployed = Joi.valid('staging', 'production');

export const validationSchema = Joi.object<Env>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  APP_ROLE: Joi.string().valid('api', 'worker', 'both').default('both'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'log', 'debug', 'verbose').default('log'),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // How many reverse proxies (the ALB) sit in front. Per-IP rate limiting keys on the client IP:
  // 0 behind the ALB makes every client share the ALB's address, so a deployed environment
  // (staging or production, both behind an ALB) must state it.
  TRUST_PROXY_HOPS: Joi.number().when('NODE_ENV', {
    is: isDeployed,
    then: Joi.number().integer().min(1).max(5).required(),
    otherwise: Joi.number().integer().min(0).max(5).default(0),
  }),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  // Parts of DATABASE_URL for ECS (env.bootstrap joins them when DATABASE_URL is not set). Not read
  // anywhere else; DATABASE_URL stays required, so an incomplete set fails here with a clear error.
  DB_HOST: Joi.string(),
  DB_PORT: Joi.string(),
  DB_NAME: Joi.string(),
  DB_USER: Joi.string(),
  DB_PASSWORD: Joi.string(),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(50).default(10),
  // NFR-SEC-03: connections to the database are encrypted in every deployed environment.
  // Staging talks to a real RDS over the same cloud network as production.
  DATABASE_SSL: Joi.boolean().when('NODE_ENV', {
    is: isDeployed,
    then: Joi.boolean().valid(true).required(),
    otherwise: Joi.boolean().default(false),
  }),

  // CA bundle for verifying the server certificate (Node does not trust the RDS CA by default).
  // Without TLS it would be silently ignored while the connection stays unencrypted, so it is an
  // error to set it then.
  DATABASE_SSL_CA_PATH: Joi.string().when('DATABASE_SSL', {
    is: true,
    otherwise: Joi.forbidden(),
  }),
  // Waits that never end exhaust the pool (a hot account), so none may be switched off:
  // PostgreSQL treats 0 as "no limit", which is why the minimum is above 0.
  DATABASE_LOCK_TIMEOUT_MS: Joi.number().integer().min(100).max(30_000).default(2000),
  DATABASE_STATEMENT_TIMEOUT_MS: Joi.number().integer().min(100).max(120_000).default(5000),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600_000)
    .default(10_000),

  // NFR-SEC-03: Redis is reached over TLS (`rediss://`) in every deployed environment.
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required()
    .when('NODE_ENV', {
      is: isDeployed,
      then: Joi.string().uri({ scheme: ['rediss'] }),
    }),
  // Redis is an accelerator, never the source of truth: a slow Redis must not slow a transfer.
  REDIS_COMMAND_TIMEOUT_MS: Joi.number().integer().min(10).max(1000).default(50),
  // Parts of REDIS_URL for ECS (DBS-75, env.bootstrap joins them when REDIS_URL is not set). Not read
  // anywhere else; REDIS_URL stays required, so an incomplete set fails here with a clear error.
  REDIS_HOST: Joi.string(),
  REDIS_PORT: Joi.string(),
  REDIS_AUTH_TOKEN: Joi.string(),

  AWS_REGION: Joi.string().default('ap-southeast-1'),
  SQS_ENDPOINT: Joi.string().uri().optional(),
  // Only the worker consumes and publishes; an API-only instance never touches SQS.
  SQS_RISK_QUEUE_URL: Joi.string()
    .uri()
    .when('APP_ROLE', { is: Joi.valid('worker', 'both'), then: Joi.required() }),
  SQS_NOTIFICATION_QUEUE_URL: Joi.string()
    .uri()
    .when('APP_ROLE', { is: Joi.valid('worker', 'both'), then: Joi.required() }),

  // DBS-53, ADR-06, threat T3: the test-key path (`local`) must never be reachable in a deployed
  // environment. `Joi.invalid('local')` and not `valid('cognito')`: inside `when`, `valid()` ADDS
  // to the allowed list instead of replacing it, so `production + local` would still pass.
  AUTH_MODE: Joi.string()
    .valid('cognito', 'local')
    .default('cognito')
    .when('NODE_ENV', { is: isDeployed, then: Joi.invalid('local') }),
  // Where the local JWKS lives. Allowed only in local mode and never in a deployed environment,
  // so "a deployed environment holds a test key" is itself a startup error, not just the mode.
  AUTH_LOCAL_JWKS_PATH: Joi.string().when('NODE_ENV', {
    is: isDeployed,
    then: Joi.forbidden(),
    otherwise: Joi.when('AUTH_MODE', {
      is: 'local',
      then: Joi.required(),
      otherwise: Joi.forbidden(),
    }),
  }),
  // One nested rule per key, never two chained `when`: chained, a correctly set COGNITO_* in
  // `production + local` is reported as the error (`any.unknown`) instead of the real culprit.
  COGNITO_USER_POOL_ID: Joi.string().when('NODE_ENV', {
    is: isDeployed,
    then: Joi.required(),
    otherwise: Joi.when('AUTH_MODE', { is: 'local', then: Joi.forbidden() }),
  }),
  COGNITO_CLIENT_ID: Joi.string().when('NODE_ENV', {
    is: isDeployed,
    then: Joi.required(),
    otherwise: Joi.when('AUTH_MODE', { is: 'local', then: Joi.forbidden() }),
  }),
  COGNITO_ISSUER: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: isDeployed,
      then: Joi.required(),
      otherwise: Joi.when('AUTH_MODE', { is: 'local', then: Joi.forbidden() }),
    }),
  // Also the TTL of the "sessions revoked" marker in Redis (BR-12): after this long, every token
  // issued before the revocation has expired on its own.
  ACCESS_TOKEN_TTL_SECONDS: Joi.number().integer().min(60).max(86_400).default(900),
  // Minimum time between JWKS refetches triggered by an unknown `kid` (DBS-50: at most 1/min).
  JWKS_REFETCH_COOLDOWN_MS: Joi.number().integer().min(1_000).max(300_000).default(60_000),

  TRANSFER_LIMIT_PER_TX: Joi.string().custom(validatePositiveMoneyString).default('50000000'),
  TRANSFER_LIMIT_PER_DAY: Joi.string().custom(validatePositiveMoneyString).default('200000000'),
  IDEMPOTENCY_KEY_RETENTION_DAYS: Joi.number().integer().min(1).default(7),
  // DBS-92. Published outbox rows are deleted after this many days. 3650 stops make_interval from
  // overflowing at run time.
  OUTBOX_RETENTION_DAYS: Joi.number().integer().min(1).max(3650).default(7),
  // The dedup marks must outlive the dead-letter queue (6 days, infra sqs.tf), or an event redriven
  // from it would be handled twice: never below 7.
  PROCESSED_EVENTS_RETENTION_DAYS: Joi.number().integer().min(7).max(3650).default(7),
  RATE_LIMIT_TRANSFERS_PER_MINUTE: Joi.number().integer().min(1).default(10),
  RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE: Joi.number().integer().min(1).default(100),

  // Optional API key for the external AI fraud evaluation adapter (ADR-14, FRAUD-API-02).
  // Baseline `rule_only` mode runs without it; whitespace-padded keys are rejected.
  OPENAI_API_KEY: Joi.string().allow('').pattern(/^\S+$/).optional(),
  RECONCILIATION_INTERVAL_MS: Joi.number().integer().min(1000).max(86_400_000).default(300_000),
  // DBS-144. Unset = on in staging and production, off elsewhere (config/metrics.config.ts).
  METRICS_EMF: Joi.boolean().optional(),
  METRICS_FLUSH_MS: Joi.number().integer().min(1000).max(600_000).default(60_000),
}).custom((env: Env, helpers) => {
  try {
    const perTx = parsePositiveMoney(env.TRANSFER_LIMIT_PER_TX);
    const perDay = parsePositiveMoney(env.TRANSFER_LIMIT_PER_DAY);
    if (perTx > perDay) {
      return helpers.message({
        custom: 'TRANSFER_LIMIT_PER_TX must not be greater than TRANSFER_LIMIT_PER_DAY',
      });
    }
  } catch (error) {
    if (error instanceof MoneyError) {
      return env;
    }
    throw error;
  }
  return env;
});

/**
 * Validates and normalises an environment (usually `process.env`). Applies defaults, converts
 * numbers/booleans, and throws ONE error listing every problem, so a misconfigured deployment
 * fails at boot instead of the first time a transfer needs the missing value.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = validationSchema.validate(raw, { abortEarly: false, allowUnknown: true });
  if (result.error) {
    const problems = result.error.details.map(detail => `  - ${detail.message}`).join('\n');
    throw new ConfigValidationError(
      `Invalid environment configuration:\n${problems}`,
      invalidKeysOf(result.error.details),
    );
  }
  return result.value;
}

/** Label for a rule that spans several keys (it reports an empty path). */
export const CROSS_FIELD = '<cross-field>';

/**
 * A startup failure must say which keys are wrong without repeating their values (a value can be
 * a credential or a URL). `message` keeps the full text for callers that already read it; the
 * logger uses only this list. Only names that exist in the schema are accepted.
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly invalidKeys: string[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const SCHEMA_KEYS = new Set(
  Object.keys((validationSchema.describe().keys ?? {}) as Record<string, unknown>),
);

function invalidKeysOf(details: Joi.ValidationErrorItem[]): string[] {
  const keys = details.map(detail => {
    const key = detail.path[0];
    return typeof key === 'string' && SCHEMA_KEYS.has(key) ? key : CROSS_FIELD;
  });
  return [...new Set(keys)];
}
