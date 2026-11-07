import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import type { SqsClient } from '@libs/sqs';
import { IdentityService } from '@modules/identity';
import { OutboxRelayService } from '@modules/outbox';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

/**
 * The application never runs as the table owner (database-design §8). This applies
 * infra/scripts/db-roles.sql to a migrated database and proves, as `dbs_api` and `dbs_worker`
 * themselves: the real HTTP flows work with only the granted privileges, and everything outside
 * the matrix is refused by PostgreSQL (BL-017: the other DB specs run as a superuser).
 */
describe('least-privilege roles dbs_api and dbs_worker (infra/scripts/db-roles.sql)', () => {
  const PASSWORD = 'role-test-only';
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let apiSource: DataSource;
  let workerSource: DataSource;
  const sql = readFileSync(resolve(__dirname, '../../../infra/scripts/db-roles.sql'), 'utf8');

  const urlFor = (role: string): string => {
    const url = new URL(db.url);
    url.username = role;
    url.password = PASSWORD;
    return url.toString();
  };
  const connect = async (role: string): Promise<DataSource> =>
    new DataSource({ type: 'postgres', url: urlFor(role) }).initialize();
  const denied = (promise: Promise<unknown>) =>
    expect(promise).rejects.toThrow(/permission denied/);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    await db.runner.query(sql);
    // Running it twice must change nothing: it is applied after every migration.
    await db.runner.query(sql);
    for (const role of ['dbs_api', 'dbs_worker']) {
      await db.runner.query(`ALTER ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`);
    }
    apiSource = await connect('dbs_api');
    workerSource = await connect('dbs_worker');
    app = await startDepositApp(urlFor('dbs_api'));
  });
  afterAll(async () => {
    try {
      await app?.close();
      await apiSource?.destroy();
      await workerSource?.destroy();
    } finally {
      await db?.drop();
    }
  });

  it('TC-ROLE-01 the real flows run as dbs_api: users row, deposit, transfer, replay, open account, revocation', async () => {
    const a = await seedDepositTarget(db.runner),
      b = await seedDepositTarget(db.runner);
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    const customer = await app.issuer.token('customer', { sub: a.sub });
    // First token of a new subject creates its users row (INSERT on users).
    const fresh = await app.issuer.token('customer', { sub: randomUUID() });
    await request(app.url).get('/v1/identity/me').auth(fresh, { type: 'bearer' }).expect(200);
    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: a.accountId, amount: '1000000' })
      .expect(201);
    const key = randomUUID();
    const send = () =>
      request(app.url)
        .post('/v1/transfers')
        .auth(customer, { type: 'bearer' })
        .set('Idempotency-Key', key)
        .send({ fromAccountId: a.accountId, toAccountId: b.accountId, amount: '300000' });
    const first = await send().expect(201);
    expect((await send().expect(201)).body).toEqual(first.body);
    await request(app.url)
      .post('/v1/transfers')
      .auth(customer, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ fromAccountId: a.accountId, toAccountId: b.accountId, amount: '999999999' })
      .expect(422);
    // Opening an account locks the customer row with FOR UPDATE, which needs a column UPDATE grant (BL-159).
    const opened = await request(app.url)
      .post('/v1/accounts')
      .auth(customer, { type: 'bearer' })
      .send({ type: 'SAVINGS' })
      .expect(201);
    expect(opened.body).toMatchObject({ type: 'SAVINGS', balance: '0', status: 'ACTIVE' });
    // The lock of an account cuts the owner's sessions in the same transaction.
    const identity = app.app.get(IdentityService);
    await app.source.transaction(manager => identity.revokeSessions(manager, a.userId));
    const old = await app.issuer.token('customer', { sub: a.sub, iat: 1 });
    await request(app.url).get('/v1/identity/me').auth(old, { type: 'bearer' }).expect(401);
    const result = await checkLedgerInvariants(db.runner);
    expect(result.status).toBe('PASS');
  });

  it('TC-ROLE-02 dbs_api cannot change history, other columns, or read the outbox', async () => {
    await denied(apiSource.query('UPDATE ledger_entries SET amount = amount'));
    await denied(apiSource.query('DELETE FROM ledger_entries'));
    await denied(apiSource.query('UPDATE transfers SET amount = amount'));
    await denied(apiSource.query('DELETE FROM transfers'));
    await denied(apiSource.query('UPDATE audit_log SET action = action'));
    await denied(apiSource.query('DELETE FROM audit_log'));
    await denied(apiSource.query("UPDATE accounts SET type = 'CHECKING'"));
    await denied(apiSource.query('DELETE FROM accounts'));
    await denied(apiSource.query('UPDATE users SET cognito_sub = cognito_sub'));
    // Only full_name may change on customers; the other columns and DELETE stay out of reach.
    await apiSource.query('SELECT 1 FROM customers FOR UPDATE');
    await denied(apiSource.query('UPDATE customers SET user_id = user_id'));
    await denied(apiSource.query('UPDATE customers SET created_at = created_at'));
    await denied(apiSource.query('DELETE FROM customers'));
    await denied(apiSource.query('SELECT 1 FROM outbox_events'));
    await denied(apiSource.query('UPDATE outbox_events SET published_at = now()'));
    await denied(apiSource.query('SELECT 1 FROM processed_events'));
    await denied(apiSource.query('TRUNCATE ledger_entries'));
  });

  it('TC-ROLE-03 dbs_worker reads transfers only through the view and cannot touch money', async () => {
    await workerSource.query('SELECT 1 FROM v_transfer_facts');
    await denied(workerSource.query('SELECT 1 FROM transfers'));
    await denied(workerSource.query('SELECT 1 FROM customers'));
    await denied(workerSource.query('SELECT 1 FROM users'));
    await denied(workerSource.query("UPDATE accounts SET status = 'LOCKED'"));
    await denied(workerSource.query('UPDATE ledger_entries SET amount = amount'));
    await denied(workerSource.query('DELETE FROM audit_log'));
    await denied(workerSource.query('DELETE FROM transfers'));
  });

  it('TC-ROLE-04 the real outbox relay runs as dbs_worker with only its grants', async () => {
    const event = { ...TRANSFER_SAMPLE, eventId: randomUUID() };
    await db.runner.query(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id)
       VALUES($1,'TransferCompleted',$2,$3::jsonb,$4)`,
      [event.eventId, randomUUID(), JSON.stringify(event), event.correlationId],
    );
    const sent: string[] = [];
    const sqs = {
      send: (url: string) => {
        sent.push(url);
        return Promise.resolve();
      },
    } as unknown as SqsClient;
    const tx = new TransactionService(workerSource, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const relay = new OutboxRelayService(tx, sqs, {
      region: 'us-east-1',
      endpoint: undefined,
      riskQueueUrl: 'http://queue/risk-events',
      notificationQueueUrl: 'http://queue/notification-events',
    });
    // The deposit and the transfer of TC-ROLE-01 left their own events in the outbox as well.
    const [{ pending }] = (await db.runner.query(
      'SELECT count(*)::int AS pending FROM outbox_events WHERE published_at IS NULL',
    )) as { pending: number }[];
    expect(pending).toBeGreaterThanOrEqual(1);
    expect(await relay.relayOnce()).toEqual({ published: pending });
    expect(sent).toHaveLength(pending * 2);
    expect(await relay.deleteOldRows()).toBe(0);
    const rows = (await db.runner.query(
      'SELECT published_at FROM outbox_events WHERE event_id=$1',
      [event.eventId],
    )) as { published_at: Date | null }[];
    expect(rows[0].published_at).not.toBeNull();
  });
});
