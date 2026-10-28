import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Joi from 'joi';
import { DataSource, type QueryRunner } from 'typeorm';
import { getErrorCode } from '@common/utils/pg-error.util';
import { loadEnv } from '@config/load-env';
import { validationSchema, type Env } from '@config/validation.schema';
import { buildSslOptions } from '@database/pg-ssl';

export type InvariantCheck =
  'ledger_totals' | 'account_balances' | 'total_balances' | 'customer_balances' | 'completed_pairs';

export interface InvariantViolation {
  check: InvariantCheck;
  accountId: string | null;
  transferId: string | null;
  actual: Record<string, string | null>;
  expected: Record<string, string | null>;
}

export interface LedgerInvariantReport {
  status: 'PASS' | 'FAIL';
  totals: { debit: string; credit: string; balance: string };
  violations: InvariantViolation[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validReport(value: unknown): value is LedgerInvariantReport {
  if (!record(value) || !record(value.totals) || !Array.isArray(value.violations)) return false;
  if (value.status !== 'PASS' && value.status !== 'FAIL') return false;
  if ((value.status === 'PASS') !== (value.violations.length === 0)) return false;
  for (const key of ['debit', 'credit', 'balance']) {
    const total = value.totals[key];
    if (typeof total !== 'string' || !/^-?\d+$/.test(total)) return false;
  }
  const checks = new Set<InvariantCheck>([
    'ledger_totals',
    'account_balances',
    'total_balances',
    'customer_balances',
    'completed_pairs',
  ]);
  return value.violations.every(
    (v: unknown) =>
      record(v) &&
      checks.has(v.check as InvariantCheck) &&
      (v.accountId === null || typeof v.accountId === 'string') &&
      (v.transferId === null || typeof v.transferId === 'string') &&
      record(v.actual) &&
      Object.values(v.actual).every(x => x === null || typeof x === 'string') &&
      record(v.expected) &&
      Object.values(v.expected).every(x => x === null || typeof x === 'string'),
  );
}

/** Uses the caller's connection/transaction; the single SELECT never changes its lifecycle. */
export async function checkLedgerInvariants(
  runner: Pick<QueryRunner, 'query'>,
): Promise<LedgerInvariantReport> {
  const rows: unknown = await runner.query(readFileSync(join(__dirname, 'invariants.sql'), 'utf8'));
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !record(rows[0]) ||
    !validReport(rows[0].report)
  ) {
    throw new Error('Invalid ledger invariant report');
  }
  return rows[0].report;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

async function runCli(args: string[]): Promise<void> {
  let kind = 'INVALID_ARGUMENT';
  let source: DataSource | undefined;
  let runner: QueryRunner | undefined;
  let report: LedgerInvariantReport | undefined;
  let failure: unknown;
  let poolFailure: unknown;
  try {
    if (args.length === 1 && args[0] === '--help') {
      console.log(
        'Usage: npm run check:invariants [-- --help]\nDATABASE_URL, DATABASE_SSL, DATABASE_SSL_CA_PATH; exits: 0 clean, 1 violations, 2 check error.',
      );
      return;
    }
    if (args.length) throw new Error('Unexpected argument');
    kind = 'INVALID_CONFIG';
    loadEnv();
    const keys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_SSL', 'DATABASE_SSL_CA_PATH'] as const;
    const schema = Joi.object(
      Object.fromEntries(keys.map(key => [key, validationSchema.extract(key)])),
    );
    const validated = schema.validate(process.env, { abortEarly: false, allowUnknown: true });
    if (validated.error) throw new Error('Invalid database configuration');
    const env = validated.value as Pick<Env, (typeof keys)[number]>;
    const url = new URL(env.DATABASE_URL);
    // pg lets these URL fields replace the verified SSL object, including its configured CA.
    for (const key of url.searchParams.keys()) {
      if (key.toLowerCase().startsWith('ssl') || key.toLowerCase() === 'uselibpqcompat') {
        throw new Error('TLS must be configured through database settings');
      }
    }
    const ssl = buildSslOptions({ enabled: env.DATABASE_SSL, caPath: env.DATABASE_SSL_CA_PATH });
    kind = 'CHECK_ERROR';
    source = new DataSource({
      type: 'postgres',
      url: env.DATABASE_URL,
      ssl,
      synchronize: false,
      migrationsRun: false,
      logging: false,
      logNotifications: false,
      extra: { max: 1, connectionTimeoutMillis: 5000 },
      // The driver's default handler logs the original message, which can contain credentials.
      poolErrorHandler: (error: unknown) => {
        poolFailure ??= error;
      },
    });
    await source.initialize();
    runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');
    await runner.query('SET TRANSACTION READ ONLY');
    await runner.query(`SELECT set_config('lock_timeout','2000ms',true),
      set_config('statement_timeout','60000ms',true),
      set_config('idle_in_transaction_session_timeout','10000ms',true)`);
    report = await checkLedgerInvariants(runner);
    await runner.commitTransaction();
  } catch (error) {
    failure = error;
    if (runner?.isTransactionActive) {
      try {
        await runner.rollbackTransaction();
      } catch {
        /* Preserve the original failure. */
      }
    }
  } finally {
    try {
      await runner?.release();
    } catch (error) {
      failure ??= error;
      kind = 'CHECK_ERROR';
    }
    try {
      if (source?.isInitialized) await source.destroy();
    } catch (error) {
      failure ??= error;
      kind = 'CHECK_ERROR';
    }
  }
  failure ??= poolFailure;
  if (failure) {
    const code = getErrorCode(failure);
    const databaseCode =
      code && (/^[0-9A-Z]{5}$/.test(code) || NETWORK_CODES.has(code)) ? code : undefined;
    console.error(
      JSON.stringify({ status: 'ERROR', kind, ...(databaseCode ? { databaseCode } : {}) }),
    );
    process.exitCode = 2;
  } else if (report) {
    console.log(JSON.stringify(report));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  }
}

if (require.main === module) {
  // runCli contains all cleanup/error handling; imports never open a connection or load env.
  void runCli(process.argv.slice(2));
}
