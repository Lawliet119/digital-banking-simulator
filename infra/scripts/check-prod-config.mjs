#!/usr/bin/env node
/**
 * DBS-152: Verify Terraform production container_environment against backend's
 * real composeDatabaseUrl, composeRedisUrl, and validateEnv.
 *
 * Usage:
 *   node infra/scripts/check-prod-config.mjs <plan.json>
 *   node infra/scripts/check-prod-config.mjs --self-test
 *
 * Note (domain review #1): At `terraform plan` time, newly created resource endpoints
 * (DB_HOST, REDIS_HOST, SQS_*_QUEUE_URL) and Secrets Manager values (DB_USER,
 * DB_PASSWORD, REDIS_AUTH_TOKEN) are unknown. This script fills unknown hosts with
 * deterministic placeholders and generates ephemeral secret placeholders at runtime,
 * then runs the exact URL composition and Joi validation of backend/.
 * Therefore, passing this check proves the rendered production config satisfies
 * backend validation, NOT live connectivity to RDS/Valkey.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const distDir = process.env.BACKEND_DIST_DIR
  ? resolve(process.env.BACKEND_DIST_DIR)
  : resolve(repoRoot, 'backend/dist');

if (!existsSync(resolve(distDir, 'config/validation.schema.js'))) {
  console.error(`ERROR: backend/dist not found at ${distDir}. Run 'npm run build' in backend/ or set BACKEND_DIST_DIR.`);
  process.exit(2);
}

const require = createRequire(import.meta.url);
const { composeDatabaseUrl } = require(resolve(distDir, 'config/compose-database-url.js'));
const { composeRedisUrl } = require(resolve(distDir, 'config/compose-redis-url.js'));
const { validateEnv, ConfigValidationError } = require(resolve(distDir, 'config/validation.schema.js'));

const PLACEHOLDERS = {
  DB_HOST: 'dbs-prod.placeholder.ap-southeast-1.rds.amazonaws.com',
  REDIS_HOST: 'master.dbs-prod.placeholder.apse1.cache.amazonaws.com',
  SQS_RISK_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/000000000000/dbs-prod-risk-events',
  SQS_NOTIFICATION_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/000000000000/dbs-prod-notification-events',
  COGNITO_USER_POOL_ID: 'ap-southeast-1_PLACEHOLDER',
  COGNITO_CLIENT_ID: 'placeholderclientid123456',
  COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_PLACEHOLDER',
};

function runtimeSecretPlaceholder() {
  return `placeholder-${randomBytes(12).toString('hex')}`;
}

function buildSelfTestFixture() {
  // Mirrors infra/terraform/envs/prod/session/locals.tf with plan-time unknowns as null.
  return {
    planned_values: {
      outputs: {
        container_environment: {
          value: {
            api: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'APP_ROLE', value: 'api' },
              { name: 'TRUST_PROXY_HOPS', value: '1' },
              { name: 'PORT', value: '3000' },
              { name: 'AWS_REGION', value: 'ap-southeast-1' },
              { name: 'LOG_LEVEL', value: 'log' },
              { name: 'COGNITO_USER_POOL_ID', value: null },
              { name: 'COGNITO_CLIENT_ID', value: null },
              { name: 'COGNITO_ISSUER', value: null },
              { name: 'DB_HOST', value: null },
              { name: 'DB_PORT', value: '5432' },
              { name: 'DB_NAME', value: 'dbs' },
              { name: 'DATABASE_SSL', value: 'true' },
              { name: 'DATABASE_SSL_CA_PATH', value: '/etc/ssl/rds/global-bundle.pem' },
              { name: 'REDIS_HOST', value: null },
              { name: 'REDIS_PORT', value: '6379' },
            ],
            worker: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'APP_ROLE', value: 'worker' },
              { name: 'TRUST_PROXY_HOPS', value: '1' },
              { name: 'AWS_REGION', value: 'ap-southeast-1' },
              { name: 'LOG_LEVEL', value: 'log' },
              { name: 'COGNITO_USER_POOL_ID', value: null },
              { name: 'COGNITO_CLIENT_ID', value: null },
              { name: 'COGNITO_ISSUER', value: null },
              { name: 'DB_HOST', value: null },
              { name: 'DB_PORT', value: '5432' },
              { name: 'DB_NAME', value: 'dbs' },
              { name: 'DATABASE_SSL', value: 'true' },
              { name: 'DATABASE_SSL_CA_PATH', value: '/etc/ssl/rds/global-bundle.pem' },
              { name: 'REDIS_HOST', value: null },
              { name: 'REDIS_PORT', value: '6379' },
              { name: 'SQS_RISK_QUEUE_URL', value: null },
              { name: 'SQS_NOTIFICATION_QUEUE_URL', value: null },
            ],
            migrate: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'AWS_REGION', value: 'ap-southeast-1' },
              { name: 'DB_HOST', value: null },
              { name: 'DB_PORT', value: '5432' },
              { name: 'DB_NAME', value: 'dbs' },
              { name: 'DATABASE_SSL', value: 'true' },
              { name: 'DATABASE_SSL_CA_PATH', value: '/etc/ssl/rds/global-bundle.pem' },
            ],
          },
        },
      },
    },
  };
}

function hydrateEnv(entries, includeRedis) {
  const env = {};
  const substituted = [];

  for (const entry of entries) {
    if (entry.value === null || entry.value === undefined || entry.value === '') {
      if (PLACEHOLDERS[entry.name]) {
        env[entry.name] = PLACEHOLDERS[entry.name];
        substituted.push(entry.name);
      }
    } else {
      env[entry.name] = String(entry.value);
    }
  }

  env.DB_USER = 'dbs_master';
  env.DB_PASSWORD = runtimeSecretPlaceholder();
  substituted.push('DB_USER', 'DB_PASSWORD');

  const db = composeDatabaseUrl(env);
  if (!db.url) {
    throw new Error(`composeDatabaseUrl failed: ${db.invalid.join(', ')}`);
  }
  env.DATABASE_URL = db.url;

  if (includeRedis) {
    env.REDIS_AUTH_TOKEN = runtimeSecretPlaceholder();
    substituted.push('REDIS_AUTH_TOKEN');
    const redis = composeRedisUrl(env);
    if (!redis.url) {
      throw new Error(`composeRedisUrl failed: ${redis.invalid.join(', ')}`);
    }
    env.REDIS_URL = redis.url;
  }

  return { env, substituted };
}

function redactEnvForDisplay(env) {
  const redacted = { ...env };
  for (const key of ['DB_PASSWORD', 'REDIS_AUTH_TOKEN', 'DATABASE_URL', 'REDIS_URL']) {
    if (redacted[key]) {
      redacted[key] = redacted[key].replace(/:[^:@]+@/, ':<redacted>@');
      if (key === 'DB_PASSWORD' || key === 'REDIS_AUTH_TOKEN') {
        redacted[key] = '<runtime-placeholder>';
      }
    }
  }
  return redacted;
}

function runNegativeChecks(apiEnv) {
  const cases = [
    {
      label: 'TRUST_PROXY_HOPS=0',
      env: { ...apiEnv, TRUST_PROXY_HOPS: '0' },
      expectedKey: 'TRUST_PROXY_HOPS',
    },
    {
      label: 'DATABASE_SSL=false',
      env: { ...apiEnv, DATABASE_SSL: 'false' },
      expectedKey: 'DATABASE_SSL',
    },
    {
      label: 'REDIS_URL=redis:// (no TLS)',
      env: { ...apiEnv, REDIS_URL: 'redis://:secret@localhost:6379' },
      expectedKey: 'REDIS_URL',
    },
    {
      label: 'AUTH_MODE=local',
      env: { ...apiEnv, AUTH_MODE: 'local' },
      expectedKey: 'AUTH_MODE',
    },
    {
      label: 'missing COGNITO_CLIENT_ID',
      env: (() => {
        const copy = { ...apiEnv };
        delete copy.COGNITO_CLIENT_ID;
        return copy;
      })(),
      expectedKey: 'COGNITO_CLIENT_ID',
    },
  ];

  console.log('\n[M-152-04] Negative validation checks:');
  for (const c of cases) {
    let caught = null;
    try {
      validateEnv(c.env);
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof ConfigValidationError) || !caught.invalidKeys.includes(c.expectedKey)) {
      throw new Error(
        `Negative case "${c.label}" failed: expected invalidKeys to include ${c.expectedKey}, got ${JSON.stringify(caught?.invalidKeys)}`,
      );
    }
    console.log(`  PASS ${c.label} -> rejected invalidKeys=${JSON.stringify(caught.invalidKeys)}`);
  }

  const stagingValidated = validateEnv({ ...apiEnv, NODE_ENV: 'staging' });
  console.log(
    `  INFO NODE_ENV=staging -> accepted by schema (NODE_ENV=${stagingValidated.NODE_ENV}, isProduction=false -> Swagger enabled; prod locks NODE_ENV=production)`,
  );
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node infra/scripts/check-prod-config.mjs <plan.json | --self-test>');
    process.exit(1);
  }

  const plan = arg === '--self-test' ? buildSelfTestFixture() : JSON.parse(readFileSync(resolve(arg), 'utf8'));
  const containerEnv = plan?.planned_values?.outputs?.container_environment?.value;
  if (!containerEnv || !containerEnv.api || !containerEnv.worker || !containerEnv.migrate) {
    console.error('ERROR: planned_values.outputs.container_environment.value.{api,worker,migrate} missing in plan JSON.');
    process.exit(1);
  }

  console.log('Limitation: plan-time unknown hosts and Secrets Manager values are substituted with runtime placeholders.');

  const apiHydrated = hydrateEnv(containerEnv.api, true);
  const apiValidated = validateEnv(apiHydrated.env);
  console.log('\n[M-152-03] api:', {
    isProduction: apiValidated.NODE_ENV === 'production',
    substituted: apiHydrated.substituted,
    env: redactEnvForDisplay(apiHydrated.env),
  });
  if (apiValidated.NODE_ENV !== 'production') {
    throw new Error(`api NODE_ENV must be production, got ${apiValidated.NODE_ENV}`);
  }

  const workerHydrated = hydrateEnv(containerEnv.worker, true);
  const workerValidated = validateEnv(workerHydrated.env);
  console.log('\n[M-152-03] worker:', {
    isProduction: workerValidated.NODE_ENV === 'production',
    substituted: workerHydrated.substituted,
    env: redactEnvForDisplay(workerHydrated.env),
  });
  if (workerValidated.NODE_ENV !== 'production') {
    throw new Error(`worker NODE_ENV must be production, got ${workerValidated.NODE_ENV}`);
  }

  // migrate runs TypeORM CLI (data-source.ts) and does not use Redis or HTTP proxy settings.
  const migrateHydrated = hydrateEnv(containerEnv.migrate, false);
  if (migrateHydrated.env.NODE_ENV !== 'production' || migrateHydrated.env.DATABASE_SSL !== 'true') {
    throw new Error('migrate must set NODE_ENV=production and DATABASE_SSL=true');
  }
  console.log('\n[M-152-03] migrate:', {
    isProduction: migrateHydrated.env.NODE_ENV === 'production',
    substituted: migrateHydrated.substituted,
    env: redactEnvForDisplay(migrateHydrated.env),
  });

  runNegativeChecks(apiHydrated.env);
  console.log('\nALL PROD CONFIG CHECKS PASSED.');
}

main();
