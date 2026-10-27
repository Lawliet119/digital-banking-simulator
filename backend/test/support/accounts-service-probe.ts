import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { DataSource, type EntityManager, type Logger, type QueryRunner } from 'typeorm';
import type { AccountsService } from '@modules/accounts';
import { createTempDatabase, migrate, type TempDatabase } from './temp-database';

export const ACCOUNT_FIXTURE = {
  funding: '00000000-0000-4000-8000-000000000001',
  userA: '10000000-0000-4000-8000-000000000001',
  userB: '10000000-0000-4000-8000-000000000002',
  customerA: '20000000-0000-4000-8000-000000000001',
  customerB: '20000000-0000-4000-8000-000000000002',
  accountA: '3a000000-0000-4000-8000-000000000001',
  accountB: '3b000000-0000-4000-8000-000000000002',
  accountC: '3c000000-0000-4000-8000-000000000003',
  missing: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
} as const;

export interface QueryTrace {
  query: string;
  parameters: unknown[];
}

export interface AccountsFixture {
  source: DataSource;
  trace: QueryTrace[];
  close(): Promise<void>;
}

export async function createAccountsFixture(): Promise<AccountsFixture> {
  let database: TempDatabase | undefined;
  let source: DataSource | undefined;
  const trace: QueryTrace[] = [];
  const logger: Logger = {
    logQuery(query: string, parameters?: unknown[]) {
      trace.push({ query, parameters: parameters ?? [] });
    },
    logQueryError() {},
    logQuerySlow() {},
    logSchemaBuild() {},
    logMigration() {},
    log() {},
  };
  try {
    database = await createTempDatabase();
    await migrate(database.url);
    source = await new DataSource({
      type: 'postgres',
      url: database.url,
      extra: { max: 8 },
      logging: ['query'],
      logger,
    }).initialize();
    const f = ACCOUNT_FIXTURE;
    // These are input rows only. Money is never seeded: every account starts at its DB default 0.
    await source.query('INSERT INTO users (id, cognito_sub) VALUES ($1,$2),($3,$4)', [
      f.userA,
      'nguyen-an-local',
      f.userB,
      'tran-binh-local',
    ]);
    await source.query(
      'INSERT INTO customers (id,user_id,full_name) VALUES ($1,$2,$3),($4,$5,$6)',
      [f.customerA, f.userA, 'Nguyễn An', f.customerB, f.userB, 'Trần Bình'],
    );
    await source.query(
      `INSERT INTO accounts (id,customer_id,type,status)
       VALUES ($1,$2,'CHECKING','ACTIVE'),($3,$4,'SAVINGS','LOCKED'),($5,$2,'SAVINGS','ACTIVE')`,
      [f.accountA, f.customerA, f.accountB, f.customerB, f.accountC],
    );
    const readySource = source;
    const readyDatabase = database;
    return {
      source,
      trace,
      async close() {
        await readySource.destroy();
        await readyDatabase.drop();
      },
    };
  } catch (error) {
    if (source?.isInitialized) await source.destroy();
    await database?.drop();
    throw error;
  }
}

export async function startProbeRunner(source: DataSource): Promise<QueryRunner> {
  const runner = source.createQueryRunner();
  await runner.connect();
  await runner.startTransaction('READ COMMITTED');
  await runner.query("SET LOCAL lock_timeout = '5s'");
  await runner.query("SET LOCAL statement_timeout = '8s'");
  await runner.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
  return runner;
}

export async function closeProbeRunner(runner: QueryRunner): Promise<void> {
  if (runner.isReleased) return;
  try {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
  } finally {
    await runner.release();
  }
}

export async function withMoneyProbe<T>(
  source: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const runner = await startProbeRunner(source);
  try {
    return await work(runner.manager);
  } finally {
    await closeProbeRunner(runner);
    await assertAccountsInvariants(source);
  }
}

export async function assertAccountsInvariants(source: DataSource): Promise<void> {
  const [checks] = await source.query<
    {
      entries_equal: boolean;
      total_zero: boolean;
      customers_nonnegative: boolean;
      balances_match: boolean;
    }[]
  >(`SELECT
    (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DEBIT'),0) =
            COALESCE(SUM(amount) FILTER (WHERE direction='CREDIT'),0) FROM ledger_entries) AS entries_equal,
    (SELECT COALESCE(SUM(balance),0)=0 FROM accounts) AS total_zero,
    NOT EXISTS (SELECT 1 FROM accounts WHERE type<>'SYSTEM' AND balance<0) AS customers_nonnegative,
    NOT EXISTS (
      SELECT 1 FROM accounts a LEFT JOIN (
        SELECT account_id, SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END) AS net
        FROM ledger_entries GROUP BY account_id
      ) e ON e.account_id=a.id WHERE a.balance<>COALESCE(e.net,0)
    ) AS balances_match`);
  assert.deepEqual(checks, {
    entries_equal: true,
    total_zero: true,
    customers_nonnegative: true,
    balances_match: true,
  });
}

async function backendPid(runner: QueryRunner): Promise<number> {
  const [row] = (await runner.query('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
  return row.pid;
}

async function pollDatabase(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await setImmediate();
  }
  throw new Error(`Timed out observing ${description}`);
}

async function waitBlockedBy(source: DataSource, pid: number, blocker: number): Promise<void> {
  await pollDatabase(async () => {
    const [row] = await source.query<{ blockers: number[] }[]>(
      'SELECT pg_blocking_pids($1::int) AS blockers',
      [pid],
    );
    return row.blockers.includes(blocker);
  }, `backend ${pid} blocked by ${blocker}`);
}

export async function proveAccountLockOrder(source: DataSource, service: AccountsService) {
  const f = ACCOUNT_FIXTURE;
  const holder = await startProbeRunner(source);
  const subject = await startProbeRunner(source);
  const probe = await startProbeRunner(source);
  let pending: ReturnType<AccountsService['lockForUpdate']> | undefined;
  try {
    const holderPid = await backendPid(holder);
    const subjectPid = await backendPid(subject);
    await holder.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [f.accountA]);
    pending = service.lockForUpdate([f.accountB, f.accountA], subject.manager);
    void pending.catch(() => undefined);
    await waitBlockedBy(source, subjectPid, holderPid);
    const high = (await probe.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE NOWAIT', [
      f.accountB,
    ])) as { id: string }[];
    assert.equal(high[0].id, f.accountB);
    await closeProbeRunner(probe);
    await closeProbeRunner(holder);
    const rows = await pending;
    assert.deepEqual(
      rows.map(row => row.id),
      [f.accountA, f.accountB],
    );
    return { holderPid, subjectPid, highAvailable: true, ids: rows.map(row => row.id) };
  } finally {
    await closeProbeRunner(holder);
    await closeProbeRunner(probe);
    if (pending) await Promise.allSettled([pending]);
    await closeProbeRunner(subject);
  }
}

export async function proveCrossedAccountLocks(source: DataSource, service: AccountsService) {
  const f = ACCOUNT_FIXTURE;
  const holder = await startProbeRunner(source);
  const left = await startProbeRunner(source);
  const right = await startProbeRunner(source);
  const pending: Promise<unknown>[] = [];
  try {
    const leftPid = await backendPid(left);
    const rightPid = await backendPid(right);
    await holder.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [f.accountA]);
    let launch!: () => void;
    const barrier = new Promise<void>(resolve => {
      launch = resolve;
    });
    const a = barrier
      .then(() => service.lockForUpdate([f.accountA, f.accountB], left.manager))
      .then(rows => ({ runner: left, pid: leftPid, rows }));
    const b = barrier
      .then(() => service.lockForUpdate([f.accountB, f.accountA], right.manager))
      .then(rows => ({ runner: right, pid: rightPid, rows }));
    pending.push(a, b);
    void a.catch(() => undefined);
    void b.catch(() => undefined);
    launch();
    await pollDatabase(async () => {
      const rows = await source.query<{ wait_event_type: string }[]>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid=ANY($1::int[])',
        [[leftPid, rightPid]],
      );
      return rows.length === 2 && rows.every(row => row.wait_event_type === 'Lock');
    }, 'both opposing calls waiting on the low-account lock queue');
    await closeProbeRunner(holder);
    const winner = await Promise.race([a, b]);
    const loser =
      winner.runner === left ? { result: b, pid: rightPid } : { result: a, pid: leftPid };
    await waitBlockedBy(source, loser.pid, winner.pid);
    await winner.runner.commitTransaction();
    const second = await loser.result;
    await second.runner.commitTransaction();
    for (const result of [winner, second]) {
      assert.deepEqual(
        result.rows.map(row => row.id),
        [f.accountA, f.accountB],
      );
    }
    return { winnerPid: winner.pid, waitingPid: loser.pid, completed: 2, retries: 0 };
  } finally {
    await closeProbeRunner(holder);
    // Releasing either held winner lets the other query finish even after an assertion failure.
    await Promise.allSettled([closeProbeRunner(left), closeProbeRunner(right)]);
    await Promise.allSettled(pending);
  }
}
