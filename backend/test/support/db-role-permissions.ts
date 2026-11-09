import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { migrate } from './temp-database';
import { startDepositApp } from './deposit-app';
import { checkLedgerInvariants } from './invariants';
import {
  assertDockerAvailable,
  awaitContainerStart,
  STARTUP_TIMEOUT_MS,
} from './postgres.container';

export const protectedMutations: [string, string, string][] = [
  ['UPDATE', 'ledger_entries', 'amount'],
  ['DELETE', 'ledger_entries', 'amount'],
  ['UPDATE', 'transfers', 'amount'],
  ['DELETE', 'transfers', 'amount'],
  ['UPDATE', 'audit_log', 'action'],
  ['DELETE', 'audit_log', 'action'],
];

interface TransferFact {
  id: string;
  correlationId: string;
  fromAccountId: string;
  toAccountId: string;
  initiatedBy: string;
}

export interface RolePermissionsFixture {
  owner: DataSource;
  api: DataSource;
  worker: DataSource;
  app: Awaited<ReturnType<typeof startDepositApp>>;
  accounts: string[];
  transfers: TransferFact[];
  initialMoney: string;
  containerId: string;
  close(): Promise<void>;
}

/** Always rolls back, including when a forbidden command unexpectedly succeeds. */
export async function rollbackProbe(
  source: DataSource,
  sql: string,
  args: unknown[] = [],
): Promise<void> {
  const runner = source.createQueryRunner();
  try {
    await runner.connect();
    await runner.startTransaction();
    await runner.query(sql, args);
  } finally {
    try {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
    } finally {
      await runner.release();
    }
  }
}

/** SQLSTATE alone is insufficient: forbid_mutation also uses 42501. */
export async function expectAclDenied(
  source: DataSource,
  sql: string,
  args: unknown[] = [],
): Promise<string> {
  let failure: unknown;
  try {
    await rollbackProbe(source, sql, args);
  } catch (error) {
    failure = error;
  }
  if (!failure) throw new Error('Forbidden statement unexpectedly succeeded');
  const pg = failure as { code?: string; where?: string; routine?: string };
  assert.equal(
    pg.code,
    '42501',
    'Expected PostgreSQL insufficient_privilege, not constraint/syntax failure',
  );
  assert.doesNotMatch(pg.where ?? '', /forbid_mutation/i, 'Append-only trigger is not ACL denial');
  assert.equal(
    pg.routine,
    'aclcheck_error',
    'Expected PostgreSQL ACL check to reject the statement',
  );
  assert.deepEqual(await source.query('SELECT 1 AS recovered'), [{ recovered: 1 }]);
  return pg.code;
}

export async function assertRuntimeRole(source: DataSource, expected: 'dbs_api' | 'dbs_worker') {
  const [role] = await source.query<
    {
      current_user: string;
      session_user: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolbypassrls: boolean;
      owns_tables: boolean;
      inherits_role: boolean;
    }[]
  >(`SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
      EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace
        AND relkind IN ('r','v','p') AND relowner=r.oid) AS owns_tables,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS inherits_role
    FROM pg_roles r WHERE rolname=current_user`);
  assert.deepEqual(role, {
    current_user: expected,
    session_user: expected,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolbypassrls: false,
    owns_tables: false,
    inherits_role: false,
  });
  return role;
}

export async function moneySnapshot(owner: DataSource): Promise<string> {
  const rows = [];
  for (const table of ['accounts', 'transfers', 'ledger_entries']) {
    rows.push(await owner.query(`SELECT * FROM ${table} ORDER BY id`));
  }
  return JSON.stringify(rows);
}

export async function assertMoneyUnchanged(fixture: RolePermissionsFixture): Promise<void> {
  assert.equal(
    await moneySnapshot(fixture.owner),
    fixture.initialMoney,
    'Financial rows must remain unchanged',
  );
  const runner = fixture.owner.createQueryRunner();
  try {
    await runner.connect();
    const report = await checkLedgerInvariants(runner);
    assert.equal(report.status, 'PASS', JSON.stringify(report));
    assert.equal(report.totals.debit, '1006000');
    assert.equal(report.totals.credit, '1006000');
  } finally {
    await runner.release();
  }
}

export function flagInsert(transferId: string) {
  return {
    sql: "INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,75,'HIGH',1)",
    args: [transferId],
  };
}

/** This raw INSERT is the operation under test, never financial setup. Rollback is mandatory. */
export function transferInsert(fixture: RolePermissionsFixture, id: string) {
  const transfer = fixture.transfers[0];
  return {
    sql: `INSERT INTO transfers(id,type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id)
      VALUES($1,'TRANSFER',$2,$3,1000,'COMPLETED',$4,$5)`,
    args: [id, transfer.fromAccountId, transfer.toAccountId, transfer.initiatedBy, randomUUID()],
  };
}

/** Permission-test INPUT, not a fake consumer result. No RETURNING: worker has no audit SELECT. */
export function auditInsert(transfer: TransferFact) {
  return {
    sql: `INSERT INTO audit_log(actor_role,action,outcome,target_type,target_id,correlation_id)
      VALUES('worker','fraud.flagged','SUCCESS','transfer',$1,$2)`,
    args: [transfer.id, transfer.correlationId],
  };
}

/** Own cluster: no role credential/GRANT mutation can affect Compose or Jest's global server. */
export async function createRolePermissionsFixture(): Promise<RolePermissionsFixture> {
  let container: StartedPostgreSqlContainer | undefined;
  let app: Awaited<ReturnType<typeof startDepositApp>> | undefined;
  const sources: DataSource[] = [];
  const close = async () => {
    const errors: unknown[] = [];
    try {
      await app?.close();
    } catch (error) {
      errors.push(error);
    }
    for (const source of [...sources].reverse()) {
      try {
        if (source.isInitialized) await source.destroy();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await container?.stop();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'DBS-122 fixture cleanup failed');
  };
  try {
    await assertDockerAvailable(undefined, 'DBS-122 role permissions');
    container = await awaitContainerStart(
      new PostgreSqlContainer('postgres:17-alpine')
        .withEnvironment({ TZ: 'UTC' })
        .withCommand(['postgres', '-c', 'timezone=UTC'])
        .withStartupTimeout(STARTUP_TIMEOUT_MS)
        .start(),
      '[Testcontainers] DBS-122 isolated PostgreSQL startup timed out; check Docker/image pull.',
    );
    const url = container.getConnectionUri();
    await migrate(url);
    const connect = async (connectionUrl: string) => {
      const source = new DataSource({ type: 'postgres', url: connectionUrl });
      sources.push(source);
      return source.initialize();
    };
    const owner = await connect(url);
    const urls = {} as Record<'dbs_api' | 'dbs_worker', string>;
    for (const role of ['dbs_api', 'dbs_worker'] as const) {
      const password = randomBytes(24).toString('hex');
      // Identifiers are a fixed allowlist; password is generated hex, never logged or persisted.
      await owner.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      const runtime = new URL(url);
      runtime.username = role;
      runtime.password = password;
      urls[role] = runtime.toString();
    }
    const api = await connect(urls.dbs_api),
      worker = await connect(urls.dbs_worker);
    await assertRuntimeRole(api, 'dbs_api');
    await assertRuntimeRole(worker, 'dbs_worker');
    app = await startDepositApp(urls.dbs_api);
    const httpApp = app;
    const post = async (
      path: string,
      token: string,
      body: unknown,
      expected: number,
      idempotent = false,
    ) => {
      const response = await fetch(`${httpApp.url}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(idempotent ? { 'Idempotency-Key': randomUUID() } : {}),
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, expected, `${path}: unexpected status ${response.status}`);
      const result = (await response.json()) as Record<string, string>;
      return { result, correlationId: response.headers.get('x-correlation-id')! };
    };
    const tokens: string[] = [],
      accounts: string[] = [];
    for (let i = 0; i < 2; i++) {
      const token = await app.issuer.token('customer', { sub: randomUUID() });
      tokens.push(token);
      await post('/v1/customers/me', token, { fullName: 'Nguyen Minh Anh' }, 200);
      const opened = await post('/v1/accounts', token, { type: 'CHECKING' }, 201);
      assert.match(opened.result.id, /^[0-9a-f-]{36}$/);
      accounts.push(opened.result.id);
    }
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    await post(
      '/v1/operator/deposits',
      operator,
      { toAccountId: accounts[0], amount: '1000000' },
      201,
      true,
    );
    const transfers: TransferFact[] = [];
    for (const amount of ['1000', '2000', '3000']) {
      const response = await post(
        '/v1/transfers',
        tokens[0],
        {
          fromAccountId: accounts[0],
          toAccountId: accounts[1],
          amount,
        },
        201,
        true,
      );
      const [row] = await owner.query<{ initiated_by: string }[]>(
        'SELECT initiated_by FROM transfers WHERE id=$1',
        [response.result.transferId],
      );
      assert.match(response.correlationId, /^[0-9a-f-]{36}$/);
      transfers.push({
        id: response.result.transferId,
        correlationId: response.correlationId,
        fromAccountId: accounts[0],
        toAccountId: accounts[1],
        initiatedBy: row.initiated_by,
      });
    }
    const fixture = {
      owner,
      api,
      worker,
      app,
      accounts,
      transfers,
      initialMoney: await moneySnapshot(owner),
      containerId: container.getId(),
      close,
    };
    await assertMoneyUnchanged(fixture);
    return fixture;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'DBS-122 setup and cleanup failed');
    }
    throw error;
  }
}
