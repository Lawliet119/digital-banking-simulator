import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { validateEvent } from '@common/events';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

const FUNDING = '00000000-0000-4000-8000-000000000001';
describe('DBS-60 operator deposits through real JWT/HTTP/PG and double entry', () => {
  let db: TempDatabase, app: Awaited<ReturnType<typeof startDepositApp>>, token: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const deposit = (
    toAccountId: string,
    amount = '1000000',
    key: string = randomUUID(),
    jwt = token,
  ) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(jwt, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ toAccountId, amount });
  const totals = () =>
    q(
      `SELECT (SELECT count(*) FROM transfers)::int AS transfers,(SELECT count(*) FROM ledger_entries)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM outbox_events)::int AS events,(SELECT count(*) FROM idempotency_keys)::int AS keys,(SELECT jsonb_object_agg(id,balance::text) FROM accounts) AS balances`,
    );
  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    token = await app.issuer.token('operator', { sub: randomUUID() });
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

  it('TC-60-12 missing funding is500, not a business rejection, key rolled back', async () => {
    const target = await seedDepositTarget(db.runner);
    await q('DELETE FROM accounts WHERE id=$1', [FUNDING]);
    try {
      const before = await totals();
      await deposit(target.accountId).expect(500);
      expect(await totals()).toEqual(before);
    } finally {
      await q("INSERT INTO accounts(id,type) VALUES($1,'SYSTEM')", [FUNDING]);
    }
  });

  it('TC-60-01 deposits1m with exactly two ledger lines, audit, outbox and stored result', async () => {
    const target = await seedDepositTarget(db.runner),
      key = randomUUID();
    const res = await deposit(target.accountId, '1000000', key).expect(201);
    expect(res.body).toEqual({ transferId: expect.any(String), status: 'COMPLETED' });
    expect(await q('SELECT balance::text FROM accounts WHERE id=$1', [FUNDING])).toEqual([
      { balance: '-1000000' },
    ]);
    expect(await q('SELECT balance::text FROM accounts WHERE id=$1', [target.accountId])).toEqual([
      { balance: '1000000' },
    ]);
    const [transfer] = await q('SELECT * FROM transfers WHERE id=$1', [res.body.transferId]);
    expect(transfer).toMatchObject({
      type: 'DEPOSIT',
      amount: '1000000',
      status: 'COMPLETED',
      from_account_id: FUNDING,
      to_account_id: target.accountId,
      correlation_id: res.headers['x-correlation-id'],
    });
    expect(
      await q(
        'SELECT account_id,direction,amount::text,balance_after::text FROM ledger_entries WHERE transfer_id=$1 ORDER BY direction',
        [res.body.transferId],
      ),
    ).toEqual([
      {
        account_id: target.accountId,
        direction: 'CREDIT',
        amount: '1000000',
        balance_after: '1000000',
      },
      { account_id: FUNDING, direction: 'DEBIT', amount: '1000000', balance_after: '-1000000' },
    ]);
    const [audit] = await q('SELECT * FROM audit_log WHERE target_id=$1', [res.body.transferId]);
    expect(audit).toMatchObject({
      actor_user_id: transfer.initiated_by,
      actor_role: 'operator',
      outcome: 'SUCCESS',
      correlation_id: res.headers['x-correlation-id'],
      metadata: { id: target.accountId },
    });
    const [outbox] = await q(
      'SELECT payload,correlation_id FROM outbox_events WHERE aggregate_id=$1',
      [res.body.transferId],
    );
    expect(validateEvent(outbox.payload).ok).toBe(true);
    expect(outbox.payload).toMatchObject({
      type: 'DEPOSIT',
      fromUserId: null,
      sameOwner: false,
      toUserId: target.userId,
      fromBalanceBefore: '0',
      occurredAt: transfer.created_at.toISOString(),
      correlationId: res.headers['x-correlation-id'],
    });
    expect(
      await q(
        'SELECT transfer_id,response_code,response_body FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2',
        [transfer.initiated_by, key],
      ),
    ).toEqual([{ transfer_id: res.body.transferId, response_code: 201, response_body: res.body }]);
    expect(
      await q('SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1', [
        res.body.transferId,
      ]),
    ).toEqual([{ n: 1 }]);
    expect(
      await q('SELECT count(*)::int AS n FROM audit_log WHERE target_id=$1', [res.body.transferId]),
    ).toEqual([{ n: 1 }]);
  });

  it('TC-60-02 SYSTEM may go negative and bypass regular limits; negative source snapshot', async () => {
    const target = await seedDepositTarget(db.runner),
      amount = '300000000';
    const [before] = await q('SELECT balance::text FROM accounts WHERE id=$1', [FUNDING]);
    const res = await deposit(target.accountId, amount).expect(201);
    const [event] = await q('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [
      res.body.transferId,
    ]);
    expect(event.payload.fromBalanceBefore).toBe(before.balance);
    expect(validateEvent(event.payload).ok).toBe(true);
    expect(await q('SELECT balance::text FROM accounts WHERE id=$1', [target.accountId])).toEqual([
      { balance: amount },
    ]);
  });

  it('TC-60-03 LOCKED/missing/SYSTEM targets commit rejection only, correct nullable FK', async () => {
    const locked = await seedDepositTarget(db.runner, 'LOCKED');
    for (const id of [locked.accountId, randomUUID(), FUNDING]) {
      const key = randomUUID(),
        before = await q('SELECT id,balance::text FROM accounts ORDER BY id');
      const res = await deposit(id, '1000000', key).expect(422);
      expect(res.body.errorCode).toBe('ACCOUNT_NOT_ACTIVE');
      const [t] = await q('SELECT status,to_account_id,reject_reason FROM transfers WHERE id=$1', [
        res.body.transferId,
      ]);
      expect(t).toEqual({
        status: 'REJECTED',
        to_account_id: id === locked.accountId ? id : null,
        reject_reason: 'ACCOUNT_NOT_ACTIVE',
      });
      expect(await q('SELECT id,balance::text FROM accounts ORDER BY id')).toEqual(before);
      expect(
        await q('SELECT count(*)::int AS n FROM ledger_entries WHERE transfer_id=$1', [
          res.body.transferId,
        ]),
      ).toEqual([{ n: 0 }]);
      expect(
        await q('SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1', [
          res.body.transferId,
        ]),
      ).toEqual([{ n: 0 }]);
      expect(
        await q('SELECT outcome,metadata FROM audit_log WHERE target_id=$1', [res.body.transferId]),
      ).toEqual([{ outcome: 'REJECTED', metadata: { id, reason: 'ACCOUNT_NOT_ACTIVE' } }]);
      expect(
        await q('SELECT response_code FROM idempotency_keys WHERE idem_key=$1', [key]),
      ).toEqual([{ response_code: 422 }]);
    }
  });

  it('TC-60-04 real auth and strict DTO refuse unauthorized/invalid requests without money writes', async () => {
    const target = await seedDepositTarget(db.runner),
      before = await totals();
    expect(
      (await request(app.url).post('/v1/operator/deposits').send({}).expect(401)).body.errorCode,
    ).toBe('UNAUTHENTICATED');
    const expired = await app.issuer.token('operator', { sub: randomUUID(), iat: 1, exp: 2 });
    expect(
      (await deposit(target.accountId, '1', randomUUID(), expired).expect(401)).body.errorCode,
    ).toBe('TOKEN_EXPIRED');
    for (const role of ['customer', 'auditor', 'admin'] as const) {
      const jwt = await app.issuer.token(role, { sub: randomUUID() });
      expect(
        (await deposit(target.accountId, '1', randomUUID(), jwt).expect(403)).body.errorCode,
      ).toBe('FORBIDDEN');
    }
    for (const amount of [100, '0', '-1', '1.5', '1e3', '01', '9223372036854775808'])
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: target.accountId, amount })
        .expect(400);
    await deposit('not-a-uuid').expect(400);
    for (const field of ['fromAccountId', 'userId', 'correlationId', 'balance'])
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: target.accountId, amount: '1', [field]: randomUUID() })
        .expect(400);
    expect(await totals()).toEqual(before);
  });

  it('TC-60-05 key is required/bounded; canonical hash and result stored', async () => {
    const target = await seedDepositTarget(db.runner);
    for (const key of [undefined, '   ']) {
      let req = request(app.url).post('/v1/operator/deposits').auth(token, { type: 'bearer' });
      if (key !== undefined) req = req.set('Idempotency-Key', key);
      const res = await req.send({ toAccountId: target.accountId, amount: '1' }).expect(400);
      expect(res.body.errorCode).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
    await deposit(target.accountId, '1', 'k'.repeat(129)).expect(400);
    await deposit(target.accountId, '1', 'k'.repeat(128)).expect(201);
    const [row] = await q(
      'SELECT request_hash,response_code FROM idempotency_keys WHERE idem_key=$1',
      ['k'.repeat(128)],
    );
    expect(row.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.response_code).toBe(201);
  });

  it('TC-60-06 concurrent distinct keys lose no money; repeated keys do not double-credit, scoped by actor', async () => {
    const target = await seedDepositTarget(db.runner);
    const first = await Promise.all(
      Array.from({ length: 10 }, () => deposit(target.accountId, '1000')),
    );
    expect(first.every(r => r.status === 201)).toBe(true);
    const key = randomUUID(),
      same = await Promise.all(
        Array.from({ length: 10 }, () => deposit(target.accountId, '1000', key)),
      );
    // DBS-79: repeats replay the first execution's answer; only one deposit is made.
    expect(same.every(r => r.status === 201)).toBe(true);
    expect(new Set(same.map(r => r.body.transferId as string)).size).toBe(1);
    const other = await app.issuer.token('operator', { sub: randomUUID() });
    await deposit(target.accountId, '1000', key, other).expect(201);
    expect(await q('SELECT balance::text FROM accounts WHERE id=$1', [target.accountId])).toEqual([
      { balance: '12000' },
    ]);
    expect(
      await q('SELECT count(*)::int AS n FROM transfers WHERE to_account_id=$1', [
        target.accountId,
      ]),
    ).toEqual([{ n: 12 }]);
  });

  it('TC-79-05 deposit replay returns the stored 201 once; another body is 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const target = await seedDepositTarget(db.runner),
      key = randomUUID();
    const first = await deposit(target.accountId, '5000', key).expect(201);
    const before = await totals();
    const again = await deposit(target.accountId, '5000', key).expect(201);
    expect(again.body).toEqual(first.body);
    const reused = await deposit(target.accountId, '6000', key).expect(422);
    expect(reused.body.errorCode).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await totals()).toEqual(before);
  });
  it('TC-79-06 a rejected deposit replays the same 422 and transferId', async () => {
    const locked = await seedDepositTarget(db.runner, 'LOCKED'),
      key = randomUUID();
    const first = await deposit(locked.accountId, '5000', key).expect(422);
    const before = await totals();
    const again = await deposit(locked.accountId, '5000', key).expect(422);
    expect(again.body).toMatchObject({
      errorCode: first.body.errorCode,
      transferId: first.body.transferId,
    });
    expect(await totals()).toEqual(before);
  });

  async function fault(table: string, timing: string, body: string, action: () => Promise<void>) {
    const allowed = new Set([
      'audit_log',
      'outbox_events',
      'ledger_entries',
      'accounts',
      'idempotency_keys',
    ]);
    if (!allowed.has(table)) throw Error('Bad fixture table');
    await q(
      `CREATE FUNCTION dbs60_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; RETURN NEW; END $$`,
    );
    await q(
      `CREATE TRIGGER dbs60_fail ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION dbs60_fail()`,
    );
    try {
      await action();
    } finally {
      await q(`DROP TRIGGER dbs60_fail ON ${table}`);
      await q('DROP FUNCTION dbs60_fail()');
    }
  }
  it.each([
    ['TC-60-07', 'audit_log', 'BEFORE INSERT', "RAISE EXCEPTION 'audit failed'"],
    ['TC-60-08a', 'outbox_events', 'BEFORE INSERT', "RAISE EXCEPTION 'outbox failed'"],
    [
      'TC-60-08b',
      'ledger_entries',
      'BEFORE INSERT',
      "IF NEW.direction='CREDIT' THEN RAISE EXCEPTION 'credit failed'; END IF",
    ],
    [
      'TC-60-09',
      'accounts',
      'BEFORE UPDATE',
      "IF NEW.type <> 'SYSTEM' THEN RAISE EXCEPTION 'target update failed'; END IF",
    ],
  ])(
    '%s actual %s failure rolls back everything and same-key retry succeeds',
    async (_id, table, timing, body) => {
      const target = await seedDepositTarget(db.runner),
        key = randomUUID(),
        before = await totals();
      await fault(table, timing, body, async () => {
        const res = await deposit(target.accountId, '1000000', key).expect(500);
        expect(res.body.detail).toBe('Internal server error');
        expect(await totals()).toEqual(before);
      });
      await deposit(target.accountId, '1000000', key).expect(201);
    },
  );
  it('TC-60-07b rejected audit failure leaves no rejected transfer/key', async () => {
    const target = await seedDepositTarget(db.runner, 'LOCKED'),
      before = await totals();
    await fault('audit_log', 'BEFORE INSERT', "RAISE EXCEPTION 'audit failed'", async () => {
      await deposit(target.accountId).expect(500);
      expect(await totals()).toEqual(before);
    });
  });

  it('TC-60-09b final key UPDATE failure rolls back successful and rejected results', async () => {
    for (const status of ['ACTIVE', 'LOCKED'] as const) {
      const target = await seedDepositTarget(db.runner, status),
        key = randomUUID(),
        before = await totals();
      await fault(
        'idempotency_keys',
        'BEFORE UPDATE',
        "RAISE EXCEPTION 'result storage failed'",
        async () => {
          await deposit(target.accountId, '1000', key).expect(500);
          expect(await totals()).toEqual(before);
        },
      );
      await deposit(target.accountId, '1000', key).expect(status === 'ACTIVE' ? 201 : 422);
    }
  });

  it('TC-60-10 actual funding lock timeout503 rolls back key; release/retry works', async () => {
    const target = await seedDepositTarget(db.runner),
      key = randomUUID(),
      before = await totals(),
      held = app.source.createQueryRunner();
    await held.connect();
    await held.startTransaction();
    try {
      await held.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [FUNDING]);
      const res = await deposit(target.accountId, '1000', key).expect(503);
      expect(res.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(await totals()).toEqual(before);
    } finally {
      await held.rollbackTransaction();
      await held.release();
    }
    await deposit(target.accountId, '1000', key).expect(201);
  });

  it('TC-60-11 exact above2^53 across money tables/event; funding capacity overflow500 is atomic', async () => {
    const target = await seedDepositTarget(db.runner),
      amount = '9007199254740993';
    const res = await deposit(target.accountId, amount).expect(201);
    expect(await q('SELECT balance::text FROM accounts WHERE id=$1', [target.accountId])).toEqual([
      { balance: amount },
    ]);
    expect(
      await q('SELECT amount::text FROM ledger_entries WHERE transfer_id=$1', [
        res.body.transferId,
      ]),
    ).toEqual([{ amount }, { amount }]);
    const [event] = await q('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [
      res.body.transferId,
    ]);
    expect(event.payload.amount).toBe(amount);
    expect(validateEvent(event.payload).ok).toBe(true);
    const capTarget = await seedDepositTarget(db.runner),
      [funding] = await q('SELECT balance::text FROM accounts WHERE id=$1', [FUNDING]);
    const capacity = (2n ** 63n + BigInt(funding.balance)).toString();
    await deposit(capTarget.accountId, capacity).expect(201);
    const before = await totals();
    await deposit(target.accountId, '1').expect(500);
    expect(await totals()).toEqual(before);
  });

  it('TC-60-13 OpenAPI includes operator auth,key,amountstring and status responses', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    const route = doc.paths['/v1/operator/deposits'].post!;
    expect(route.security).toContainEqual({ 'access-token': [] });
    for (const status of ['201', '400', '401', '403', '422', '500', '503'])
      expect(route.responses[status]).toBeDefined();
    expect(JSON.stringify(route.parameters)).toContain('Idempotency-Key');
    expect(JSON.stringify(doc.components!.schemas!.DepositDto)).toContain('1000000');
  });
});
