import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { DomainEvent } from '@common/events';
import { TransactionService } from '@database/transaction.service';
import type { SqsClient } from '@libs/sqs';
import { AuditService } from '@modules/audit';
import { NotificationConsumer } from '@modules/notification';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';

type App = Awaited<ReturnType<typeof startDepositApp>>;

const THIS = 'AddNotificationDetail1795000015000';

interface Item {
  id: string;
  read: boolean;
  accountNumber: string | null;
  transfer: Record<string, unknown> | null;
}

/**
 * UI v2, stage 1: real deposit and transfer over HTTP, their outbox events through the real
 * consumer, then `GET /v1/notifications`. Amounts must come from the ledger.
 */
describe('notification detail and read marks', () => {
  let db: TempDatabase;
  let source: DataSource;
  let app: App;
  let consumer: NotificationConsumer;
  let operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { notifications: true });
    operator = await app.issuer.token('operator', { sub: randomUUID() });
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    const tx = new TransactionService(source, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    consumer = new NotificationConsumer(
      tx,
      {} as SqsClient,
      { notificationQueueUrl: 'http://localhost:9324/000000000000/notification-events' } as never,
      new AuditService(tx),
    );
  });
  afterEach(async () => {
    expect((await checkLedgerInvariants(db.runner)).status).toBe('PASS');
  });
  afterAll(async () => {
    try {
      await app?.close();
      await source?.destroy();
    } finally {
      await db?.drop();
    }
  });

  async function customer(name: string) {
    const row = await seedDepositTarget(db.runner);
    await q('UPDATE customers SET full_name=$2 WHERE id=$1', [row.customerId, name]);
    const [{ account_number: number }] = (await q(
      'SELECT account_number FROM accounts WHERE id=$1',
      [row.accountId],
    )) as { account_number: string }[];
    return { ...row, name, number, token: await app.issuer.token('customer', { sub: row.sub }) };
  }

  /** Runs every outbox event that has no notice yet through the consumer, oldest first. */
  async function deliver() {
    const events = (await q(
      `SELECT payload FROM outbox_events o
       WHERE NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.event_id = o.event_id)
       ORDER BY id`,
    )) as { payload: DomainEvent }[];
    for (const { payload } of events) await consumer.handle(payload);
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
    from: { token: string; accountId: string },
    toAccountId: string,
    amount: string,
  ): Promise<string> {
    const res = await request(app.url)
      .post('/v1/transfers')
      .auth(from.token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ fromAccountId: from.accountId, toAccountId, amount })
      .expect(201);
    return res.body.transferId as string;
  }

  const list = async (token: string, query = '') =>
    (
      await request(app.url)
        .get(`/v1/notifications${query}`)
        .auth(token, { type: 'bearer' })
        .expect(200)
    ).body as { items: Item[]; nextCursor: string | null; unreadCount: number };

  const markRead = (token: string | undefined, body: object) => {
    const call = request(app.url).post('/v1/notifications/read');
    return (token ? call.auth(token, { type: 'bearer' }) : call).send(body);
  };

  it('TC-N-01 each side sees the amount, its own balance and the other party', async () => {
    const sender = await customer('Nguyễn Gửi');
    const receiver = await customer('Trần Nhận');
    await deposit(sender.accountId, '900000');
    const transferId = await transfer(sender, receiver.accountId, '250000');
    await deliver();

    const mine = await list(sender.token);
    expect(mine.items[0]).toMatchObject({
      accountNumber: sender.number,
      transfer: {
        transferId,
        direction: 'DEBIT',
        amount: '250000',
        balanceAfter: '650000',
        counterpartyName: 'Trần Nhận',
        counterpartyAccountNumber: receiver.number,
      },
    });
    const theirs = await list(receiver.token);
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]).toMatchObject({
      accountNumber: receiver.number,
      transfer: {
        direction: 'CREDIT',
        amount: '250000',
        balanceAfter: '250000',
        counterpartyName: 'Nguyễn Gửi',
        counterpartyAccountNumber: sender.number,
      },
    });
    // The sender's balance never appears in the recipient's answer.
    expect(JSON.stringify(theirs)).not.toContain('650000');
  });

  it('TC-N-02 a deposit names no counterparty (the funding account stays hidden)', async () => {
    const owner = await customer('Lê Nạp');
    await deposit(owner.accountId, '500000');
    await deliver();
    const body = await list(owner.token);
    expect(body.items[0]?.transfer).toMatchObject({
      direction: 'CREDIT',
      amount: '500000',
      counterpartyName: null,
      counterpartyAccountNumber: null,
    });
    expect(JSON.stringify(body)).not.toContain('100000000001');
  });

  it('TC-N-03 a status change carries the account and no transfer', async () => {
    const owner = await customer('Bị Khóa');
    await request(app.url)
      .post(`/v1/operator/accounts/${owner.accountId}/lock`)
      .auth(operator, { type: 'bearer' })
      .send({ reason: 'Khách yêu cầu' })
      .expect(200);
    await deliver();
    // Locking cut the sessions: sign in again with a token issued afterwards.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const token = await app.issuer.token('customer', { sub: owner.sub });
    const body = await list(token, '?filter=account');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ accountNumber: owner.number, transfer: null });
    expect(JSON.stringify(body)).not.toContain('Khách yêu cầu');
  });

  it('TC-N-04 filter in, out and account; a cursor belongs to its filter', async () => {
    const me = await customer('Lọc Một');
    const other = await customer('Lọc Hai');
    await deposit(me.accountId, '300000');
    await deposit(me.accountId, '200000');
    await transfer(me, other.accountId, '100000');
    await deliver();

    const directions = async (filter: string) =>
      (await list(me.token, `?filter=${filter}`)).items.map(item => item.transfer?.direction);
    expect(await directions('in')).toEqual(['CREDIT', 'CREDIT']);
    expect(await directions('out')).toEqual(['DEBIT']);
    expect(await directions('account')).toEqual([]);
    expect(await directions('all')).toEqual(['DEBIT', 'CREDIT', 'CREDIT']);

    const first = await list(me.token, '?filter=in&limit=1');
    expect(first.unreadCount).toBe(3);
    const second = await list(me.token, `?filter=in&limit=1&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    await request(app.url)
      .get(`/v1/notifications?filter=out&cursor=${first.nextCursor}`)
      .auth(me.token, { type: 'bearer' })
      .expect(400);
    await request(app.url)
      .get('/v1/notifications?filter=everything')
      .auth(me.token, { type: 'bearer' })
      .expect(400);
  });

  it('TC-N-05 marking read covers that notice and older ones, never newer ones or another user', async () => {
    const me = await customer('Đọc Một');
    const other = await customer('Đọc Hai');
    await deposit(me.accountId, '100000');
    await deposit(me.accountId, '100000');
    await deposit(me.accountId, '100000');
    await deposit(other.accountId, '100000');
    await deliver();
    const before = await list(me.token);
    const [newest, middle] = before.items;

    // Someone else's id changes nothing.
    expect((await markRead(other.token, { upToId: middle.id }).expect(200)).body).toEqual({
      unreadCount: 1,
    });
    expect((await list(me.token)).unreadCount).toBe(3);

    expect((await markRead(me.token, { upToId: middle.id }).expect(200)).body).toEqual({
      unreadCount: 1,
    });
    const after = await list(me.token);
    expect(after.items.map(item => item.read)).toEqual([false, true, true]);
    await markRead(me.token, { upToId: newest.id }).expect(200, { unreadCount: 0 });
    expect((await list(other.token)).unreadCount).toBe(1);
  });

  it.each([
    ['nothing', {}],
    ['a number', { upToId: 5 }],
    ['zero', { upToId: '0' }],
    ['letters', { upToId: 'abc' }],
    ['an extra field', { upToId: '1', userId: 'x' }],
  ])('TC-N-06 a body with %s is 400', async (_name, body) => {
    const me = await customer('Sai Thân');
    await markRead(me.token, body).expect(400);
  });

  it('TC-N-07 no token is 401; staff are 403', async () => {
    await markRead(undefined, { upToId: '1' }).expect(401);
    for (const role of ['operator', 'auditor', 'admin'] as const) {
      const token = await app.issuer.token(role, { sub: randomUUID() });
      await markRead(token, { upToId: '1' }).expect(403);
    }
  });

  it('TC-N-08 down removes the new columns and keeps the notices; up runs again', async () => {
    const other = await createTempDatabase();
    try {
      await migrateThrough(other.url, THIS);
      await other.runner.query(
        `INSERT INTO notification_log(event_id,kind,message)
         VALUES(gen_random_uuid(),'transfer_completed','x')`,
      );
      const columns = async () =>
        (
          (await other.runner.query(
            `SELECT count(*)::int AS n FROM information_schema.columns
             WHERE table_name='notification_log'
               AND column_name IN ('transfer_id','account_id','counterparty_account_id','direction','read_at')`,
          )) as { n: number }[]
        )[0].n;
      expect(await columns()).toBe(5);
      await migrate(other.url, 'undoLast');
      expect(await columns()).toBe(0);
      expect(await other.runner.query('SELECT count(*)::int AS n FROM notification_log')).toEqual([
        { n: 1 },
      ]);
      await migrate(other.url);
      expect(await columns()).toBe(5);
    } finally {
      await other.drop();
    }
  });
});
