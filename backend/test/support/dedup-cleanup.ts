import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { Clock } from '@common/clock';
import { TransactionService } from '@database/transaction.service';
import { OutboxCleanupService, type CleanupResult } from '@modules/outbox/outbox-cleanup.service';
import {
  assertDockerAvailable,
  awaitContainerStart,
  STARTUP_TIMEOUT_MS,
  withTimeout,
} from './postgres.container';
import { migrate } from './temp-database';
import { startDepositApp } from './deposit-app';
import { checkLedgerInvariants } from './invariants';

export const DAY = 86_400_000;
export class CleanupClock extends Clock {
  instant = new Date('2030-01-20T00:00:00.000Z');
  now() {
    return new Date(this.instant);
  }
}

/** Private cluster: changing fixture LOGIN passwords cannot touch another suite or Compose. */
export async function createDedupCleanupFixture() {
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
    if (errors.length) throw new AggregateError(errors, 'DBS-136 fixture cleanup failed');
  };
  try {
    await assertDockerAvailable(undefined, 'DBS-136 dedup cleanup');
    container = await awaitContainerStart(
      new PostgreSqlContainer('postgres:17-alpine').withStartupTimeout(STARTUP_TIMEOUT_MS).start(),
      '[Testcontainers] DBS-136 PostgreSQL startup timed out; check Docker and image pull.',
    );
    const url = container.getConnectionUri();
    await migrate(url);
    const connect = async (connectionUrl: string, applicationName: string) => {
      const source = new DataSource({
        type: 'postgres',
        url: connectionUrl,
        extra: { application_name: applicationName },
      });
      sources.push(source);
      return source.initialize();
    };
    const owner = await connect(url, 'dbs136-owner');
    const urls = {} as Record<'dbs_api' | 'dbs_worker', string>;
    for (const role of ['dbs_api', 'dbs_worker'] as const) {
      const password = randomBytes(24).toString('hex');
      await owner.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      const runtime = new URL(url);
      runtime.username = role;
      runtime.password = password;
      urls[role] = runtime.toString();
    }
    const worker = await connect(urls.dbs_worker, 'dbs136-worker');
    const [role] = await worker.query(
      `SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user`,
    );
    assert.deepEqual(role, {
      current_user: 'dbs_worker',
      session_user: 'dbs_worker',
      rolsuper: false,
    });
    app = await startDepositApp(urls.dbs_api);
    const httpApp = app;
    const customerToken = await app.issuer.token('customer', { sub: randomUUID() });
    const operatorSub = randomUUID();
    const operatorToken = await app.issuer.token('operator', { sub: operatorSub });
    const http = async (
      method: string,
      path: string,
      token: string,
      body: unknown,
      status: number,
      key?: string,
    ) => {
      const response = await fetch(`${httpApp.url}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, status, `${path}: unexpected HTTP status`);
      return (await response.json()) as Record<string, string>;
    };
    await http('POST', '/v1/customers/me', customerToken, { fullName: 'Nguyễn Minh Anh' }, 200);
    const account = await http('POST', '/v1/accounts', customerToken, { type: 'CHECKING' }, 201);
    await http('GET', '/v1/identity/me', operatorToken, undefined, 200);
    const [{ id: actor }] = await owner.query<{ id: string }[]>(
      'SELECT id FROM users WHERE cognito_sub=$1',
      [operatorSub],
    );
    const base = new Date('2030-01-20T00:00:00.000Z'),
      clock = new CleanupClock();
    const job = (idempotencyDays = 7, processedEventsDays = 7) =>
      new OutboxCleanupService(
        new TransactionService(worker, {
          lockTimeoutMs: 60_000,
          statementTimeoutMs: 60_000,
          idleInTransactionTimeoutMs: 60_000,
        } as never),
        {
          idempotencyKeyRetentionDays: idempotencyDays,
          outbox: { retentionDays: 7, processedEventsRetentionDays: processedEventsDays },
        } as never,
        clock,
      );
    /** SQL INPUT rows of the cleanup job, never balances/ledger/transfer setup. */
    const seed = async (label: string, when: Date, offset = '0 seconds') => {
      await owner.query(
        `INSERT INTO idempotency_keys(user_id,idem_key,request_hash,response_code,response_body,created_at)
        VALUES($1,$2,$3,201,'{}',$4::timestamptz+$5::interval)`,
        [actor, label, 'a'.repeat(64), when, offset],
      );
      await owner.query(
        `INSERT INTO processed_events(consumer,event_id,processed_at)
        VALUES($1,$2,$3::timestamptz+$4::interval)`,
        [label, randomUUID(), when, offset],
      );
    };
    const seedAge = (label: string, days: number) =>
      seed(label, new Date(base.getTime() - days * DAY));
    const counts = async () => {
      const [row] = await owner.query<{ keys: number; marks: number }[]>(`SELECT
        (SELECT count(*)::int FROM idempotency_keys) AS keys,
        (SELECT count(*)::int FROM processed_events) AS marks`);
      return row;
    };
    const invariants = async () => {
      const runner = owner.createQueryRunner();
      try {
        await runner.connect();
        const report = await checkLedgerInvariants(runner);
        assert.equal(report.status, 'PASS', JSON.stringify(report));
      } finally {
        await runner.release();
      }
    };
    const lifecycle = async (role: 'api' | 'worker') => {
      const previous = process.env.APP_ROLE;
      const cleaner = job();
      try {
        process.env.APP_ROLE = role;
        if (role === 'api') {
          cleaner.onApplicationBootstrap();
          const state = cleaner as unknown as { loop: { isRunning: boolean } };
          assert.equal(state.loop.isRunning, false);
          return;
        }
        const first = new Promise<CleanupResult>((resolve, reject) => {
          cleaner.afterRun = result => (result instanceof Error ? reject(result) : resolve(result));
        });
        cleaner.onApplicationBootstrap();
        return await withTimeout(first, 15000, 'DBS-136 worker lifecycle did not finish a run');
      } finally {
        await cleaner.onApplicationShutdown();
        if (previous === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = previous;
      }
    };
    return {
      owner,
      worker,
      app,
      base,
      clock,
      job,
      seedAge,
      counts,
      invariants,
      lifecycle,
      close,
      accountId: account.id,
      containerId: container.getId(),
      async reset() {
        await owner.query('DELETE FROM idempotency_keys');
        await owner.query('DELETE FROM processed_events');
        clock.instant = new Date(base);
      },
      async seedBoundaries() {
        const boundary = new Date(base.getTime() - 7 * DAY);
        await seed('old', boundary, '-1 microsecond');
        await seed('boundary', boundary);
        await seed('fresh', boundary, '1 microsecond');
      },
      async seedMany(n: number) {
        for (let i = 0; i < n; i++) await seedAge(`record-${i}`, 8);
      },
      async labels() {
        const keys = await owner.query<{ label: string }[]>(
          'SELECT idem_key AS label FROM idempotency_keys ORDER BY idem_key',
        );
        const marks = await owner.query<{ label: string }[]>(
          'SELECT consumer AS label FROM processed_events ORDER BY consumer',
        );
        return { keys: keys.map(r => r.label), marks: marks.map(r => r.label) };
      },
      async seedPlanRows() {
        await owner.query(
          `INSERT INTO idempotency_keys(user_id,idem_key,request_hash,created_at)
          SELECT $1,'plan-'||g,$2,$3::timestamptz-make_interval(mins=>g) FROM generate_series(1,30000) g`,
          [actor, 'a'.repeat(64), base],
        );
        await owner.query(
          `INSERT INTO processed_events(consumer,event_id,processed_at)
          SELECT 'plan',gen_random_uuid(),$1::timestamptz-make_interval(mins=>g) FROM generate_series(1,30000) g`,
          [base],
        );
        await owner.query('ANALYZE idempotency_keys');
        await owner.query('ANALYZE processed_events');
      },
      deposit(key: string) {
        return http(
          'POST',
          '/v1/operator/deposits',
          operatorToken,
          { toAccountId: account.id, amount: '1000000' },
          201,
          key,
        );
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'DBS-136 setup/cleanup failed');
    }
    throw error;
  }
}
export type DedupCleanupFixture = Awaited<ReturnType<typeof createDedupCleanupFixture>>;
