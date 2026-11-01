import { setTimeout as delay } from 'node:timers/promises';
import type { ConfigType } from '@nestjs/config';
import { DataSource, type QueryRunner } from 'typeorm';
import type { databaseConfig } from '@config/database.config';
import { TransactionService } from '@database/transaction.service';
import { IdentityService } from '@modules/identity';
import { createTempDatabase, migrate, type TempDatabase } from './temp-database';

/** Marks the sessions of the racing IdentityServices, so the poll never counts anyone else's. */
export const RACE_APP_NAME = 'dbs52-race';
const HOLDER_APP_NAME = 'dbs52-holder';
const ADMIN_APP_NAME = 'dbs52-admin';

export interface ServiceOptions {
  applicationName?: string;
  /** Default 30 s: longer than the poll deadline, so a slow CI runner cannot kill the earliest
   * waiter with 55P03 before the poll sees all of them. */
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  poolMax?: number;
}

export interface Holder {
  /** `users.id` of the uncommitted row: the id every waiter must end up with after COMMIT. */
  id: string;
  pid: number;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface IdentityUsersFixture {
  /** A plain connection for counting rows and polling pg_stat_activity. */
  admin: DataSource;
  newService(options?: ServiceOptions): Promise<{ service: IdentityService; source: DataSource }>;
  /** Opens a transaction that INSERTs `sub` into users and leaves it uncommitted. */
  openHolder(sub: string): Promise<Holder>;
  countUsers(subs: string[]): Promise<number>;
  close(): Promise<void>;
}

export async function createIdentityUsersFixture(): Promise<IdentityUsersFixture> {
  const database: TempDatabase = await createTempDatabase();
  const sources: DataSource[] = [];
  const holders: QueryRunner[] = [];

  const open = async (applicationName: string, poolMax: number): Promise<DataSource> => {
    const source = await new DataSource({
      type: 'postgres',
      url: database.url,
      applicationName,
      extra: { max: poolMax },
    }).initialize();
    sources.push(source);
    return source;
  };

  try {
    await migrate(database.url);
    const admin = await open(ADMIN_APP_NAME, 2);

    return {
      admin,

      async newService(options = {}) {
        const source = await open(options.applicationName ?? RACE_APP_NAME, options.poolMax ?? 2);
        const timeout = options.lockTimeoutMs ?? 30_000;
        const config = {
          lockTimeoutMs: timeout,
          statementTimeoutMs: options.statementTimeoutMs ?? 30_000,
          idleInTransactionTimeoutMs: 60_000,
        } as unknown as ConfigType<typeof databaseConfig>;
        return { service: new IdentityService(new TransactionService(source, config)), source };
      },

      async openHolder(sub) {
        const source = await open(HOLDER_APP_NAME, 1);
        const runner = source.createQueryRunner();
        holders.push(runner);
        await runner.connect();
        await runner.startTransaction();
        // runner.manager is bound to this runner's connection, so both statements stay inside the
        // transaction opened above (and, unlike QueryRunner.query, it accepts a result type).
        const [{ pid }] = await runner.manager.query<{ pid: number }[]>(
          'SELECT pg_backend_pid() AS pid',
        );
        const [{ id }] = await runner.manager.query<{ id: string }[]>(
          'INSERT INTO users (cognito_sub) VALUES ($1) RETURNING id',
          [sub],
        );
        return {
          id,
          pid,
          commit: () => runner.commitTransaction(),
          rollback: () => runner.rollbackTransaction(),
        };
      },

      async countUsers(subs) {
        const [{ count }] = await admin.query<{ count: number }[]>(
          'SELECT count(*)::int AS count FROM users WHERE cognito_sub = ANY($1::text[])',
          [subs],
        );
        return count;
      },

      async close() {
        // A holder left open by a failed test would block DROP DATABASE: release it first.
        await Promise.allSettled(holders.map(runner => runner.release()));
        await Promise.allSettled(sources.map(source => source.destroy()));
        await database.drop();
      },
    };
  } catch (error) {
    await Promise.allSettled(sources.map(source => source.destroy()));
    await database.drop();
    throw error;
  }
}

/**
 * Waits until `expected` sessions are blocked on the holder's uncommitted INSERT. This is what
 * makes the race real: without it, 20 parallel calls could still run one after another and pass
 * without ever meeting a conflict. Filtered by database, application_name, wait event and the
 * holder's pid because `test:db` runs other suites against the same server.
 */
export async function waitForLockWaiters(
  admin: DataSource,
  holderPid: number,
  expected: number,
  deadlineMs = 10_000,
): Promise<void> {
  const started = Date.now();
  let seen = 0;
  while (Date.now() - started < deadlineMs) {
    const [{ count }] = await admin.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> $1 AND application_name = $2
         AND wait_event_type = 'Lock' AND wait_event = 'transactionid'`,
      [holderPid, RACE_APP_NAME],
    );
    seen = count;
    if (seen >= expected) return;
    await delay(25);
  }
  throw new Error(
    `Only ${seen} of ${expected} sessions were waiting on the holder's INSERT after ${deadlineMs} ms: the calls did not all reach the database, so the race was never exercised.`,
  );
}
