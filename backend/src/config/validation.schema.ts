import * as Joi from 'joi';

/** Matches a positive integer written as digits (no sign, no decimals, no leading zero). */
const MONEY_PATTERN = /^[1-9]\d{0,17}$/;

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
  DATABASE_POOL_MAX: number;
  DATABASE_SSL: boolean;

  REDIS_URL: string;
  REDIS_COMMAND_TIMEOUT_MS: number;

  AWS_REGION: string;
  SQS_ENDPOINT?: string;
  SQS_RISK_QUEUE_URL?: string;
  SQS_NOTIFICATION_QUEUE_URL?: string;

  COGNITO_USER_POOL_ID?: string;
  COGNITO_CLIENT_ID?: string;
  COGNITO_ISSUER?: string;
  ACCESS_TOKEN_TTL_SECONDS: number;

  TRANSFER_LIMIT_PER_TX: string;
  TRANSFER_LIMIT_PER_DAY: string;
  IDEMPOTENCY_KEY_RETENTION_DAYS: number;
  RATE_LIMIT_TRANSFERS_PER_MINUTE: number;
  RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE: number;
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
  // How many reverse proxies (the ALB) sit in front. Rate limiting keys on the client IP.
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(0),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(50).default(10),
  // NFR-SEC-03: connections to the database are encrypted in production.
  DATABASE_SSL: Joi.boolean().when('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().valid(true).required(),
    otherwise: Joi.boolean().default(false),
  }),

  // NFR-SEC-03: Redis is reached over TLS (`rediss://`) in production.
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().uri({ scheme: ['rediss'] }),
    }),
  // Redis is an accelerator, never the source of truth: a slow Redis must not slow a transfer.
  REDIS_COMMAND_TIMEOUT_MS: Joi.number().integer().min(10).max(1000).default(50),

  AWS_REGION: Joi.string().default('ap-southeast-1'),
  SQS_ENDPOINT: Joi.string().uri().optional(),
  // Only the worker consumes and publishes; an API-only instance never touches SQS.
  SQS_RISK_QUEUE_URL: Joi.string()
    .uri()
    .when('APP_ROLE', { is: Joi.valid('worker', 'both'), then: Joi.required() }),
  SQS_NOTIFICATION_QUEUE_URL: Joi.string()
    .uri()
    .when('APP_ROLE', { is: Joi.valid('worker', 'both'), then: Joi.required() }),

  COGNITO_USER_POOL_ID: Joi.string().when('NODE_ENV', { is: isDeployed, then: Joi.required() }),
  COGNITO_CLIENT_ID: Joi.string().when('NODE_ENV', { is: isDeployed, then: Joi.required() }),
  COGNITO_ISSUER: Joi.string().uri().when('NODE_ENV', { is: isDeployed, then: Joi.required() }),
  // Also the TTL of the "sessions revoked" marker in Redis (BR-12): after this long, every token
  // issued before the revocation has expired on its own.
  ACCESS_TOKEN_TTL_SECONDS: Joi.number().integer().min(60).max(86_400).default(900),

  TRANSFER_LIMIT_PER_TX: Joi.string().pattern(MONEY_PATTERN).default('50000000'),
  TRANSFER_LIMIT_PER_DAY: Joi.string().pattern(MONEY_PATTERN).default('200000000'),
  IDEMPOTENCY_KEY_RETENTION_DAYS: Joi.number().integer().min(1).default(7),
  RATE_LIMIT_TRANSFERS_PER_MINUTE: Joi.number().integer().min(1).default(10),
  RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE: Joi.number().integer().min(1).default(100),
}).custom((env: Env, helpers) => {
  if (BigInt(env.TRANSFER_LIMIT_PER_TX) > BigInt(env.TRANSFER_LIMIT_PER_DAY)) {
    return helpers.message({
      custom: 'TRANSFER_LIMIT_PER_TX must not be greater than TRANSFER_LIMIT_PER_DAY',
    });
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
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.value;
}
