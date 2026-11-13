import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { postBackdatedTransfer } from '../support/backdated-transfer';
import { checkLedgerInvariants } from '../support/invariants';
import { insertFlaggedDecision } from '../support/risk-decisions';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Row = Awaited<ReturnType<typeof seedDepositTarget>>;
interface Item {
  entryId: string;
  transferId: string;
  type: string;
  direction: string;
  amount: string;
  balanceAfter: string;
  counterpartyAccountId: string | null;
  createdAt: string;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
}
const FUNDING = '00000000-0000-4000-8000-000000000001';
const ITEM_KEYS = [
  'amount',
  'balanceAfter',
  'counterpartyAccountId',
  'createdAt',
  'direction',
  'entryId',
  'transferId',
  'type',
];

/** DBS-87 UC-6: history of an owned account over real HTTP, real JWT and real PostgreSQL. */
describe('DBS-87 transaction history (UC-6)', () => {
  let db: TempDatabase, app: App, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const token = (row: Row) => app.issuer.token('customer', { sub: row.sub });
  /** The response, with `.expect(status)` like supertest (the token is signed asynchronously). */
  const history = (row: Row, id: string, query = '') => {
    const response = (async () =>
      request(app.url)
        .get(`/v1/accounts/${id}/transactions${query}`)
        .auth(await token(row), { type: 'bearer' }))();
    return Object.assign(response, {
      expect: async (status: number) => {
        const res = await response;
        expect({ query, status: res.status }).toEqual({ query, status });
        return res;
      },
    });
  };
  const deposit = (to: string, amount: string) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: to, amount })
      .expect(201);
  const funded = async (amount: string): Promise<Row> => {
    const row = await seedDepositTarget(db.runner);
    await deposit(row.accountId, amount);
    return row;
  };
  /** Pages through the whole history with `size` lines per page. */
  async function allPages(row: Row, size: number, extra = ''): Promise<Page[]> {
    const pages: Page[] = [];
    let cursor: string | null = null;
    do {
      const res = await history(
        row,
        row.accountId,
        `?limit=${size}${extra}${cursor ? `&cursor=${cursor}` : ''}`,
      ).expect(200);
      pages.push(res.body as Page);
      cursor = (res.body as Page).nextCursor;
      expect(pages.length).toBeLessThan(100);
    } while (cursor);
    return pages;
  }
  const truth = async (accountId: string): Promise<string[]> => {
    const rows: { id: string }[] = await q(
      'SELECT id::text FROM ledger_entries WHERE account_id=$1 ORDER BY created_at DESC, id DESC',
      [accountId],
    );
    return rows.map(r => r.id);
  };

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterEach(async () => {
    const result = await checkLedgerInvariants(db.runner);
    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-87-01 pages with a cursor: no gap, no repeat, newest first, last page has no cursor', async () => {
    const giang = await funded('10000000'),
      hai = await seedDepositTarget(db.runner);
    for (let i = 0; i < 22; i++) {
      const at = new Date(Date.UTC(2026, 2, 1, 0, i, 0)).toISOString();
      await postBackdatedTransfer(db.runner, {
        from: giang.accountId,
        to: hai.accountId,
        amount: String(1000 + i),
        at,
        actorId: giang.userId,
      });
    }
    const pages = await allPages(giang, 10);
    expect(pages.map(p => p.items.length)).toEqual([10, 10, 3]);
    expect(pages.map(p => p.nextCursor === null)).toEqual([false, false, true]);
    const ids = pages.flatMap(p => p.items.map(i => i.entryId));
    expect(ids).toEqual(await truth(giang.accountId));
    expect(new Set(ids).size).toBe(23); // 22 transfers + the deposit
    const times = pages.flatMap(p => p.items.map(i => i.createdAt));
    expect([...times].sort().reverse()).toEqual(times);
    // A different page size walks the same history.
    expect((await allPages(giang, 7)).flatMap(p => p.items.map(i => i.entryId))).toEqual(ids);
    // The default size is 20; a history that fits in one page has no cursor.
    const first = await history(giang, giang.accountId).expect(200);
    expect(first.body.items).toHaveLength(20);
    expect(first.body.nextCursor).not.toBeNull();
    const empty = await seedDepositTarget(db.runner);
    expect((await history(empty, empty.accountId).expect(200)).body).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('TC-87-02 lines with the same createdAt keep a stable order across a page boundary', async () => {
    const giang = await funded('10000000'),
      hai = await seedDepositTarget(db.runner);
    const at = '2026-03-02T05:00:00.123456Z';
    for (let i = 0; i < 6; i++)
      await postBackdatedTransfer(db.runner, {
        from: giang.accountId,
        to: hai.accountId,
        amount: String(2000 + i),
        at,
        actorId: giang.userId,
      });
    const ids = (await allPages(giang, 4)).flatMap(p => p.items.map(i => i.entryId));
    expect(ids).toEqual(await truth(giang.accountId));
    expect(new Set(ids).size).toBe(7);
    // Microseconds survive the cursor: 06 lines share one instant with six fractional digits.
    const tied = (await allPages(giang, 2)).flatMap(p => p.items).filter(i => i.createdAt === at);
    expect(tied).toHaveLength(6);
  });

  it('TC-87-04 from is inclusive, to is exclusive, and a cursor works with the filters', async () => {
    const giang = await funded('10000000'),
      hai = await seedDepositTarget(db.runner);
    const times = ['2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z', '2026-04-03T00:00:00Z'];
    for (const at of times)
      await postBackdatedTransfer(db.runner, {
        from: giang.accountId,
        to: hai.accountId,
        amount: '5000',
        at,
        actorId: giang.userId,
      });
    const q1 = '&from=2026-04-02T00:00:00Z&to=2026-04-03T00:00:00Z';
    const one = await history(giang, giang.accountId, `?limit=10${q1}`).expect(200);
    expect(one.body.items.map((i: Item) => i.createdAt)).toEqual(['2026-04-02T00:00:00.000000Z']);
    const both = await history(giang, giang.accountId, '?from=2026-04-02T00:00:00Z').expect(200);
    expect(both.body.items.length).toBeGreaterThanOrEqual(2); // 3 Apr, 2 Apr and the deposit
    const paged = await allPages(giang, 1, '&from=2026-04-01T00:00:00Z&to=2026-04-03T00:00:01Z');
    expect(paged.flatMap(p => p.items.map(i => i.createdAt))).toEqual([
      '2026-04-03T00:00:00.000000Z',
      '2026-04-02T00:00:00.000000Z',
      '2026-04-01T00:00:00.000000Z',
    ]);
  });

  it('TC-87-05 rejects a bad limit, time, cursor or parameter with 400', async () => {
    const giang = await funded('1000000');
    const good = await funded('1000000');
    await deposit(good.accountId, '1000');
    const cursor = (await history(good, good.accountId, '?limit=1').expect(200)).body.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?limit=1.5',
      '?limit=1&limit=2',
      '?from=yesterday',
      '?from=2026-03-15T09:30:00%2B07:00',
      '?from=2026-03-16T00:00:00Z&to=2026-03-15T00:00:00Z',
      '?cursor=%%%',
      '?cursor=' + 'a'.repeat(600),
      '?offset=20',
      `?cursor=${cursor}&from=2026-01-01T00:00:00Z`, // cursor of another filter
    ]) {
      const res = await history(good, good.accountId, query);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
    }
    // The damaged requests changed nothing and the same cursor still works.
    await history(good, good.accountId, `?limit=1&cursor=${cursor}`).expect(200);
    expect(giang.accountId).toBeDefined();
  });

  it('TC-87-06 an account that is not yours, does not exist, is SYSTEM or is not a UUID: the same 404 + DENIED', async () => {
    const giang = await funded('1000000'),
      hai = await funded('1000000');
    let shape: unknown;
    for (const id of [
      hai.accountId,
      randomUUID(),
      FUNDING,
      'not-a-uuid',
      hai.accountId.toUpperCase(),
    ]) {
      const res = await history(giang, id).expect(404);
      const { correlationId: _cid, ...body } = res.body;
      if (!shape) shape = body;
      else expect(body).toEqual(shape);
      expect(JSON.stringify(res.body)).not.toContain(hai.accountId);
      const [audit] = await q(
        "SELECT outcome,metadata FROM audit_log WHERE action='account.transactions' AND correlation_id=$1",
        [res.headers['x-correlation-id']],
      );
      expect(audit.outcome).toBe('DENIED');
      expect(audit.metadata).toEqual({ reason: 'NOT_OWNER' });
    }
  });

  it('TC-87-09 AC-10.2 the history carries nothing about fraud flags', async () => {
    const giang = await funded('10000000'),
      hai = await seedDepositTarget(db.runner);
    const transferId = await postBackdatedTransfer(db.runner, {
      from: giang.accountId,
      to: hai.accountId,
      amount: '9000000',
      at: '2026-03-05T03:00:00Z',
      actorId: giang.userId,
    });
    // RSK-01, BL-223: a flag needs a decision of the same version whose score and hits match it.
    await insertFlaggedDecision(db.runner, transferId, { score: 85, level: 'HIGH' });
    for (const row of [giang, hai]) {
      const res = await history(row, row.accountId, '?limit=100').expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/fraud|flag|risk|score|review|rule|HIGH/i);
      expect(res.body.items.find((i: Item) => i.transferId === transferId)).toBeDefined();
      for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
      expect(Object.keys(res.body).sort()).toEqual(['items', 'nextCursor']);
    }
  });

  it('TC-87-10 shows money in and out with exact strings; a deposit hides the funding account', async () => {
    const giang = await funded('1000000'),
      hai = await seedDepositTarget(db.runner);
    await postBackdatedTransfer(db.runner, {
      from: giang.accountId,
      to: hai.accountId,
      amount: '300000',
      at: '2026-03-06T03:00:00Z',
      actorId: giang.userId,
    });
    const mine = (await history(giang, giang.accountId).expect(200)).body as Page;
    const [dep, out] = mine.items;
    expect(dep).toMatchObject({
      type: 'DEPOSIT',
      direction: 'CREDIT',
      amount: '1000000',
      counterpartyAccountId: null,
    });
    expect(JSON.stringify(mine)).not.toContain(FUNDING);
    expect(out).toMatchObject({
      type: 'TRANSFER',
      direction: 'DEBIT',
      amount: '300000',
      counterpartyAccountId: hai.accountId,
    });
    const [{ balance }] = await q('SELECT balance::text FROM accounts WHERE id=$1', [
      giang.accountId,
    ]);
    // The deposit line is the real one (balance after it: 1,000,000); the 300,000 line was inserted after it.
    expect(balance).toBe('700000');
    expect(dep.balanceAfter).toBe('1000000');
    expect(out.balanceAfter).toBe('700000');
    const theirs = (await history(hai, hai.accountId).expect(200)).body as Page;
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]).toMatchObject({
      direction: 'CREDIT',
      amount: '300000',
      balanceAfter: '300000',
      counterpartyAccountId: giang.accountId,
    });
  });

  it('TC-87-11 a successful read is audited in the same transaction; no audit, no data', async () => {
    const giang = await funded('1000000');
    const res = await history(giang, giang.accountId).expect(200);
    const [audit] = await q(
      "SELECT actor_user_id,actor_role,outcome,target_type,target_id,metadata FROM audit_log WHERE action='account.transactions' AND correlation_id=$1",
      [res.headers['x-correlation-id']],
    );
    expect(audit).toMatchObject({
      actor_user_id: giang.userId,
      actor_role: 'customer',
      outcome: 'SUCCESS',
      target_type: 'account',
      target_id: giang.accountId,
      metadata: { id: giang.accountId, count: 1 },
    });
    await q(
      "CREATE FUNCTION dbs87_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs87_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs87_fail_audit()',
    );
    try {
      const failed = await history(giang, giang.accountId).expect(500);
      expect(JSON.stringify(failed.body)).not.toMatch(
        /amount|balanceAfter|audit unavailable|SELECT/,
      );
    } finally {
      await q('DROP TRIGGER dbs87_fail_audit ON audit_log');
      await q('DROP FUNCTION dbs87_fail_audit()');
    }
    await history(giang, giang.accountId).expect(200);
  });

  it('TC-87-13 customer only, no cache, and Swagger documents role, query and errors', async () => {
    const giang = await funded('1000');
    for (const role of ['operator', 'auditor', 'admin'] as const) {
      const jwt = await app.issuer.token(role, { sub: randomUUID() });
      await request(app.url)
        .get(`/v1/accounts/${giang.accountId}/transactions`)
        .auth(jwt, { type: 'bearer' })
        .expect(403);
    }
    await request(app.url).get(`/v1/accounts/${giang.accountId}/transactions`).expect(401);
    const ok = await history(giang, giang.accountId).expect(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    const route = doc.paths['/v1/accounts/{id}/transactions'].get!;
    expect(route.security).toContainEqual({ 'access-token': [] });
    expect((route.parameters as { name: string }[]).map(p => p.name).sort()).toEqual([
      'cursor',
      'from',
      'id',
      'limit',
      'to',
    ]);
    for (const status of ['200', '400', '401', '403', '404', '500', '503'])
      expect(route.responses[status]).toBeDefined();
  });
});
