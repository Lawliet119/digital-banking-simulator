import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Row = Awaited<ReturnType<typeof seedDepositTarget>>;

const FUNDING_ID = '00000000-0000-4000-8000-000000000001';

/**
 * UI plan, stage A, over real HTTP/JWT/PostgreSQL: the account number is shown on every account
 * view, `GET /v1/accounts/lookup` tells who owns a number, and no money path changed.
 * The 429 of the lookup is in `test/services/rate-limit.services-spec.ts` (it needs Valkey).
 */
describe('account number and recipient lookup', () => {
  let db: TempDatabase;
  let app: App;
  let operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const numberOf = async (accountId: string): Promise<string> =>
    (
      (await q('SELECT account_number FROM accounts WHERE id=$1', [accountId])) as {
        account_number: string;
      }[]
    )[0].account_number;
  const customerToken = (row: Row) => app.issuer.token('customer', { sub: row.sub });
  const lookup = (token: string | undefined, query = '') => {
    const call = request(app.url).get(`/v1/accounts/lookup${query}`);
    return token ? call.auth(token, { type: 'bearer' }) : call;
  };
  async function named(name: string): Promise<Row> {
    const row = await seedDepositTarget(db.runner);
    await q('UPDATE customers SET full_name=$2 WHERE id=$1', [row.customerId, name]);
    return row;
  }
  async function transfer(from: Row, to: Row, amount: string) {
    const deposit = await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: from.accountId, amount });
    expect(deposit.status).toBe(201);
    return request(app.url)
      .post('/v1/transfers')
      .auth(await customerToken(from), { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ fromAccountId: from.accountId, toAccountId: to.accountId, amount });
  }

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

  describe('GET /v1/accounts/lookup', () => {
    it('TC-A-20 returns accountId, accountNumber and ownerName for a customer account, and audits it', async () => {
      const asker = await named('Lê Văn Khách');
      const target = await named('Phạm Thị Hồng');
      const number = await numberOf(target.accountId);
      const res = await lookup(await customerToken(asker), `?accountNumber=${number}`).expect(200);
      expect(res.body).toEqual({
        accountId: target.accountId,
        accountNumber: number,
        ownerName: 'Phạm Thị Hồng',
      });
      expect(
        await q(
          "SELECT actor_role, outcome, target_type, target_id, metadata FROM audit_log WHERE action='account.lookup' AND correlation_id=$1",
          [res.headers['x-correlation-id']],
        ),
      ).toEqual([
        {
          actor_role: 'customer',
          outcome: 'SUCCESS',
          target_type: 'account',
          target_id: target.accountId,
          metadata: { id: target.accountId },
        },
      ]);
    });

    it('TC-A-21 a LOCKED account is still found (the transfer is refused later, by the usual rule)', async () => {
      const asker = await named('Người hỏi');
      const locked = await seedDepositTarget(db.runner, 'LOCKED');
      const res = await lookup(
        await customerToken(asker),
        `?accountNumber=${await numberOf(locked.accountId)}`,
      ).expect(200);
      expect(res.body.accountId).toBe(locked.accountId);
    });

    it('TC-A-22 an unknown number is 404 ACCOUNT_NOT_FOUND with a REJECTED audit row', async () => {
      const asker = await named('Người hỏi');
      const res = await lookup(await customerToken(asker), '?accountNumber=999999999999').expect(
        404,
      );
      expect(res.body).toMatchObject({ status: 404, errorCode: 'ACCOUNT_NOT_FOUND' });
      expect(
        await q(
          "SELECT outcome, target_type, metadata FROM audit_log WHERE action='account.lookup' AND correlation_id=$1",
          [res.headers['x-correlation-id']],
        ),
      ).toEqual([
        { outcome: 'REJECTED', target_type: 'user', metadata: { reason: 'ACCOUNT_NOT_FOUND' } },
      ]);
    });

    it('TC-A-23 the SYSTEM funding account answers exactly like a number nobody has', async () => {
      const asker = await named('Người hỏi');
      const token = await customerToken(asker);
      const systemNumber = await numberOf(FUNDING_ID);
      const system = await lookup(token, `?accountNumber=${systemNumber}`).expect(404);
      const unknown = await lookup(token, '?accountNumber=999999999998').expect(404);
      const strip = (body: Record<string, unknown>) => ({ ...body, correlationId: undefined });
      expect(strip(system.body)).toEqual(strip(unknown.body));
      expect(JSON.stringify(system.body)).not.toContain(systemNumber);
    });

    it.each([
      ['no parameter', ''],
      ['empty', '?accountNumber='],
      ['11 digits', '?accountNumber=10000000000'],
      ['13 digits', '?accountNumber=1000000000012'],
      ['letters', '?accountNumber=10000000000a'],
      ['a UUID', `?accountNumber=${FUNDING_ID}`],
      ['repeated', '?accountNumber=100000000001&accountNumber=100000000002'],
      ['an extra parameter', '?accountNumber=100000000001&x=1'],
      ['padded', '?accountNumber=%20100000000001'],
    ])('TC-A-24 %s is 400, not 404', async (_name, query) => {
      const asker = await named('Người hỏi');
      await lookup(await customerToken(asker), query).expect(400);
    });

    it('TC-A-25 no token is 401; an operator, an auditor and an admin are 403', async () => {
      await lookup(undefined, '?accountNumber=100000000001').expect(401);
      for (const role of ['operator', 'auditor', 'admin'] as const) {
        const token = await app.issuer.token(role, { sub: randomUUID() });
        await lookup(token, '?accountNumber=100000000001').expect(403);
      }
    });

    it('TC-A-26 /accounts/lookup is not read as an account id', async () => {
      const asker = await named('Người hỏi');
      const res = await lookup(await customerToken(asker), '?accountNumber=999999999997');
      expect(res.body.errorCode).toBe('ACCOUNT_NOT_FOUND');
    });
  });

  describe('the number on the views that already existed', () => {
    it('TC-A-30 POST /v1/accounts and GET /v1/accounts carry accountNumber, matching the database', async () => {
      const sub = randomUUID();
      const token = await app.issuer.token('customer', { sub });
      await request(app.url)
        .post('/v1/customers/me')
        .auth(token, { type: 'bearer' })
        .send({ fullName: 'Trần Thu Hà' })
        .expect(200);
      const opened = await request(app.url)
        .post('/v1/accounts')
        .auth(token, { type: 'bearer' })
        .send({ type: 'CHECKING' })
        .expect(201);
      expect(opened.body.accountNumber).toBe(await numberOf(opened.body.id));
      expect(opened.body.accountNumber).toMatch(/^[0-9]{12}$/);
      const list = await request(app.url)
        .get('/v1/accounts')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(list.body).toEqual([opened.body]);
      const detail = await request(app.url)
        .get(`/v1/accounts/${opened.body.id}`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(detail.body).toEqual(opened.body);
    });

    it('TC-A-31 the operator search finds an account by its exact number and keeps the number out of the audit log', async () => {
      const target = await named('Đặng Quốc Bảo');
      const number = await numberOf(target.accountId);
      const res = await request(app.url)
        .get(`/v1/operator/accounts?q=${number}`)
        .auth(operator, { type: 'bearer' })
        .expect(200);
      expect(res.body.items).toEqual([
        {
          id: target.accountId,
          accountNumber: number,
          type: 'CHECKING',
          status: 'ACTIVE',
          ownerName: 'Đặng Quốc Bảo',
        },
      ]);
      const rows = await q(
        "SELECT target_type, target_id FROM audit_log WHERE action='operator.account.search' AND correlation_id=$1",
        [res.headers['x-correlation-id']],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].target_type).toBe('account_search');
      expect(JSON.stringify(rows)).not.toContain(number);
      // A number that is only part of one finds nothing: it is exact, not a prefix.
      const partial = await request(app.url)
        .get(`/v1/operator/accounts?q=${number.slice(0, 11)}`)
        .auth(operator, { type: 'bearer' })
        .expect(200);
      expect(partial.body.items).toEqual([]);
    });

    it('TC-A-32 transaction history and transfer status show the counterparty numbers', async () => {
      const from = await named('Người gửi');
      const to = await named('Người nhận');
      const sent = await transfer(from, to, '70000');
      expect(sent.status).toBe(201);
      const fromNumber = await numberOf(from.accountId);
      const toNumber = await numberOf(to.accountId);

      const history = await request(app.url)
        .get(`/v1/accounts/${from.accountId}/transactions`)
        .auth(await customerToken(from), { type: 'bearer' })
        .expect(200);
      const [debit, deposit] = history.body.items;
      expect(debit).toMatchObject({
        direction: 'DEBIT',
        counterpartyAccountId: to.accountId,
        counterpartyAccountNumber: toNumber,
      });
      // The deposit's counterparty is the funding account, which is never shown.
      expect(deposit).toMatchObject({
        type: 'DEPOSIT',
        counterpartyAccountId: null,
        counterpartyAccountNumber: null,
      });

      const status = await request(app.url)
        .get(`/v1/transfers/${sent.body.transferId}`)
        .auth(await customerToken(from), { type: 'bearer' })
        .expect(200);
      expect(status.body).toMatchObject({
        fromAccountId: from.accountId,
        fromAccountNumber: fromNumber,
        toAccountId: to.accountId,
        toAccountNumber: toNumber,
      });
      // The recipient sees the same completed transfer.
      const asRecipient = await request(app.url)
        .get(`/v1/transfers/${sent.body.transferId}`)
        .auth(await customerToken(to), { type: 'bearer' })
        .expect(200);
      expect(asRecipient.body.toAccountNumber).toBe(toNumber);
    });

    it('TC-A-33 a REJECTED transfer still hides the destination, number included', async () => {
      const from = await named('Người gửi');
      const to = await named('Người nhận');
      const res = await request(app.url)
        .post('/v1/transfers')
        .auth(await customerToken(from), { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ fromAccountId: from.accountId, toAccountId: to.accountId, amount: '1000' });
      expect(res.status).toBe(422);
      const transferId = (
        await q('SELECT id FROM transfers WHERE from_account_id=$1', [from.accountId])
      )[0].id;
      const status = await request(app.url)
        .get(`/v1/transfers/${transferId}`)
        .auth(await customerToken(from), { type: 'bearer' })
        .expect(200);
      expect(status.body.status).toBe('REJECTED');
      expect(status.body).not.toHaveProperty('toAccountId');
      expect(status.body).not.toHaveProperty('toAccountNumber');
    });
  });
});
