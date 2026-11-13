import { parsePositiveMoney } from '@common/money';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { CreateDbRolesAndGrants1793664000000 } from '@database/migrations/1793664000000-CreateDbRolesAndGrants';
import { TransactionService } from '@database/transaction.service';
import { SystemClock } from '@common/clock';
import type { SqsClient } from '@libs/sqs';
import { IdentityService } from '@modules/identity';
import { ReconciliationService } from '@modules/ledger';
import { OutboxRelayService } from '@modules/outbox';
import { OutboxCleanupService } from '@modules/outbox/outbox-cleanup.service';
import { TRANSFER_SAMPLE } from '../support/event-samples';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';
import { clearOutbox } from '../support/outbox-fixtures';
import { insertRuleOnlyDecision } from '../support/risk-decisions';

/**
 * The application never runs as the table owner (database-design §8). Migration step 7
 * (1793664000000-CreateDbRolesAndGrants.ts) and infra/scripts/db-roles.sql create dbs_migrator,
 * dbs_api and dbs_worker with the exact least-privilege matrix (§8.1).
 *
 * This test proves:
 * - TC-119-01: Migration step 7 creates 3 roles, is idempotent, reverts cleanly and re-applies.
 * - TC-119-02: Real API flows run as dbs_api, ledger invariants pass, and operations outside the
 *   matrix are refused by PostgreSQL with 42501 (BL-017).
 * - TC-119-03: Real worker flows run as dbs_worker, transfers are accessed only via view v_transfer_facts
 *   (BL-005), and direct table access is refused with 42501.
 * - TC-119-04: Runtime applications are blocked from connecting as dbs_migrator (DoD #2).
 * - TC-119-05: dbs_migrator has DDL/DML privileges, but append-only tables are guarded against
 *   UPDATE/DELETE by the forbid_mutation() trigger (AC-8.1, database-design §8.3).
 */
describe('least-privilege roles dbs_api, dbs_worker, dbs_migrator (DBS-119)', () => {
  const PASSWORD = 'role-test-only';
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  let apiSource: DataSource;
  let workerSource: DataSource;
  let migratorSource: DataSource;
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
    for (const role of ['dbs_api', 'dbs_worker', 'dbs_migrator']) {
      await db.runner.query(`ALTER ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`);
    }
    apiSource = await connect('dbs_api');
    workerSource = await connect('dbs_worker');
    migratorSource = await connect('dbs_migrator');
    app = await startDepositApp(urlFor('dbs_api'));
  });

  afterAll(async () => {
    try {
      await app?.close();
      await apiSource?.destroy();
      await workerSource?.destroy();
      await migratorSource?.destroy();
    } finally {
      await db?.drop();
    }
  });

  it('TC-119-01 migration step 7 creates dbs_migrator, dbs_api, dbs_worker, is idempotent, and reverts/re-applies cleanly', async () => {
    const lifecycleDb = await createTempDatabase();
    try {
      // 1. Initial migrate applies migration 7. Pinned to it: a later migration (DBS-134) must not
      // become the "last" one that undoLast reverts below.
      await migrateThrough(lifecycleDb.url, 'CreateDbRolesAndGrants1793664000000');

      // Verify 3 roles exist
      const roles = (await lifecycleDb.runner.query(
        "SELECT rolname FROM pg_roles WHERE rolname IN ('dbs_migrator', 'dbs_api', 'dbs_worker') ORDER BY rolname",
      )) as { rolname: string }[];
      expect(roles.map(r => r.rolname)).toEqual(['dbs_api', 'dbs_migrator', 'dbs_worker']);

      // Verify v_transfer_facts owner is dbs_migrator
      const [{ viewowner: initialOwner }] = (await lifecycleDb.runner.query(
        "SELECT viewowner FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_transfer_facts'",
      )) as { viewowner: string }[];
      expect(initialOwner).toBe('dbs_migrator');

      // 2. Idempotency: Running migration 7 up() a second time directly succeeds without errors
      const step7 = new CreateDbRolesAndGrants1793664000000();
      await expect(step7.up(lifecycleDb.runner)).resolves.not.toThrow();

      // Idempotency: Running standalone infra/scripts/db-roles.sql also succeeds cleanly
      await expect(lifecycleDb.runner.query(sql)).resolves.not.toThrow();

      // 3. Revert: down() reassigns v_transfer_facts owner to CURRENT_USER and revokes privileges
      await migrate(lifecycleDb.url, 'undoLast');
      const [{ viewowner: revertedOwner }] = (await lifecycleDb.runner.query(
        "SELECT viewowner FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_transfer_facts'",
      )) as { viewowner: string }[];
      expect(revertedOwner).not.toBe('dbs_migrator');

      // 4. Re-apply: up() succeeds again and re-assigns view ownership to dbs_migrator
      await migrate(lifecycleDb.url, 'up');
      const [{ viewowner: reappliedOwner }] = (await lifecycleDb.runner.query(
        "SELECT viewowner FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_transfer_facts'",
      )) as { viewowner: string }[];
      expect(reappliedOwner).toBe('dbs_migrator');
    } finally {
      await lifecycleDb.drop();
    }
  });

  it('TC-119-02 real API flows run as dbs_api: users row, deposit, transfer, replay, open account, revocation', async () => {
    const a = await seedDepositTarget(db.runner);
    const b = await seedDepositTarget(db.runner);
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

  it('TC-119-02 dbs_api cannot change history, other columns, or read worker tables (BL-017)', async () => {
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
    await denied(apiSource.query('SELECT 1 FROM notification_log'));
    await denied(
      apiSource.query(
        "INSERT INTO notification_log(event_id,kind,message) VALUES(gen_random_uuid(),'transfer_completed','x')",
      ),
    );
    await apiSource.query('SELECT 1 FROM reconciliation_runs');
    await denied(
      apiSource.query("INSERT INTO reconciliation_runs(started_at,status) VALUES(now(),'OK')"),
    );
    await denied(apiSource.query('DELETE FROM reconciliation_runs'));
    await denied(apiSource.query('TRUNCATE ledger_entries'));
  });

  it('TC-119-03 dbs_worker reads transfers only through view v_transfer_facts, manages worker tables, and cannot touch money (BL-005)', async () => {
    await workerSource.query('SELECT 1 FROM v_transfer_facts');
    await workerSource.query(
      "INSERT INTO notification_log(event_id,kind,message) VALUES(gen_random_uuid(),'transfer_completed','Giao dich da hoan tat')",
    );
    await workerSource.query('SELECT 1 FROM notification_log');
    await workerSource.query('DELETE FROM notification_log');
    await workerSource.query(
      "INSERT INTO reconciliation_runs(started_at,finished_at,status,total_debit,total_credit,total_balance,mismatched_accounts) VALUES(now(),now(),'OK',0,0,0,0)",
    );
    await workerSource.query('SELECT 1 FROM reconciliation_runs');
    await workerSource.query('DELETE FROM reconciliation_runs');
    await denied(workerSource.query('SELECT 1 FROM transfers'));
    await denied(workerSource.query('SELECT 1 FROM customers'));
    await denied(workerSource.query('SELECT 1 FROM users'));
    await denied(workerSource.query("UPDATE accounts SET status = 'LOCKED'"));
    await denied(workerSource.query('UPDATE ledger_entries SET amount = amount'));
    await denied(workerSource.query('DELETE FROM audit_log'));
    await denied(workerSource.query('DELETE FROM transfers'));
  });

  it('TC-119-03 the real outbox relay runs as dbs_worker with only its grants', async () => {
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
    // The deposit and the transfer of TC-119-02 left their own events in the outbox as well.
    const [{ pending }] = (await db.runner.query(
      'SELECT count(*)::int AS pending FROM outbox_events WHERE published_at IS NULL',
    )) as { pending: number }[];
    expect(pending).toBeGreaterThanOrEqual(1);
    expect(await relay.relayOnce()).toEqual({ published: pending });
    expect(sent).toHaveLength(pending * 2);
    const rows = (await db.runner.query(
      'SELECT published_at FROM outbox_events WHERE event_id=$1',
      [event.eventId],
    )) as { published_at: Date | null }[];
    expect(rows[0].published_at).not.toBeNull();
  });

  it('TC-92-13 the cleanup job runs as dbs_worker: old rows go, unpublished ones stay, no 42501', async () => {
    await clearOutbox(sql => db.runner.query(sql));
    await db.runner.query('DELETE FROM processed_events');
    await db.runner.query(
      `INSERT INTO outbox_events(event_id,event_type,aggregate_id,payload,correlation_id,created_at,published_at)
       VALUES (gen_random_uuid(),'TransferCompleted',gen_random_uuid(),'{}'::jsonb,gen_random_uuid(),now() - interval '9 days', now() - interval '9 days'),
              (gen_random_uuid(),'TransferCompleted',gen_random_uuid(),'{}'::jsonb,gen_random_uuid(),now() - interval '400 days', NULL),
              (gen_random_uuid(),'TransferCompleted',gen_random_uuid(),'{}'::jsonb,gen_random_uuid(),now(), now())`,
    );
    await db.runner.query(
      `INSERT INTO processed_events(consumer,event_id,processed_at)
       VALUES ('notification', gen_random_uuid(), now() - interval '9 days'),
              ('notification', gen_random_uuid(), now())`,
    );
    const tx = new TransactionService(workerSource, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const cleanup = new OutboxCleanupService(tx, {
      idempotencyKeyRetentionDays: 7,
      outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
    } as never);
    expect(await cleanup.cleanOnce({ pauseMs: 0 })).toMatchObject({ outbox: 1, processed: 1 });
    const left = (await db.runner.query(
      'SELECT published_at IS NULL AS unpublished FROM outbox_events ORDER BY created_at',
    )) as { unpublished: boolean }[];
    expect(left.map(r => r.unpublished)).toEqual([true, false]);
    expect(await db.runner.query('SELECT 1 FROM processed_events')).toHaveLength(1);
  });

  it('TC-119-04 assertNotMigratorUser guard blocks applications from connecting as dbs_migrator (DoD #2)', async () => {
    await expect(startDepositApp(urlFor('dbs_migrator'))).rejects.toThrow(/dbs_migrator/);
    const upperUrl = new URL(urlFor('dbs_migrator'));
    upperUrl.username = 'DBS_MIGRATOR';
    await expect(startDepositApp(upperUrl.toString())).rejects.toThrow(/dbs_migrator/);
    const encodedUrl = urlFor('dbs_migrator').replace('dbs_migrator', 'dbs%5Fmigrator');
    await expect(startDepositApp(encodedUrl)).rejects.toThrow(/dbs_migrator/);
  });

  it('TC-119-05 dbs_migrator owns public DDL/DML but append-only tables are protected by forbid_mutation trigger (AC-8.1)', async () => {
    // 1. DDL: dbs_migrator can create and drop tables in schema public
    await migratorSource.query(
      'CREATE TABLE public.dbs_migrator_ddl_test (id serial PRIMARY KEY, label text)',
    );
    await migratorSource.query(
      "INSERT INTO public.dbs_migrator_ddl_test (label) VALUES ('ddl-ok')",
    );
    const rows = await migratorSource.query<{ label: string }[]>(
      'SELECT label FROM public.dbs_migrator_ddl_test',
    );
    expect(rows).toEqual([{ label: 'ddl-ok' }]);
    await migratorSource.query('DROP TABLE public.dbs_migrator_ddl_test');

    // 2. Read access: dbs_migrator has SELECT on all tables
    await expect(
      migratorSource.query('SELECT 1 FROM public.transfers LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      migratorSource.query('SELECT 1 FROM public.ledger_entries LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      migratorSource.query('SELECT 1 FROM public.audit_log LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      migratorSource.query('SELECT 1 FROM public.risk_rule_sets LIMIT 1'),
    ).resolves.toBeDefined();

    // 3. Defense in depth (AC-8.1 & §8.3): Despite ALL PRIVILEGES, UPDATE/DELETE on append-only tables
    // are rejected by the forbid_mutation() trigger with SQLSTATE 42501 and message containing 'append-only'
    const triggerBlocked = (promise: Promise<unknown>) =>
      expect(promise).rejects.toMatchObject({
        driverError: {
          code: '42501',
          where: expect.stringMatching(/forbid_mutation/),
        },
        message: expect.stringMatching(/append-only/),
      });

    await triggerBlocked(migratorSource.query('UPDATE public.transfers SET amount = amount'));
    await triggerBlocked(migratorSource.query('DELETE FROM public.transfers'));
    await triggerBlocked(migratorSource.query('UPDATE public.ledger_entries SET amount = amount'));
    await triggerBlocked(migratorSource.query('DELETE FROM public.ledger_entries'));
    await triggerBlocked(migratorSource.query('UPDATE public.audit_log SET action = action'));
    await triggerBlocked(migratorSource.query('DELETE FROM public.audit_log'));
    await triggerBlocked(migratorSource.query('UPDATE public.risk_rule_sets SET config = config'));
    await triggerBlocked(migratorSource.query('DELETE FROM public.risk_rule_sets'));
  });

  it('TC-RSK01-11b dbs_migrator gets ALL on risk_decisions by default privileges, and the trigger still refuses', async () => {
    // A private database: the committed transfer and decision must not reach the reconciliation and
    // invariant checks of this file's shared database.
    const own = await createTempDatabase();
    let migrator: DataSource | undefined;
    try {
      await migrate(own.url);
      const [user] = await own.runner.query(
        'INSERT INTO users(cognito_sub) VALUES($1) RETURNING id',
        [randomUUID()],
      );
      const [customer] = await own.runner.query(
        "INSERT INTO customers(user_id,full_name) VALUES($1,'Trần Văn An') RETURNING id",
        [user.id],
      );
      const accounts: { id: string }[] = await own.runner.query(
        "INSERT INTO accounts(customer_id,type) VALUES($1,'CHECKING'),($1,'SAVINGS') RETURNING id",
        [customer.id],
      );
      const [transfer] = await own.runner.query(
        `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,initiated_by,correlation_id)
         VALUES('TRANSFER',$1,$2,'1000000','COMPLETED',$3,$4) RETURNING id`,
        [accounts[0].id, accounts[1].id, user.id, randomUUID()],
      );
      await insertRuleOnlyDecision(own.runner, transfer.id);
      const url = new URL(own.url);
      url.username = 'dbs_migrator';
      url.password = PASSWORD;
      migrator = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
      const blocked = (promise: Promise<unknown>) =>
        expect(promise).rejects.toMatchObject({
          driverError: { code: '42501', where: expect.stringMatching(/forbid_mutation/) },
          message: expect.stringMatching(/append-only/),
        });
      // CASCADE gets past the FK check (fraud_flags references this table) to the TRUNCATE trigger.
      await blocked(migrator.query('UPDATE public.risk_decisions SET rule_score = 0'));
      await blocked(migrator.query('DELETE FROM public.risk_decisions'));
      await blocked(migrator.query('TRUNCATE public.risk_decisions CASCADE'));
      expect(await own.runner.query('SELECT count(*)::int AS n FROM risk_decisions')).toEqual([
        { n: 1 },
      ]);
    } finally {
      await migrator?.destroy();
      await own.drop();
    }
  });

  it('TC-RSK01-11a db-roles.sql on a fully migrated database grants risk_decisions S to dbs_api and S I to dbs_worker, nothing more', async () => {
    await expect(db.runner.query(sql)).resolves.not.toThrow();
    const privileges = await db.runner.query(
      `SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.risk_decisions', p) AS granted
         FROM unnest(ARRAY['dbs_api','dbs_worker']) AS r,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
        ORDER BY r, p`,
    );
    const granted = (privileges as { role: string; privilege: string; granted: boolean }[])
      .filter(row => row.granted)
      .map(row => `${row.role}:${row.privilege}`);
    expect(granted).toEqual(['dbs_api:SELECT', 'dbs_worker:INSERT', 'dbs_worker:SELECT']);
    await expect(apiSource.query('SELECT count(*) FROM risk_decisions')).resolves.toBeDefined();
    await denied(apiSource.query('UPDATE risk_decisions SET rule_score = 0'));
    await denied(workerSource.query('DELETE FROM risk_decisions'));
  });

  it('TC-117-10 the real reconciliation job runs as dbs_worker and enforces reconciliation_runs grants', async () => {
    const tx = new TransactionService(workerSource, {
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    } as never);
    const reconciliation = new ReconciliationService(tx, new SystemClock(), {
      transfer: { perTx: parsePositiveMoney('50000000'), perDay: parsePositiveMoney('200000000') },
      idempotencyKeyRetentionDays: 7,
      outbox: { retentionDays: 7, processedEventsRetentionDays: 7 },
      rateLimit: { transfersPerMinute: 10, requestsPerIpPerMinute: 100 },
      reconciliationIntervalMs: 300_000,
    });

    const outcome = await reconciliation.reconcileOnce();
    expect(outcome).toMatchObject({
      executed: true,
      status: 'OK',
      totalDebit: '1300000',
      totalCredit: '1300000',
      totalBalance: '0',
      mismatchedAccounts: 0,
      details: [],
    });

    // dbs_api can SELECT reconciliation_runs, but cannot INSERT/UPDATE/DELETE
    const runs = await apiSource.query<Array<{ status: string }>>(
      'SELECT status FROM reconciliation_runs ORDER BY id DESC LIMIT 1',
    );
    expect(runs).toEqual([{ status: 'OK' }]);
    await denied(
      apiSource.query(
        "INSERT INTO reconciliation_runs (finished_at, status) VALUES (now(), 'ERROR')",
      ),
    );
    await denied(apiSource.query("UPDATE reconciliation_runs SET status = 'ERROR'"));
    await denied(apiSource.query('DELETE FROM reconciliation_runs'));

    // dbs_worker matrix (database-design §8.1): S I D on reconciliation_runs (D is for the 90-day
    // retention job), but never UPDATE: a stored run is history. INSERT was exercised by reconcileOnce above.
    await expect(
      workerSource.query('SELECT 1 FROM reconciliation_runs LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      workerSource.query('DELETE FROM reconciliation_runs WHERE false'),
    ).resolves.toBeDefined();
    await denied(workerSource.query("UPDATE reconciliation_runs SET status = 'ERROR'"));
  });
});
