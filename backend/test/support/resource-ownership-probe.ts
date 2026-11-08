import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Global,
  HttpException,
  Module,
  type ArgumentsHost,
  type DynamicModule,
  type INestApplicationContext,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { appConfig } from '@config/app.config';
import { authConfig } from '@config/auth.config';
import { LOCAL_CLIENT_ID, LOCAL_ISSUER } from '@config/auth-local';
import { TransactionService } from '@database/transaction.service';
import { ProblemDetailsFilter, type ProblemDetails } from '@common/filters/problem-details.filter';
import { getErrorCode } from '@common/utils/pg-error.util';
import { AccountsModule, AccountsService, type AccountOwnershipContext } from '@modules/accounts';
import { AuditService } from '@modules/audit';
import {
  ACCOUNT_FIXTURE as f,
  createAccountsFixture,
  type AccountsFixture,
  type QueryTrace,
} from './accounts-service-probe';
import { checkLedgerInvariants } from './invariants';

export async function ownershipInvariants(source: DataSource) {
  const runner = source.createQueryRunner();
  try {
    await runner.connect();
    return await checkLedgerInvariants(runner);
  } finally {
    await runner.release();
  }
}

export function ownershipContext(
  overrides: Partial<AccountOwnershipContext> = {},
): AccountOwnershipContext {
  return {
    userId: f.userA,
    role: 'customer',
    action: 'account.read',
    correlationId: randomUUID(),
    ...overrides,
  };
}

function sourceUrl(source: DataSource): string {
  const options = source.options;
  if (!('url' in options) || typeof options.url !== 'string') {
    throw new Error('The ownership fixture requires a PostgreSQL URL');
  }
  return options.url;
}

export function ownershipTransactions(source: DataSource): TransactionService {
  return new TransactionService(source, {
    url: sourceUrl(source),
    poolMax: 16,
    ssl: false,
    sslCaPath: undefined,
    lockTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    idleInTransactionTimeoutMs: 10_000,
  });
}

/** Both providers are the real classes, shared globally as DatabaseModule does in the app. */
@Global()
@Module({})
export class OwnershipProbeDatabaseModule {
  static forSource(source: DataSource): DynamicModule {
    return {
      module: OwnershipProbeDatabaseModule,
      providers: [
        {
          provide: appConfig.KEY,
          useValue: {
            role: 'api' as const,
            logLevel: 'fatal',
            trustProxyHops: 0,
            corsOrigins: [],
            isProduction: false,
          },
        },
        {
          provide: authConfig.KEY,
          useValue: {
            local: undefined,
            cognito: { clientId: LOCAL_CLIENT_ID, issuer: LOCAL_ISSUER, jwksCooldownMs: 60000 },
            accessTokenTtlSeconds: 900,
          },
        },
        { provide: DataSource, useValue: source },
        { provide: TransactionService, useValue: ownershipTransactions(source) },
      ],
      exports: [appConfig.KEY, authConfig.KEY, DataSource, TransactionService],
    };
  }
}

@Module({})
class OwnershipProbeModule {}

export interface OwnershipFixture {
  databaseName: string;
  source: DataSource;
  observer: DataSource;
  trace: QueryTrace[];
  context: INestApplicationContext;
  accounts: AccountsService;
  audit: AuditService;
  tx: TransactionService;
  close(): Promise<void>;
}

export async function createOwnershipFixture(): Promise<OwnershipFixture> {
  let seed: AccountsFixture | undefined;
  let source: DataSource | undefined;
  let context: INestApplicationContext | undefined;
  try {
    seed = await createAccountsFixture();
    // The ten-call burst must not prove isolation merely by exhausting an eight-client pool.
    source = await new DataSource({
      ...seed.source.options,
      extra: { max: 16, connectionTimeoutMillis: 5000 },
    }).initialize();
    await source.query('CREATE TABLE ownership_scratch (id uuid PRIMARY KEY)');
    context = await NestFactory.createApplicationContext(
      {
        module: OwnershipProbeModule,
        imports: [OwnershipProbeDatabaseModule.forSource(source), AccountsModule],
      },
      { logger: false, abortOnError: false },
    );
    const readySource = source;
    const readySeed = seed;
    const readyContext = context;
    return {
      databaseName: new URL(sourceUrl(source)).pathname.slice(1),
      source,
      observer: seed.source,
      trace: seed.trace,
      context,
      accounts: context.get(AccountsService),
      audit: context.get(AuditService),
      tx: context.get(TransactionService),
      async close() {
        const results = [
          ...(await Promise.allSettled([readyContext.close()])),
          ...(await Promise.allSettled([readySource.destroy()])),
          ...(await Promise.allSettled([readySeed.close()])),
        ];
        cleanupResult(results);
      },
    };
  } catch (error) {
    if (context) await Promise.allSettled([context.close()]);
    if (source?.isInitialized) await Promise.allSettled([source.destroy()]);
    if (seed) await Promise.allSettled([seed.close()]);
    throw error;
  }
}

function cleanupResult(results: PromiseSettledResult<unknown>[]): void {
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export async function rejected(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('The ownership operation unexpectedly succeeded');
}

export interface OwnershipAuditRow {
  id: string;
  actor: string;
  role: string;
  action: string;
  outcome: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  metadata: { reason: string };
}

export function ownershipAuditRows(source: DataSource, correlationId: string) {
  return source.query<OwnershipAuditRow[]>(
    `SELECT id::text, actor_user_id AS actor, actor_role AS role, action, outcome,
      target_type AS "targetType", target_id AS "targetId",
      correlation_id AS "correlationId", metadata
     FROM audit_log WHERE correlation_id=$1::uuid ORDER BY id`,
    [correlationId],
  );
}

/** Exercise the existing formatter on the real service error; this is not an HTTP endpoint. */
export function ownershipProblem(error: unknown, correlationId: string): ProblemDetails {
  let body: ProblemDetails | undefined;
  const response = {
    setHeader() {},
    status() {
      return this;
    },
    type() {
      return this;
    },
    json(value: ProblemDetails) {
      body = value;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ correlationId }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(error, host);
  assert(body);
  return body;
}

export function safeOwnershipFailure(error: unknown) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(error instanceof HttpException ? { status: error.getStatus() } : {}),
    ...(getErrorCode(error) ? { code: getErrorCode(error) } : {}),
  };
}

export function accountLookups(trace: QueryTrace[]): QueryTrace[] {
  return trace.filter(row => /FROM accounts a\s+JOIN customers c/.test(row.query));
}

export interface OwnershipRole {
  name: string;
  accounts: AccountsService;
  grantAuditInsert(): Promise<void>;
  revokeAccountSelect(): Promise<void>;
  close(): Promise<void>;
}

export async function createOwnershipRole(fixture: OwnershipFixture): Promise<OwnershipRole> {
  const name = `dbs_ownership_${randomBytes(6).toString('hex')}`;
  assert.match(name, /^dbs_ownership_[0-9a-f]{12}$/);
  const password = randomBytes(24).toString('hex');
  const url = new URL(sourceUrl(fixture.source));
  const database = url.pathname.slice(1);
  assert.match(database, /^dbs_test_[0-9a-f]{12}$/);
  // Do not put the generated password into the query-trace logger, a transcript or an assertion.
  const admin = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
  let source: DataSource | undefined;
  let created = false;
  const removeRole = async () => {
    if (created) {
      await admin.query(`DROP OWNED BY ${name}`);
      await admin.query(`DROP ROLE ${name}`);
      created = false;
    }
  };
  try {
    await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER PASSWORD '${password}'`);
    created = true;
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${name}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${name}`);
    await admin.query(`GRANT SELECT ON accounts,customers TO ${name}`);
    url.username = name;
    url.password = password;
    source = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
    const readySource = source;
    return {
      name,
      accounts: new AccountsService(source, new AuditService(ownershipTransactions(source))),
      async grantAuditInsert() {
        await admin.query(`GRANT INSERT ON audit_log TO ${name}`);
        await admin.query(`GRANT USAGE,SELECT ON SEQUENCE audit_log_id_seq TO ${name}`);
      },
      async revokeAccountSelect() {
        await admin.query(`REVOKE SELECT ON accounts FROM ${name}`);
      },
      async close() {
        const closed = await Promise.allSettled([readySource.destroy()]);
        const removed = await Promise.allSettled([removeRole()]);
        const adminClosed = await Promise.allSettled([admin.destroy()]);
        cleanupResult([...closed, ...removed, ...adminClosed]);
      },
    };
  } catch (error) {
    if (source?.isInitialized) await Promise.allSettled([source.destroy()]);
    await Promise.allSettled([removeRole()]);
    await Promise.allSettled([admin.destroy()]);
    throw error;
  }
}

export async function proveOwnershipSnapshot(fixture: OwnershipFixture) {
  const original = ownershipContext();
  const values = { ...original };
  const reads = { userId: 0, role: 0, action: 0, correlationId: 0 };
  let serialized = false;
  const context = {
    get userId() {
      reads.userId++;
      return values.userId;
    },
    get role() {
      reads.role++;
      return values.role;
    },
    get action() {
      reads.action++;
      return values.action;
    },
    get correlationId() {
      reads.correlationId++;
      return values.correlationId;
    },
    toJSON() {
      serialized = true;
      return { email: 'khong-luu@example.invalid' };
    },
  };
  const holder = fixture.source.createQueryRunner();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.connect();
    await holder.startTransaction();
    await holder.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    const [{ pid }] = (await holder.query('SELECT pg_backend_pid() AS pid')) as {
      pid: number;
    }[];
    await holder.query('LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE');
    pending = rejected(fixture.accounts.getOwnedAccount(f.accountB, context));
    void pending.catch(() => undefined);
    const deadline = performance.now() + 4000;
    let waiting = false;
    while (performance.now() < deadline) {
      const [{ blocked }] = await fixture.observer.query<{ blocked: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
         WHERE datname=current_database() AND wait_event_type='Lock'
           AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM accounts a%') AS blocked`,
        [pid],
      );
      if (blocked) {
        waiting = true;
        break;
      }
      // Catalog observation, never an assumed delay standing in for the lock barrier.
      await delay(15);
    }
    assert(waiting, 'The ownership SELECT never reached the PostgreSQL lock barrier');
    values.userId = f.userB;
    values.action = 'ledger.transfer';
    values.correlationId = randomUUID();
    await holder.commitTransaction();
    const error = await pending;
    return {
      original,
      changedCorrelationId: values.correlationId,
      reads,
      serialized,
      error,
      rows: await ownershipAuditRows(fixture.observer, original.correlationId),
    };
  } finally {
    if (holder.isTransactionActive) await holder.rollbackTransaction();
    await holder.release();
    if (pending) await pending;
  }
}
