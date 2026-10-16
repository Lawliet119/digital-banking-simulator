import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const BACKEND_DIR = resolve(__dirname, '..', '..');
const FUNDING_ID = '00000000-0000-4000-8000-000000000001';
// Tables of migrations 1 and 2, and the view of migration 2 (information_schema.tables lists views).
const OBJECTS =
  "('users', 'customers', 'accounts', 'transfers', 'ledger_entries', 'idempotency_keys', 'v_transfer_facts')";
const BASE = ['accounts', 'customers', 'users'];
const ALL = [
  'accounts',
  'customers',
  'idempotency_keys',
  'ledger_entries',
  'transfers',
  'users',
  'v_transfer_facts',
];

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

describe('migrations 1 and 2: run, revert, run', () => {
  let db: TempDatabase;

  afterEach(async () => {
    await db?.drop();
  });

  async function tables(): Promise<string[]> {
    const rows = (await db.runner.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ${OBJECTS}
        ORDER BY table_name`,
    )) as { table_name: string }[];
    return rows.map(r => r.table_name);
  }

  async function appliedMigrations(): Promise<string[]> {
    const rows = (await db.runner.query('SELECT name FROM migrations')) as { name: string }[];
    return rows.map(r => r.name);
  }

  it('TC-21-23 migration:run → revert → revert → run is green on an empty database, one migration at a time', async () => {
    db = await createTempDatabase();

    npmRun('migration:run', db.url);
    expect(await tables()).toEqual(ALL);

    // migration:revert undoes only the newest migration, so migration 1 needs a second revert.
    // The first takes the three money-flow tables and the view; users, accounts and funding stay.
    npmRun('migration:revert', db.url);
    expect(await tables()).toEqual(BASE);
    expect(await appliedMigrations()).toEqual(['CreateUsersCustomersAccounts1791763200000']);
    expect(await db.runner.query('SELECT id FROM accounts')).toEqual([{ id: FUNDING_ID }]);

    npmRun('migration:revert', db.url);
    expect(await tables()).toEqual([]);
    expect(await appliedMigrations()).toEqual([]);

    npmRun('migration:run', db.url);
    expect(await tables()).toEqual(ALL);
    expect(await appliedMigrations()).toEqual([
      'CreateUsersCustomersAccounts1791763200000',
      'CreateTransfersLedgerIdempotency1791849600000',
    ]);
    expect(await db.runner.query('SELECT id, type, balance FROM accounts')).toEqual([
      { id: FUNDING_ID, type: 'SYSTEM', balance: '0' },
    ]);
  });

  it('TC-20-18 refuses to revert, and drops nothing, once the tables hold data', async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    const q = (sql: string) => db.runner.query(sql);

    // Undo migration 2 (DBS-21, empty) so migration 1 is the one being reverted below.
    await migrate(db.url, 'undoLast');
    expect(await appliedMigrations()).toEqual(['CreateUsersCustomersAccounts1791763200000']);

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

describe('migration 2: revert refuses to destroy data', () => {
  let db: TempDatabase;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
  });

  afterAll(async () => {
    await db?.drop();
  });

  const q = (sql: string, params: unknown[] = []) => db.runner.query(sql, params);

  async function objects(): Promise<string[]> {
    const rows = (await q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ${OBJECTS} ORDER BY table_name`,
    )) as { table_name: string }[];
    return rows.map(r => r.table_name);
  }

  async function expectRefusal(): Promise<void> {
    await expect(migrate(db.url, 'undoLast')).rejects.toThrow(/Refusing to revert/);
    // Nothing was dropped and the migration is still recorded.
    expect(await objects()).toEqual(ALL);
    const applied = (await q('SELECT name FROM migrations ORDER BY timestamp')) as {
      name: string;
    }[];
    expect(applied.map(r => r.name)).toEqual([
      'CreateUsersCustomersAccounts1791763200000',
      'CreateTransfersLedgerIdempotency1791849600000',
    ]);
  }

  it('TC-21-24 refuses while transfers, idempotency_keys or ledger_entries holds a row, then goes through', async () => {
    // These rows are committed (migrate() opens its own connection) and removed by the test.
    const [user] = await q(`INSERT INTO users (cognito_sub) VALUES ('sub-revert') RETURNING id`);
    const accounts: string[] = [];
    for (const name of ['An', 'Bình']) {
      const [{ id: userId }] = await q('INSERT INTO users (cognito_sub) VALUES ($1) RETURNING id', [
        `sub-${name}`,
      ]);
      const [customer] = await q(
        'INSERT INTO customers (user_id, full_name) VALUES ($1, $2) RETURNING id',
        [userId, name],
      );
      const [account] = await q(
        `INSERT INTO accounts (customer_id, type) VALUES ($1, 'CHECKING') RETURNING id`,
        [customer.id],
      );
      accounts.push(account.id);
    }

    // (a) only a transfer
    await q(
      `INSERT INTO transfers (type, from_account_id, to_account_id, amount, status, initiated_by, correlation_id)
       VALUES ('TRANSFER', $1, $2, 300000, 'COMPLETED', $3, gen_random_uuid())`,
      [accounts[0], accounts[1], user.id],
    );
    await expectRefusal();
    await q('DELETE FROM transfers');

    // (b) only an idempotency key (no transfer yet, as in the reservation step)
    await q(
      `INSERT INTO idempotency_keys (user_id, idem_key, request_hash) VALUES ($1, 'k1', $2)`,
      [user.id, 'a'.repeat(64)],
    );
    await expectRefusal();
    await q('DELETE FROM idempotency_keys');

    // (c) only a ledger line, which cannot exist without a transfer unless the foreign keys are
    // switched off for this connection (needs a superuser; a missing right fails the test).
    await q('SET session_replication_role = replica');
    await q(
      `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, balance_after)
       VALUES (gen_random_uuid(), $1, 'DEBIT', 300000, 0)`,
      [accounts[0]],
    );
    await q('SET session_replication_role = origin');
    await expectRefusal();
    await q('DELETE FROM ledger_entries');

    // Back to the freshly migrated state: the revert goes through, so the guard is not a wall.
    await migrate(db.url, 'undoLast');
    expect(await objects()).toEqual(BASE);
  });
});
