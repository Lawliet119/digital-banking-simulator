import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

type App = Awaited<ReturnType<typeof startDepositApp>>;

/** UI v2, stage 2: limits, money in and out, recent recipients and the history direction filter. */
describe('customer insights', () => {
  let db: TempDatabase;
  let app: App;
  let operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterEach(async () => {
    expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  async function customer(name: string) {
    const row = await seedDepositTarget(db.runner);
    await q('UPDATE customers SET full_name=$2 WHERE id=$1', [row.customerId, name]);
    return { ...row, token: await app.issuer.token('customer', { sub: row.sub }) };
  }

  /** A second account of the same customer. */
  async function secondAccount(customerId: string): Promise<string> {
    const accountId = randomUUID();
    await q("INSERT INTO accounts(id,customer_id,type) VALUES($1,$2,'SAVINGS')", [
      accountId,
      customerId,
    ]);
    return accountId;
  }

  async function deposit(accountId: string, amount: string) {
    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: accountId, amount })
      .expect(201);
  }

  async function transfer(
    token: string,
    fromAccountId: string,
    toAccountId: string,
    amount: string,
  ) {
    const res = await request(app.url)
      .post('/v1/transfers')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ fromAccountId, toAccountId, amount });
    return res.status;
  }

  const get = (path: string, token?: string) => {
    const call = request(app.url).get(path);
    return token ? call.auth(token, { type: 'bearer' }) : call;
  };

  it('TC-I-01 limits show what the account sent today and what is left', async () => {
    const me = await customer('Hạn Mức');
    const other = await customer('Người Nhận');
    await deposit(me.accountId, '1000000');
    expect((await get(`/v1/accounts/${me.accountId}/limits`, me.token).expect(200)).body).toEqual({
      perTransaction: '50000000',
      perDay: '200000000',
      sentToday: '0',
      remainingToday: '200000000',
    });
    expect(await transfer(me.token, me.accountId, other.accountId, '300000')).toBe(201);
    // A refused transfer does not count.
    expect(await transfer(me.token, me.accountId, other.accountId, '9000000')).toBe(422);
    const res = await get(`/v1/accounts/${me.accountId}/limits`, me.token).expect(200);
    expect(res.body).toMatchObject({ sentToday: '300000', remainingToday: '199700000' });
    expect(
      await q("SELECT outcome FROM audit_log WHERE action='account.limits' AND correlation_id=$1", [
        res.headers['x-correlation-id'],
      ]),
    ).toEqual([{ outcome: 'SUCCESS' }]);
  });

  it('TC-I-02 someone else’s account is 404 with a DENIED row', async () => {
    const me = await customer('Tôi');
    const other = await customer('Khác');
    const res = await get(`/v1/accounts/${other.accountId}/limits`, me.token).expect(404);
    expect(
      await q("SELECT outcome FROM audit_log WHERE action='account.limits' AND correlation_id=$1", [
        res.headers['x-correlation-id'],
      ]),
    ).toEqual([{ outcome: 'DENIED' }]);
  });

  it('TC-I-03 the summary counts money per account and leaves own transfers out of the totals', async () => {
    const me = await customer('Tổng Hợp');
    const savings = await secondAccount(me.customerId);
    const other = await customer('Bên Ngoài');
    await deposit(me.accountId, '1000000');
    expect(await transfer(me.token, me.accountId, savings, '400000')).toBe(201);
    expect(await transfer(me.token, me.accountId, other.accountId, '100000')).toBe(201);
    await deposit(other.accountId, '50000');
    expect(await transfer(other.token, other.accountId, me.accountId, '20000')).toBe(201);

    const body = (await get('/v1/insights/summary?days=1', me.token).expect(200)).body;
    expect(body).toMatchObject({ days: 1, totalIn: '1020000', totalOut: '100000' });
    expect(body.accounts).toEqual([
      expect.objectContaining({
        accountId: me.accountId,
        moneyIn: '1020000',
        moneyOut: '500000',
        transactions: 4,
      }),
      expect.objectContaining({
        accountId: savings,
        moneyIn: '400000',
        moneyOut: '0',
        transactions: 1,
      }),
    ]);
    expect((await get('/v1/insights/summary', me.token).expect(200)).body.days).toBe(30);
  });

  it('TC-I-04 a customer with no account gets zeros', async () => {
    const sub = randomUUID();
    const token = await app.issuer.token('customer', { sub });
    expect((await get('/v1/insights/summary', token).expect(200)).body).toEqual({
      days: 30,
      totalIn: '0',
      totalOut: '0',
      accounts: [],
    });
    expect((await get('/v1/insights/recipients', token).expect(200)).body).toEqual({ items: [] });
  });

  it.each(['?days=7', '?days=', '?days=1&days=30', '?userId=1'])(
    'TC-I-05 summary %s is 400',
    async query => {
      const me = await customer('Sai Ngày');
      await get(`/v1/insights/summary${query}`, me.token).expect(400);
    },
  );

  it('TC-I-06 recipients: newest first, at most five, no own account, no refused transfer', async () => {
    const me = await customer('Gửi Nhiều');
    const savings = await secondAccount(me.customerId);
    await deposit(me.accountId, '5000000');
    const others = [];
    for (let i = 1; i <= 6; i++) {
      const other = await customer(`Người ${i}`);
      others.push(other);
      expect(await transfer(me.token, me.accountId, other.accountId, '1000')).toBe(201);
    }
    const refused = await customer('Bị Từ Chối');
    expect(await transfer(me.token, me.accountId, refused.accountId, '999999999')).toBe(422);
    expect(await transfer(me.token, me.accountId, savings, '1000')).toBe(201);
    // Paying an earlier one again moves them to the top without listing them twice.
    expect(await transfer(me.token, me.accountId, others[2].accountId, '1000')).toBe(201);

    const { items } = (await get('/v1/insights/recipients', me.token).expect(200)).body;
    expect(items.map((item: { ownerName: string }) => item.ownerName)).toEqual([
      'Người 3',
      'Người 6',
      'Người 5',
      'Người 4',
      'Người 2',
    ]);
    expect(items[0]).toEqual({
      accountId: others[2].accountId,
      accountNumber: expect.stringMatching(/^\d{12}$/),
      ownerName: 'Người 3',
      lastTransferAt: expect.any(String),
    });
  });

  it('TC-I-07 history can show money out or money in only, with its own cursor', async () => {
    const me = await customer('Lịch Sử');
    const other = await customer('Đối Tác');
    await deposit(me.accountId, '500000');
    await deposit(me.accountId, '500000');
    expect(await transfer(me.token, me.accountId, other.accountId, '1000')).toBe(201);
    const history = (query: string) =>
      get(`/v1/accounts/${me.accountId}/transactions${query}`, me.token);
    const directions = async (query: string): Promise<string[]> => {
      const body = (await history(query).expect(200)).body as { items: { direction: string }[] };
      return body.items.map(item => item.direction);
    };
    expect(await directions('?direction=DEBIT')).toEqual(['DEBIT']);
    expect(await directions('?direction=CREDIT')).toEqual(['CREDIT', 'CREDIT']);
    expect(await directions('')).toEqual(['DEBIT', 'CREDIT', 'CREDIT']);
    const cursor = (await history('?direction=CREDIT&limit=1').expect(200)).body.nextCursor;
    await history(`?direction=CREDIT&limit=1&cursor=${cursor}`).expect(200);
    await history(`?direction=DEBIT&cursor=${cursor}`).expect(400);
    await history('?direction=BOTH').expect(400);
  });

  it.each(['/v1/insights/summary', '/v1/insights/recipients'])(
    'TC-I-08 %s: no token is 401, staff are 403',
    async path => {
      await get(path).expect(401);
      for (const role of ['operator', 'auditor', 'admin'] as const) {
        await get(path, await app.issuer.token(role, { sub: randomUUID() })).expect(403);
      }
    },
  );
});
