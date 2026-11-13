import { OPERATOR_SUB, runSeed, SEED_CUSTOMERS, type SeedTokens } from '../../src/scripts/seed';
import { startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

interface AccountRow {
  id: string;
  type: string;
}

const FUNDING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

const PLANNED_BALANCES = {
  'demo-customer-minh-anh:CHECKING': '48000000',
  'demo-customer-minh-anh:SAVINGS': '20000000',
  'demo-customer-thu-ha:CHECKING': '11500000',
  'demo-customer-van-binh:CHECKING': '5500000',
};

/**
 * BL-213: the fixed Idempotency-Key of the seed only protects a re-run while its row exists; the
 * job of DBS-136 deletes it after IDEMPOTENCY_KEY_RETENTION_DAYS (7). Each test builds a fresh
 * database, deletes the key rows the way that job does, and runs the seed again.
 */
describe('BL-213 seed.ts re-run after the idempotency_keys rows were cleaned up (PostgreSQL integration)', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let tokens: SeedTokens;

  const query = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  const cleanIdempotencyKeys = async (): Promise<void> => {
    await query('DELETE FROM idempotency_keys');
    const left = (await query('SELECT count(*)::int AS cnt FROM idempotency_keys')) as {
      cnt: number;
    }[];
    expect(left[0].cnt).toBe(0);
  };

  /** Balance of every demo account, by owner sub and type, read straight from the database. */
  const planBalances = async (): Promise<Record<string, string>> => {
    const rows = (await query(
      `SELECT u.cognito_sub AS sub, a.type, a.balance::text AS balance
         FROM accounts a
         JOIN customers c ON c.id = a.customer_id
         JOIN users u ON u.id = c.user_id
        WHERE a.type <> 'SYSTEM'`,
    )) as { sub: string; type: string; balance: string }[];
    return Object.fromEntries(rows.map(r => [`${r.sub}:${r.type}`, r.balance]));
  };

  const fundingBalance = async (): Promise<string> => {
    const rows = (await query('SELECT balance::text AS balance FROM accounts WHERE id = $1', [
      FUNDING_ACCOUNT_ID,
    ])) as { balance: string }[];
    return rows[0].balance;
  };

  const transferCount = async (): Promise<number> => {
    const rows = (await query('SELECT count(*)::int AS cnt FROM transfers')) as { cnt: number }[];
    return rows[0].cnt;
  };

  const call = async (
    method: string,
    path: string,
    token: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; data: unknown }> => {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };

  const checkingIdOf = async (sub: string): Promise<string> => {
    const list = await call('GET', '/v1/accounts', tokens.customers[sub]);
    return (list.data as AccountRow[]).find(a => a.type === 'CHECKING')!.id;
  };

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);

    const operator = await app.issuer.token('operator', { sub: OPERATOR_SUB });
    const customers: Record<string, string> = {};
    for (const c of SEED_CUSTOMERS) {
      customers[c.sub] = await app.issuer.token('customer', { sub: c.sub });
    }
    tokens = { operator, customers };
  }, 60000);

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-70-05 does not deposit or transfer again when the keys are gone (BL-213)', async () => {
    await runSeed({ baseUrl: app.url, tokens });
    expect(await planBalances()).toEqual(PLANNED_BALANCES);

    await cleanIdempotencyKeys();
    const report = await runSeed({ baseUrl: app.url, tokens });

    expect(await planBalances()).toEqual(PLANNED_BALANCES);
    expect(await fundingBalance()).toBe('-85000000');
    expect(await transferCount()).toBe(6);

    expect(report.deposits).toHaveLength(4);
    expect(report.deposits.every(d => d.skipped === true && d.transferId === null)).toBe(true);
    expect(report.transfers).toHaveLength(2);
    expect(report.transfers.every(t => t.skipped === true && t.transferId === null)).toBe(true);
    const finals = report.customers.flatMap(c => c.accounts.map(a => a.finalBalance));
    expect(finals.sort()).toEqual(Object.values(PLANNED_BALANCES).sort());

    expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
  });

  it('TC-70-06 sends only the missing steps when a run stopped half way and the keys are gone (BL-213)', async () => {
    // A first run that died after the four deposits and the first transfer.
    for (const plan of SEED_CUSTOMERS) {
      const token = tokens.customers[plan.sub];
      expect(
        (await call('POST', '/v1/customers/me', token, { fullName: plan.fullName })).status,
      ).toBe(200);
      for (const acc of plan.accounts) {
        const opened = await call('POST', '/v1/accounts', token, { type: acc.type });
        expect(opened.status).toBe(201);
        const deposit = await call(
          'POST',
          '/v1/operator/deposits',
          tokens.operator,
          { toAccountId: (opened.data as AccountRow).id, amount: acc.initialDeposit },
          acc.depositIdempotencyKey,
        );
        expect(deposit.status).toBe(201);
      }
    }
    const first = await call(
      'POST',
      '/v1/transfers',
      tokens.customers['demo-customer-minh-anh'],
      {
        fromAccountId: await checkingIdOf('demo-customer-minh-anh'),
        toAccountId: await checkingIdOf('demo-customer-thu-ha'),
        amount: '2000000',
      },
      '70000000-0000-4000-8000-000000000005',
    );
    expect(first.status).toBe(201);
    expect((await planBalances())['demo-customer-thu-ha:CHECKING']).toBe('12000000');

    await cleanIdempotencyKeys();
    const report = await runSeed({ baseUrl: app.url, tokens });

    expect(await planBalances()).toEqual(PLANNED_BALANCES);
    expect(report.deposits.every(d => d.skipped === true)).toBe(true);
    expect(report.transfers.map(t => t.skipped === true)).toEqual([true, false]);
    expect(report.transfers[1].transferId).toEqual(expect.any(String));
    expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
  });

  it('TC-70-07 stops with a clear message and moves no money when a balance is outside the plan (BL-213)', async () => {
    await runSeed({ baseUrl: app.url, tokens });
    const extra = await call(
      'POST',
      '/v1/operator/deposits',
      tokens.operator,
      { toAccountId: await checkingIdOf('demo-customer-minh-anh'), amount: '1000000' },
      '70000000-0000-4000-8000-0000000000ff',
    );
    expect(extra.status).toBe(201);
    await cleanIdempotencyKeys();
    const before = await planBalances();
    expect(before['demo-customer-minh-anh:CHECKING']).toBe('49000000');
    const transfersBefore = await transferCount();

    await expect(runSeed({ baseUrl: app.url, tokens })).rejects.toThrow(
      /Seed stopped before the deposit: the balance of demo-customer-minh-anh:CHECKING is 49000000/,
    );
    expect(await planBalances()).toEqual(before);
    expect(await transferCount()).toBe(transfersBefore);
  });
});
