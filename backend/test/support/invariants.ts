import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Joi from 'joi';
import { DataSource, type QueryRunner } from 'typeorm';
import { getErrorCode } from '@common/utils/pg-error.util';
import { composeDatabaseUrl } from '@config/compose-database-url';
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

/** Thrown for configuration problems. It carries variable names only, never their values. */
class InvalidConfigError extends Error {
  constructor(readonly invalid: readonly string[]) {
    super('Invalid database configuration');
  }
}

const DB_CONFIG_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'DATABASE_SSL',
  'DATABASE_SSL_CA_PATH',
] as const;

async function runCli(args: string[]): Promise<void> {
  let kind = 'INVALID_ARGUMENT';
  let invalid: readonly string[] | undefined;
  let source: DataSource | undefined;
  let runner: QueryRunner | undefined;
  let report: LedgerInvariantReport | undefined;
  let failure: unknown;
  let poolFailure: unknown;
  // Set right after COMMIT resolves, with no await in between. The report is assigned before the
  // commit, so it is not a safe gate: only a committed check has a settled result.
  let committed = false;
  try {
    if (args.length === 1 && args[0] === '--help') {
      console.log(
        [
          'Usage: npm run check:invariants [-- --help]',
          'Config: DATABASE_URL, or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD (the ECS parts); DATABASE_SSL, DATABASE_SSL_CA_PATH.',
          'Exits: 0 clean, 1 violations, 2 the check did not complete cleanly. The exit code is authoritative: a report may be printed with exit 2, and a PASS report with exit 2 is not accepted as clean.',
          'A config error prints {"status":"ERROR","kind":"INVALID_CONFIG","invalid":[names]} on stderr; names only, never values.',
        ].join('\n'),
      );
      return;
    }
    if (args.length) throw new Error('Unexpected argument');
    kind = 'INVALID_CONFIG';
    loadEnv();
    // ECS passes the parts, not a URL. composeDatabaseUrl is pure and the rule is the app's own: a
    // non-empty DATABASE_URL always wins. An incomplete or malformed set stops here, naming only the
    // DB_* variables that are wrong; letting Joi run would also add DATABASE_URL to the list.
    const composed = composeDatabaseUrl(process.env);
    if (composed.invalid.length > 0) throw new InvalidConfigError([...composed.invalid].sort());
    if (composed.url) process.env.DATABASE_URL = composed.url;
    const schema = Joi.object(
      Object.fromEntries(DB_CONFIG_KEYS.map(key => [key, validationSchema.extract(key)])),
    );
    const validated = schema.validate(process.env, { abortEarly: false, allowUnknown: true });
    if (validated.error) {
      // Joi detail paths are variable names from the fixed list above, never values.
      const names = new Set<string>(DB_CONFIG_KEYS);
      const wrong = validated.error.details
        .map(detail => String(detail.path[0]))
        .filter(name => names.has(name));
      throw new InvalidConfigError([...new Set(wrong)].sort());
    }
    const env = validated.value as Pick<Env, (typeof DB_CONFIG_KEYS)[number]>;
    let url: URL;
    try {
      url = new URL(env.DATABASE_URL);
    } catch {
      throw new InvalidConfigError(['DATABASE_URL']);
    }
    // pg lets these URL fields replace the verified SSL object, including its configured CA.
    for (const key of url.searchParams.keys()) {
      if (key.toLowerCase().startsWith('ssl') || key.toLowerCase() === 'uselibpqcompat') {
        throw new InvalidConfigError(['DATABASE_URL']);
      }
    }
    let ssl: ReturnType<typeof buildSslOptions>;
    try {
      ssl = buildSslOptions({ enabled: env.DATABASE_SSL, caPath: env.DATABASE_SSL_CA_PATH });
    } catch {
      // The message names the CA path; only the variable name may leave this process.
      throw new InvalidConfigError(['DATABASE_SSL_CA_PATH']);
    }
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
      // An idle-client error that arrives after the commit cannot change a settled result.
      poolErrorHandler: (error: unknown) => {
        if (!committed) poolFailure ??= error;
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
    committed = true;
  } catch (error) {
    failure = error;
    if (error instanceof InvalidConfigError) invalid = error.invalid;
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
  // A pool error recorded before the commit means the connection was reported broken while the
  // result was being produced: that run is not trusted, even if the commit then succeeded.
  const trusted = committed && poolFailure === undefined && report !== undefined;
  failure ??= poolFailure;
  const printError = (error: unknown) => {
    const code = getErrorCode(error);
    const databaseCode =
      code && (/^[0-9A-Z]{5}$/.test(code) || NETWORK_CODES.has(code)) ? code : undefined;
    console.error(
      JSON.stringify({
        status: 'ERROR',
        kind,
        ...(invalid ? { invalid } : {}),
        ...(databaseCode ? { databaseCode } : {}),
      }),
    );
  };
  if (trusted && report) {
    // The result is settled, so it is always printed. A cleanup error afterwards is reported on
    // stderr; FAIL still exits 1, and a PASS with a cleanup error exits 2 (never "clean").
    console.log(JSON.stringify(report));
    if (failure) printError(failure);
    process.exitCode = report.status === 'FAIL' ? 1 : failure ? 2 : 0;
  } else if (failure) {
    printError(failure);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  // runCli contains all cleanup/error handling; imports never open a connection or load env.
  void runCli(process.argv.slice(2));
}
