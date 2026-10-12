import { randomBytes } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { createMigrationDataSource } from '@database/data-source';

const TEMP_NAME = /^dbs_test_[0-9a-f]{12}$/;

/**
 * The server the database tests run against. Jest sets NODE_ENV=test, so env/.env.development is
 * NOT loaded: the variable has to be in the environment. A missing database fails the run instead
 * of skipping it — a skipped constraint test would read as green.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start PostgreSQL with `docker compose up -d` and export ' +
        'DATABASE_URL (e.g. postgres://banking:banking_local_only@localhost:5432/banking).',
    );
  }
  return url;
}

async function connect(url: string): Promise<DataSource> {
  const dataSource = new DataSource({ type: 'postgres', url });
  try {
    return await dataSource.initialize();
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL at DATABASE_URL (${(error as Error).message}). ` +
        'Is `docker compose up -d` running?',
    );
  }
}

async function onServer(sql: string): Promise<void> {
  const server = await connect(requireDatabaseUrl());
  try {
    await server.query(sql);
  } finally {
    await server.destroy();
  }
}

export interface TempDatabase {
  name: string;
  url: string;
  /** One connection on the temp database (QueryRunner), released by drop(). */
  runner: QueryRunner;
  drop(): Promise<void>;
}

/** Creates an empty database `dbs_test_<random>` on the DATABASE_URL server. */
export async function createTempDatabase(): Promise<TempDatabase> {
  const name = `dbs_test_${randomBytes(6).toString('hex')}`;
  await onServer(`CREATE DATABASE ${name}`);

  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${name}`;
  const dataSource = await connect(url.toString());
  const runner = dataSource.createQueryRunner();
  await runner.connect();

  return {
    name,
    url: url.toString(),
    runner,
    async drop() {
      await runner.release();
      await dataSource.destroy();
      // Only ever drop a database this helper created.
      if (!TEMP_NAME.test(name)) throw new Error(`Refusing to drop ${name}`);
      await onServer(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

/** Runs the real migrations on `url` with the CLI's own DataSource configuration. */
export async function migrate(url: string, direction: 'up' | 'undoLast' = 'up'): Promise<void> {
  const dataSource = createMigrationDataSource(url);
  await dataSource.initialize();
  try {
    if (direction === 'up') await dataSource.runMigrations({ transaction: 'all' });
    else await dataSource.undoLastMigration({ transaction: 'all' });
  } finally {
    await dataSource.destroy();
  }
}

/**
 * Runs one statement inside a savepoint, so a rejected row leaves the surrounding test
 * transaction usable for the next attempt. Returns the rows. A rejection is TypeORM's
 * QueryFailedError, which carries pg's `code` and `constraint`.
 */
export async function attempt<T = Record<string, unknown>>(
  runner: QueryRunner,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await runner.query('SAVEPOINT attempt');
  try {
    const rows = (await runner.query(sql, params)) as T[];
    await runner.query('RELEASE SAVEPOINT attempt');
    return rows;
  } catch (error) {
    await runner.query('ROLLBACK TO SAVEPOINT attempt');
    throw error;
  }
}
