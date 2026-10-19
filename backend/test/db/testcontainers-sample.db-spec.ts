import type { QueryRunner } from 'typeorm';
import { attempt, createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * DBS-39 sample test: verifies that migrations run successfully on real PostgreSQL 17
 * and constraints (e.g. non-negative customer balance) are strictly enforced by the database.
 */
describe('DBS-39 Testcontainers sample: PostgreSQL 17 migration and constraints', () => {
  let db: TempDatabase;
  let runner: QueryRunner;

  beforeAll(async () => {
    db = await createTempDatabase();
    runner = db.runner;
    await migrate(db.url);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => runner.query('BEGIN'));
  afterEach(() => runner.query('ROLLBACK'));

  it('TC-39-01: verifies database server runs in UTC timezone', async () => {
    const rows = (await runner.query('SHOW timezone')) as Array<{
      TimeZone?: string;
      timezone?: string;
    }>;
    const tz = rows[0].TimeZone || rows[0].timezone;
    expect(tz).toMatch(/^(UTC|Etc\/UTC)$/i);
  });

  it('TC-39-02: rejects customer account with negative balance with check constraint error (code 23514)', async () => {
    // 1. Seed user
    const userRows = await attempt<{ id: string }>(
      runner,
      'INSERT INTO users (cognito_sub) VALUES ($1) RETURNING id',
      [`sub-sample-${Date.now()}`],
    );
    const userId = userRows[0].id;

    // 2. Seed customer
    const customerRows = await attempt<{ id: string }>(
      runner,
      'INSERT INTO customers (user_id, full_name) VALUES ($1, $2) RETURNING id',
      [userId, 'Nguyen Van Test'],
    );
    const customerId = customerRows[0].id;

    // 3. Attempt to insert customer account with negative balance
    await expect(
      attempt(
        runner,
        `INSERT INTO accounts (customer_id, type, status, balance)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [customerId, 'CHECKING', 'ACTIVE', '-50000'],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'accounts_balance_non_negative',
    });
  });
});
