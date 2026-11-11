import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { startDepositApp, seedDepositTarget, type DepositApp } from '../support/deposit-app';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

type Row = Record<string, unknown>;

/**
 * DBS-158, the parts main did not have yet (the rest of the original suite repeated tests that exist:
 * TC-86-02/03, TC-87-06, TC-61-03, TC-65-05, TC-159-01, TC-87-09):
 *  - DoD 2: every error is problem+json and never exposes a stack, SQL or an internal path;
 *  - AC-8.1: an auditor is refused on EVERY write route (not only two) and nothing is written.
 */
describe('DBS-158 security boundaries on the real app and PostgreSQL', () => {
  let db: TempDatabase;
  let app: DepositApp;
  const q = (sql: string, args: unknown[] = []): Promise<Row[]> =>
    db.runner.query(sql, args) as Promise<Row[]>;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { audit: true, fraud: true });
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  const INTERNALS =
    /\bstack\b|at \S+ \(|node_modules|\.ts:\d+|\bSELECT\b[^.]*\bFROM\b|\bINSERT INTO\b|\bUPDATE \w+ SET\b|QueryFailed|\bpg_\w+|ECONN|relation "/i;

  it('TC-158-01 DoD 2: 401, 403, 404 and 400 are application/problem+json with a correlationId and no internals', async () => {
    const victim = await seedDepositTarget(db.runner);
    const attacker = await seedDepositTarget(db.runner);
    const customer = await app.issuer.token('customer', { sub: attacker.sub });
    const auditor = await app.issuer.token('auditor', { sub: randomUUID() });
    const cases: [string, number, request.Test][] = [
      ['no token', 401, request(app.url).get('/v1/accounts')],
      [
        'wrong role',
        403,
        request(app.url).get('/v1/audit/entries').auth(customer, { type: 'bearer' }),
      ],
      [
        'foreign account',
        404,
        request(app.url).get(`/v1/accounts/${victim.accountId}`).auth(customer, { type: 'bearer' }),
      ],
      [
        'malformed id',
        404,
        request(app.url).get('/v1/accounts/not-a-uuid').auth(customer, { type: 'bearer' }),
      ],
      [
        'bad query',
        400,
        request(app.url).get('/v1/audit/entries?limit=0').auth(auditor, { type: 'bearer' }),
      ],
      ['unknown route', 404, request(app.url).get('/v1/no-such-route')],
    ];
    for (const [name, status, call] of cases) {
      const res = await call;
      expect([name, res.status]).toEqual([name, status]);
      expect([name, String(res.headers['content-type'])]).toEqual([
        name,
        expect.stringContaining('application/problem+json') as unknown as string,
      ]);
      const body = res.body as Row;
      expect(body.status).toBe(status);
      expect(String(body.correlationId)).toMatch(/^[0-9a-f-]{36}$/);
      expect([name, JSON.stringify(body).match(INTERNALS)]).toEqual([name, null]);
    }
  });

  it('TC-158-02 AC-8.1: an auditor is refused on every write route and no row is written anywhere', async () => {
    const target = await seedDepositTarget(db.runner);
    const other = await seedDepositTarget(db.runner);
    const auditor = await app.issuer.token('auditor', { sub: randomUUID() });
    const count = async (): Promise<Row> =>
      (
        await q(`SELECT
          (SELECT count(*) FROM transfers)::int AS transfers,
          (SELECT count(*) FROM ledger_entries)::int AS ledger_entries,
          (SELECT count(*) FROM accounts)::int AS accounts,
          (SELECT count(*) FROM customers)::int AS customers,
          (SELECT count(*) FROM outbox_events)::int AS outbox_events,
          (SELECT count(*) FROM fraud_flags)::int AS fraud_flags,
          (SELECT count(*) FROM audit_log)::int AS audit_log`)
      )[0];
    const before = await count();
    const writes: [string, string, Row][] = [
      [
        '/v1/transfers',
        'POST',
        { fromAccountId: target.accountId, toAccountId: other.accountId, amount: '1000' },
      ],
      ['/v1/operator/deposits', 'POST', { toAccountId: target.accountId, amount: '1000' }],
      ['/v1/accounts', 'POST', { type: 'CHECKING' }],
      ['/v1/customers/me', 'POST', { fullName: 'Trần Văn An' }],
      [`/v1/operator/accounts/${target.accountId}/lock`, 'POST', { reason: 'CONFIRMED_FRAUD' }],
      [`/v1/operator/accounts/${target.accountId}/unlock`, 'POST', { reason: 'OPERATOR_UNLOCK' }],
      [`/v1/operator/fraud-flags/${randomUUID()}/review`, 'POST', { decision: 'FALSE_POSITIVE' }],
    ];
    for (const [path, method, body] of writes) {
      const res = await request(app.url)
        .post(path)
        .auth(auditor, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(body);
      expect([method, path, res.status]).toEqual([method, path, 403]);
      expect((res.body as Row).errorCode).toBe('FORBIDDEN');
    }
    expect(await count()).toEqual(before);
  });
});
