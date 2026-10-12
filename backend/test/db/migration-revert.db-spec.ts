import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const BACKEND_DIR = resolve(__dirname, '..', '..');
const FUNDING_ID = '00000000-0000-4000-8000-000000000001';

/** Runs an npm script exactly as a developer or the pipeline would, against `url`. */
function npmRun(script: string, url: string): void {
  // npm sets npm_execpath to its own CLI script. Running that with node avoids a shell, which
  // Windows would otherwise need for npm.cmd.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run these tests through `npm run test:db`.');
  execFileSync(process.execPath, [npmCli, 'run', script], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

describe('migration 1: run, revert, run', () => {
  let db: TempDatabase;

  afterEach(async () => {
    await db?.drop();
  });

  async function tables(): Promise<string[]> {
    const rows = (await db.runner.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('users', 'customers', 'accounts')
        ORDER BY table_name`,
    )) as { table_name: string }[];
    return rows.map(r => r.table_name);
  }

  async function appliedMigrations(): Promise<string[]> {
    const rows = (await db.runner.query('SELECT name FROM migrations')) as { name: string }[];
    return rows.map(r => r.name);
  }

  it('TC-20-13 migration:run → migration:revert → migration:run is green on an empty database', async () => {
    db = await createTempDatabase();

    npmRun('migration:run', db.url);
    expect(await tables()).toEqual(['accounts', 'customers', 'users']);

    npmRun('migration:revert', db.url);
    expect(await tables()).toEqual([]);
    expect(await appliedMigrations()).toEqual([]);

    npmRun('migration:run', db.url);
    expect(await tables()).toEqual(['accounts', 'customers', 'users']);
    expect(await appliedMigrations()).toEqual(['CreateUsersCustomersAccounts1791763200000']);
    expect(await db.runner.query('SELECT id, type, balance FROM accounts')).toEqual([
      { id: FUNDING_ID, type: 'SYSTEM', balance: '0' },
    ]);
  });

  it('TC-20-18 refuses to revert, and drops nothing, once the tables hold data', async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    const q = (sql: string) => db.runner.query(sql);

    // A user and a customer exist.
    await q(
      `INSERT INTO users (id, cognito_sub) VALUES ('11111111-1111-4111-8111-111111111111', 'sub-a')`,
    );
    await q(
      `INSERT INTO customers (user_id, full_name) VALUES ('11111111-1111-4111-8111-111111111111', 'A')`,
    );
    await expect(migrate(db.url, 'undoLast')).rejects.toThrow(/Refusing to revert/);
    expect(await tables()).toEqual(['accounts', 'customers', 'users']);
    expect(await appliedMigrations()).toEqual(['CreateUsersCustomersAccounts1791763200000']);

    // Only the funding account is left, but it has moved money.
    await q('DELETE FROM customers');
    await q('DELETE FROM users');
    await q(`UPDATE accounts SET balance = -1 WHERE id = '${FUNDING_ID}'`);
    await expect(migrate(db.url, 'undoLast')).rejects.toThrow(/Refusing to revert/);
    expect(await tables()).toEqual(['accounts', 'customers', 'users']);

    // Back to the freshly migrated state: the revert goes through, so the guard is not a wall.
    await q(`UPDATE accounts SET balance = 0 WHERE id = '${FUNDING_ID}'`);
    await migrate(db.url, 'undoLast');
    expect(await tables()).toEqual([]);
  });
});
