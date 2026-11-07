import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { validateEvent } from '@common/events';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

const FUNDING = '00000000-0000-4000-8000-000000000001';
type Target = Awaited<ReturnType<typeof seedDepositTarget>> & { token: string };
describe('DBS-61 customer transfers: actual JWT/HTTP/PG double entry', () => {
  let db: TempDatabase, app: Awaited<ReturnType<typeof startDepositApp>>, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const balance = async (id: string): Promise<string> => {
    const rows = (await q('SELECT balance::text FROM accounts WHERE id=$1', [id])) as {
      balance: string;
    }[];
    return rows[0].balance;
  };
  const totals = () =>
    q(`SELECT (SELECT count(*) FROM transfers)::int AS transfers,
    (SELECT count(*) FROM ledger_entries)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audits,
    (SELECT count(*) FROM outbox_events)::int AS events,(SELECT count(*) FROM idempotency_keys)::int AS keys,
    (SELECT jsonb_object_agg(id,balance::text) FROM accounts) AS balances`);
  const send = (body: object, jwt: string, key: string | null = randomUUID()) => {
    const r = request(app.url).post('/v1/transfers').auth(jwt, { type: 'bearer' });
    if (key !== null) r.set('Idempotency-Key', key);
    return r.send(body);
  };
  const transfer = (a: Target, to: string, amount = '300000', key: string = randomUUID()) =>
    send({ fromAccountId: a.accountId, toAccountId: to, amount }, a.token, key);
  async function target(amount = '0', status: 'ACTIVE' | 'LOCKED' = 'ACTIVE'): Promise<Target> {
    const row = await seedDepositTarget(db.runner, status);
    const token = await app.issuer.token('customer', { sub: row.sub });
    if (amount !== '0')
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operator, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: row.accountId, amount })
        .expect(201);
    return { ...row, token };
  }
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

  it('TC-61-01 AC5.1 A1m → B300k: exact atomic rows, snapshots and canonical hash', async () => {
    const a = await target('1000000'),
      b = await target(),
      key = randomUUID();
    const res = await send(
      {
        fromAccountId: a.accountId.toUpperCase(),
        toAccountId: b.accountId.toUpperCase(),
        amount: '300000',
      },
      a.token,
      key,
    ).expect(201);
    expect(res.body).toEqual({ transferId: expect.any(String), status: 'COMPLETED' });
    expect(await balance(a.accountId)).toBe('700000');
    expect(await balance(b.accountId)).toBe('300000');
    const [row] = await q('SELECT * FROM transfers WHERE id=$1', [res.body.transferId]);
    expect(row).toMatchObject({
      type: 'TRANSFER',
      amount: '300000',
      status: 'COMPLETED',
      reject_reason: null,
      from_account_id: a.accountId,
      to_account_id: b.accountId,
      initiated_by: a.userId,
      correlation_id: res.headers['x-correlation-id'],
    });
    expect(
      await q(
        'SELECT account_id,direction,amount::text,balance_after::text FROM ledger_entries WHERE transfer_id=$1 ORDER BY direction',
        [row.id],
      ),
    ).toEqual([
      { account_id: b.accountId, direction: 'CREDIT', amount: '300000', balance_after: '300000' },
      { account_id: a.accountId, direction: 'DEBIT', amount: '300000', balance_after: '700000' },
    ]);
    const audits = await q('SELECT * FROM audit_log WHERE target_id=$1', [row.id]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: a.userId,
      actor_role: 'customer',
      action: 'transfer',
      outcome: 'SUCCESS',
      correlation_id: row.correlation_id,
      metadata: { id: b.accountId },
    });
    const events = await q(
      'SELECT payload,correlation_id FROM outbox_events WHERE aggregate_id=$1',
      [row.id],
    );
    expect(events).toHaveLength(1);
    expect(validateEvent(events[0].payload).ok).toBe(true);
    expect(events[0].payload).toMatchObject({
      type: 'TRANSFER',
      amount: '300000',
      fromBalanceBefore: '1000000',
      fromUserId: a.userId,
      toUserId: b.userId,
      sameOwner: false,
      occurredAt: row.created_at.toISOString(),
      correlationId: row.correlation_id,
    });
    const dates = await q('SELECT id,created_at FROM accounts WHERE id=ANY($1::uuid[])', [
      [a.accountId, b.accountId],
    ]);
    expect(events[0].payload.fromAccountCreatedAt).toBe(
      dates.find((d: { id: string }) => d.id === a.accountId).created_at.toISOString(),
    );
    expect(events[0].payload.toAccountCreatedAt).toBe(
      dates.find((d: { id: string }) => d.id === b.accountId).created_at.toISOString(),
    );
    expect(events[0].correlation_id).toBe(row.correlation_id);
    expect(
      await q(
        'SELECT request_hash,response_code,response_body,transfer_id FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2',
        [a.userId, key],
      ),
    ).toEqual([
      {
        request_hash: createHash('sha256')
          .update(
            JSON.stringify({
              method: 'POST',
              path: '/v1/transfers',
              body: { amount: '300000', fromAccountId: a.accountId, toAccountId: b.accountId },
            }),
          )
          .digest('hex'),
        response_code: 201,
        response_body: res.body,
        transfer_id: row.id,
      },
    ]);
  });

  async function assertRejected(
    a: Target,
    to: string,
    amount: string,
    code: string,
    expectedTarget: string | null,
  ) {
    const key = randomUUID(),
      before = await totals();
    const res = await transfer(a, to, amount, key).expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      errorCode: code,
      status: 422,
      transferId: expect.any(String),
      correlationId: res.headers['x-correlation-id'],
    });
    expect(await totals()).toEqual([
      {
        ...before[0],
        transfers: before[0].transfers + 1,
        audits: before[0].audits + 1,
        keys: before[0].keys + 1,
      },
    ]);
    expect(
      await q('SELECT status,reject_reason,to_account_id FROM transfers WHERE id=$1', [
        res.body.transferId,
      ]),
    ).toEqual([{ status: 'REJECTED', reject_reason: code, to_account_id: expectedTarget }]);
    expect(
      await q('SELECT outcome,metadata FROM audit_log WHERE target_id=$1', [res.body.transferId]),
    ).toEqual([{ outcome: 'REJECTED', metadata: { id: to, reason: code } }]);
    expect(
      await q(
        'SELECT response_code,response_body FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2',
        [a.userId, key],
      ),
    ).toMatchObject([
      { response_code: 422, response_body: { errorCode: code, transferId: res.body.transferId } },
    ]);
  }
  it('TC-61-02 AC5.2 insufficient commits rejection, no ledger/event/money', async () => {
    const a = await target('100000'),
      b = await target();
    await assertRejected(a, b.accountId, '300000', 'INSUFFICIENT_FUNDS', b.accountId);
    expect(await balance(a.accountId)).toBe('100000');
    expect(await balance(b.accountId)).toBe('0');
  });
  it('TC-61-03 foreign/missing/SYSTEM sources uniformly404 and independently DENIED', async () => {
    const a = await target('1000000'),
      b = await target();
    const bodies: unknown[] = [];
    for (const source of [b.accountId, randomUUID(), FUNDING]) {
      const before = await totals();
      const res = await send(
        { fromAccountId: source, toAccountId: a.accountId, amount: '1' },
        a.token,
      ).expect(404);
      expect(res.body).not.toHaveProperty('transferId');
      // AC-5.8: the caller must not be able to tell the three cases apart.
      const { correlationId: _correlationId, ...sameForAll } = res.body as Record<string, unknown>;
      bodies.push(sameForAll);
      expect(await totals()).toEqual([{ ...before[0], audits: before[0].audits + 1 }]);
      expect(
        await q(
          'SELECT actor_user_id,outcome,metadata,correlation_id FROM audit_log WHERE target_id=$1 AND action=$2',
          [source, 'ledger.transfer'],
        ),
      ).toContainEqual({
        actor_user_id: a.userId,
        outcome: 'DENIED',
        metadata: { reason: 'NOT_OWNER' },
        correlation_id: res.headers['x-correlation-id'],
      });
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
  it('TC-61-04 ACTIVE first: locked source/target, missing/SYSTEM target are persisted422', async () => {
    const a = await target('1000000'),
      b = await target(),
      poor = await target('100'),
      locked = await target('0', 'LOCKED');
    // A locked destination wins over an insufficient balance: ACTIVE is checked before the balance.
    await assertRejected(poor, locked.accountId, '300000', 'ACCOUNT_NOT_ACTIVE', locked.accountId);
    for (const [to, fk] of [
      [locked.accountId, locked.accountId],
      [randomUUID(), null],
      [FUNDING, null],
    ])
      await assertRejected(a, to!, '300000', 'ACCOUNT_NOT_ACTIVE', fk);
    await assertRejected(locked, b.accountId, '1', 'ACCOUNT_NOT_ACTIVE', b.accountId);
  });
  it('TC-61-05 JWT/role/input/key validation has no business effects', async () => {
    const a = await target('1000000'),
      b = await target(),
      body = { fromAccountId: a.accountId, toAccountId: b.accountId, amount: '1' };
    const before = await totals();
    const none = await request(app.url).post('/v1/transfers').send(body).expect(401);
    expect(none.body.errorCode).toBe('UNAUTHENTICATED');
    const expired = await app.issuer.token('customer', { sub: a.sub, iat: 1, exp: 2 });
    expect((await send(body, expired).expect(401)).body.errorCode).toBe('TOKEN_EXPIRED');
    for (const role of ['operator', 'auditor', 'admin'] as const)
      expect(
        (await send(body, await app.issuer.token(role, { sub: randomUUID() })).expect(403)).body
          .errorCode,
      ).toBe('FORBIDDEN');
    for (const key of [null, '', ' '])
      expect((await send(body, a.token, key).expect(400)).body.errorCode).toBe(
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    await send(body, a.token, 'k'.repeat(129)).expect(400);
    for (const amount of [
      1,
      '0',
      '-1',
      '1.2',
      '01',
      '9223372036854775808',
      '1; DROP TABLE accounts',
    ])
      await send({ ...body, amount }, a.token).expect(400);
    await send({ ...body, fromAccountId: 'bad' }, a.token).expect(400);
    await send({ ...body, toAccountId: 'bad' }, a.token).expect(400);
    await send({ ...body, toAccountId: a.accountId.toUpperCase() }, a.token).expect(400);
    await send({ ...body, userId: b.userId }, a.token).expect(400);
    expect(await totals()).toEqual(before);
    await send(body, a.token, 'k'.repeat(128)).expect(201);
  });
  it('TC-61-06 ten concurrent withdrawals cannot overspend; opposite-direction transfers finish', async () => {
    const a = await target('1000000'),
      b = await target();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(a, b.accountId, '200000')),
    );
    expect(results.filter(r => r.status === 201)).toHaveLength(5);
    expect(
      results.filter(r => r.status === 422 && r.body.errorCode === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(5);
    expect(await balance(a.accountId)).toBe('0');
    expect(await balance(b.accountId)).toBe('1000000');
    const c = await target('1000000'),
      d = await target('1000000');
    const cross = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 ? transfer(c, d.accountId, '1000') : transfer(d, c.accountId, '1000'),
      ),
    );
    expect(cross.every(r => r.status === 201)).toBe(true);
    expect(await balance(c.accountId)).toBe('1000000');
    expect(await balance(d.accountId)).toBe('1000000');
  });
  it('TC-61-07 concurrent same-key replay, user scope and same-owner event semantics', async () => {
    const a = await target('1000000'),
      b = await target('1000000'),
      key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(a, b.accountId, '1000', key)),
    );
    // DBS-79: the nine repeats are replays of the one execution, not errors and not new transfers.
    expect(results.every(r => r.status === 201)).toBe(true);
    expect(new Set(results.map(r => r.body.transferId as string)).size).toBe(1);
    expect(
      await q('SELECT count(*)::int AS n FROM transfers WHERE from_account_id=$1', [a.accountId]),
    ).toEqual([{ n: 1 }]);
    await transfer(b, a.accountId, '1000', key).expect(201);
    expect(await balance(a.accountId)).toBe('1000000');
    const second = randomUUID();
    // SQL INPUT only: another account for the same customer, migration default balance ZERO.
    await q("INSERT INTO accounts(id,customer_id,type) VALUES($1,$2,'SAVINGS')", [
      second,
      a.customerId,
    ]);
    const own = await transfer(a, second, '1000').expect(201);
    const [event] = await q('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [
      own.body.transferId,
    ]);
    expect(event.payload).toMatchObject({
      sameOwner: true,
      fromUserId: a.userId,
      toUserId: a.userId,
    });
    expect(validateEvent(event.payload).ok).toBe(true);
  });

  async function fault(table: string, timing: string, body: string, action: () => Promise<void>) {
    if (
      !['audit_log', 'outbox_events', 'ledger_entries', 'accounts', 'idempotency_keys'].includes(
        table,
      )
    )
      throw Error('Bad fixture table');
    await q(
      `CREATE FUNCTION dbs61_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; RETURN NEW; END $$`,
    );
    await q(
      `CREATE TRIGGER dbs61_fail ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION dbs61_fail()`,
    );
    try {
      await action();
    } finally {
      await q(`DROP TRIGGER dbs61_fail ON ${table}`);
      await q('DROP FUNCTION dbs61_fail()');
    }
  }
  it.each([
    ['audit_log', 'BEFORE INSERT', "RAISE EXCEPTION 'audit failed'"],
    ['outbox_events', 'BEFORE INSERT', "RAISE EXCEPTION 'outbox failed'"],
    [
      'ledger_entries',
      'BEFORE INSERT',
      "IF NEW.direction='CREDIT' THEN RAISE EXCEPTION 'credit failed'; END IF",
    ],
    [
      'accounts',
      'BEFORE UPDATE',
      "IF NEW.balance > OLD.balance THEN RAISE EXCEPTION 'target failed'; END IF",
    ],
    ['idempotency_keys', 'BEFORE UPDATE', "RAISE EXCEPTION 'result failed'"],
  ])(
    'TC-61-08 %s real write fault rolls back all rows and retry samekey201',
    async (table, timing, body) => {
      const a = await target('1000000'),
        b = await target(),
        key = randomUUID(),
        before = await totals();
      await fault(table, timing, body, async () => {
        const res = await transfer(a, b.accountId, '1000', key).expect(500);
        expect(res.body.detail).toBe('Internal server error');
        expect(await totals()).toEqual(before);
      });
      await transfer(a, b.accountId, '1000', key).expect(201);
    },
  );
  it.each(['audit_log', 'idempotency_keys'])(
    'TC-61-08 rejected %s fault rolls back, retry persists422',
    async table => {
      const a = await target(),
        b = await target(),
        key = randomUUID(),
        before = await totals();
      await fault(
        table,
        table === 'audit_log' ? 'BEFORE INSERT' : 'BEFORE UPDATE',
        "RAISE EXCEPTION 'rejection write failed'",
        async () => {
          await transfer(a, b.accountId, '1000', key).expect(500);
          expect(await totals()).toEqual(before);
        },
      );
      expect((await transfer(a, b.accountId, '1000', key).expect(422)).body.errorCode).toBe(
        'INSUFFICIENT_FUNDS',
      );
    },
  );
  it('TC-61-09 real lock timeout503 leaves no key; release then retry201', async () => {
    const a = await target('1000000'),
      b = await target(),
      key = randomUUID(),
      before = await totals(),
      held = app.source.createQueryRunner();
    await held.connect();
    await held.startTransaction();
    try {
      await held.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [a.accountId]);
      const res = await transfer(a, b.accountId, '1000', key).expect(503);
      expect(res.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(await totals()).toEqual(before);
    } finally {
      await held.rollbackTransaction();
      await held.release();
    }
    await transfer(a, b.accountId, '1000', key).expect(201);
  });
  it('TC-61-13 owner changed after authorization but before the lock: 404, one DENIED, no effects', async () => {
    const a = await target('1000000'),
      b = await target(),
      newOwner = await target();
    const before = await totals();
    const held = app.source.createQueryRunner();
    await held.connect();
    await held.startTransaction();
    let pending: Promise<request.Response> | undefined;
    try {
      await held.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [a.accountId]);
      // The request passes getOwnedAccount (a committed read), opens its transaction and then queues
      // for the row lock held above. Wait on the real lock state, not on a timer.
      pending = Promise.resolve(transfer(a, b.accountId, '1000'));
      for (let i = 0; ; i++) {
        const waiting = (await q('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted')) as {
          n: number;
        }[];
        if (waiting[0].n > 0) break;
        if (i > 100) throw new Error('transfer never queued for the source row lock');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await held.query('UPDATE accounts SET customer_id=$2 WHERE id=$1', [
        a.accountId,
        newOwner.customerId,
      ]);
      await held.commitTransaction();
    } catch (error) {
      await held.rollbackTransaction().catch(() => undefined);
      throw error;
    } finally {
      await held.release();
    }
    const res = await pending;
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('transferId');
    expect(await totals()).toEqual([{ ...before[0], audits: before[0].audits + 1 }]);
    expect(
      await q('SELECT actor_user_id,outcome,metadata FROM audit_log WHERE target_id=$1', [
        a.accountId,
      ]),
    ).toEqual([{ actor_user_id: a.userId, outcome: 'DENIED', metadata: { reason: 'NOT_OWNER' } }]);
    expect(await balance(a.accountId)).toBe('1000000');
    expect(await balance(b.accountId)).toBe('0');
  });
  it('TC-61-14 transfer to the funding account never waits on its row lock: persisted 422, not 503', async () => {
    const a = await target('1000000');
    const held = app.source.createQueryRunner();
    await held.connect();
    await held.startTransaction();
    try {
      // Stands in for any in-flight deposit: every deposit holds this one row for its whole transaction.
      await held.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [FUNDING]);
      await assertRejected(a, FUNDING, '300000', 'ACCOUNT_NOT_ACTIVE', null);
    } finally {
      await held.rollbackTransaction();
      await held.release();
    }
    expect(await balance(a.accountId)).toBe('1000000');
  });
  it('TC-61-10 >2^53 exact through deposit/transfer/DB/event', async () => {
    const amount = '9007199254740993',
      a = await target(amount),
      b = await target();
    // Above the real per-transfer limit: raise it for this test only, so the 2^53 path is reached.
    const saved = { ...app.limits.transfer };
    app.limits.transfer.perTx = app.limits.transfer.perDay = BigInt(amount);
    let res: request.Response;
    try {
      res = await transfer(a, b.accountId, amount).expect(201);
    } finally {
      Object.assign(app.limits.transfer, saved);
    }
    expect(await balance(a.accountId)).toBe('0');
    expect(await balance(b.accountId)).toBe(amount);
    expect(
      await q('SELECT amount::text FROM ledger_entries WHERE transfer_id=$1', [
        res.body.transferId,
      ]),
    ).toEqual([{ amount }, { amount }]);
    const [event] = await q('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [
      res.body.transferId,
    ]);
    expect(event.payload).toMatchObject({ amount, fromBalanceBefore: amount });
    expect(validateEvent(event.payload).ok).toBe(true);
  });
  it('TC-61-10 signed64 destination overflow500 rolls back in isolated capacity fixture', async () => {
    // Own empty database permits MAX+1 total funding without unrelated test deposits exhausting it.
    const capDb = await createTempDatabase();
    let capApp: Awaited<ReturnType<typeof startDepositApp>> | undefined;
    try {
      await migrate(capDb.url);
      capApp = await startDepositApp(capDb.url);
      const a = await seedDepositTarget(capDb.runner),
        b = await seedDepositTarget(capDb.runner);
      const op = await capApp.issuer.token('operator', { sub: randomUUID() }),
        jwt = await capApp.issuer.token('customer', { sub: a.sub });
      for (const [to, amount] of [
        [a.accountId, '1'],
        [b.accountId, '9223372036854775807'],
      ])
        await request(capApp.url)
          .post('/v1/operator/deposits')
          .auth(op, { type: 'bearer' })
          .set('Idempotency-Key', randomUUID())
          .send({ toAccountId: to, amount })
          .expect(201);
      const key = randomUUID();
      await request(capApp.url)
        .post('/v1/transfers')
        .auth(jwt, { type: 'bearer' })
        .set('Idempotency-Key', key)
        .send({ fromAccountId: a.accountId, toAccountId: b.accountId, amount: '1' })
        .expect(500);
      expect(
        await capDb.runner.query(
          'SELECT id,balance::text FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id',
          [[a.accountId, b.accountId]],
        ),
      ).toEqual(
        [
          { id: a.accountId, balance: '1' },
          { id: b.accountId, balance: '9223372036854775807' },
        ].sort((x, y) => x.id.localeCompare(y.id)),
      );
      expect(
        await capDb.runner.query('SELECT count(*)::int AS n FROM transfers WHERE type=$1', [
          'TRANSFER',
        ]),
      ).toEqual([{ n: 0 }]);
      expect(
        await capDb.runner.query(
          'SELECT count(*)::int AS n FROM idempotency_keys WHERE idem_key=$1',
          [key],
        ),
      ).toEqual([{ n: 0 }]);
      expect(await capDb.runner.query('SELECT count(*)::int AS n FROM ledger_entries')).toEqual([
        { n: 4 },
      ]);
      expect(await capDb.runner.query('SELECT count(*)::int AS n FROM audit_log')).toEqual([
        { n: 2 },
      ]);
      expect(await capDb.runner.query('SELECT count(*)::int AS n FROM outbox_events')).toEqual([
        { n: 2 },
      ]);
      expect((await checkLedgerInvariants(capDb.runner)).status).toBe('PASS');
    } finally {
      try {
        await capApp?.close();
      } finally {
        await capDb.drop();
      }
    }
  });
  it('TC-61-11 denied audit failure is fail-closed500 then404 after recovery', async () => {
    const a = await target(),
      b = await target(),
      before = await totals();
    await fault('audit_log', 'BEFORE INSERT', "RAISE EXCEPTION 'denial unavailable'", async () => {
      await send(
        { fromAccountId: b.accountId, toAccountId: a.accountId, amount: '1' },
        a.token,
      ).expect(500);
      expect(await totals()).toEqual(before);
    });
    await send(
      { fromAccountId: b.accountId, toAccountId: a.accountId, amount: '1' },
      a.token,
    ).expect(404);
    expect(await totals()).toEqual([{ ...before[0], audits: before[0].audits + 1 }]);
  });
  it('TC-79-01 same key and body replays the stored 201 with no new rows', async () => {
    const a = await target('1000000'),
      b = await target(),
      key = randomUUID();
    const first = await transfer(a, b.accountId, '1000', key).expect(201);
    const before = await totals();
    const again = await transfer(a, b.accountId, '1000', key).expect(201);
    expect(again.body).toEqual(first.body);
    expect(await totals()).toEqual(before);
    expect(await balance(a.accountId)).toBe('999000');
  });
  it('TC-79-02 same key with another body is 422 IDEMPOTENCY_KEY_REUSED and changes nothing', async () => {
    const a = await target('1000000'),
      b = await target(),
      key = randomUUID();
    await transfer(a, b.accountId, '1000', key).expect(201);
    const before = await totals();
    const res = await transfer(a, b.accountId, '2000', key).expect(422);
    expect(res.body.errorCode).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await totals()).toEqual(before);
  });
  it('TC-79-03 a rejected transfer replays the same 422 and the same transferId', async () => {
    const a = await target('1000'),
      b = await target(),
      key = randomUUID();
    const first = await transfer(a, b.accountId, '5000', key).expect(422);
    expect(first.body.errorCode).toBe('INSUFFICIENT_FUNDS');
    const before = await totals();
    const again = await transfer(a, b.accountId, '5000', key).expect(422);
    expect(again.body.errorCode).toBe('INSUFFICIENT_FUNDS');
    expect(again.body.transferId).toBe(first.body.transferId);
    expect(await totals()).toEqual(before);
  });
  it('TC-79-04 a rejected key keeps its answer even after the account could now pay', async () => {
    const a = await target('1000'),
      b = await target(),
      key = randomUUID();
    await transfer(a, b.accountId, '5000', key).expect(422);
    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: a.accountId, amount: '100000' })
      .expect(201);
    const again = await transfer(a, b.accountId, '5000', key).expect(422);
    expect(again.body.errorCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(a.accountId)).toBe('101000');
  });
  it('TC-54-01 per-transfer limit: 50,000,000 passes, one dong more is 422 and persisted', async () => {
    const a = await target('120000000'),
      b = await target();
    await transfer(a, b.accountId, '50000000').expect(201);
    const res = await transfer(a, b.accountId, '50000001').expect(422);
    expect(res.body.errorCode).toBe('LIMIT_PER_TX_EXCEEDED');
    const [row] = await q('SELECT status,reject_reason FROM transfers WHERE id=$1', [
      res.body.transferId,
    ]);
    expect(row).toEqual({ status: 'REJECTED', reject_reason: 'LIMIT_PER_TX_EXCEEDED' });
    expect(await balance(b.accountId)).toBe('50000000');
  });
  it('TC-54-02 insufficient funds is reported before the limit', async () => {
    const a = await target('1000'),
      b = await target();
    const res = await transfer(a, b.accountId, '60000000').expect(422);
    expect(res.body.errorCode).toBe('INSUFFICIENT_FUNDS');
  });
  it('TC-54-03 per-day limit counts what was already sent today, sequentially', async () => {
    const a = await target('300000000'),
      b = await target();
    for (let i = 0; i < 4; i++) await transfer(a, b.accountId, '50000000').expect(201);
    const res = await transfer(a, b.accountId, '1').expect(422);
    expect(res.body.errorCode).toBe('LIMIT_PER_DAY_EXCEEDED');
    expect(await balance(b.accountId)).toBe('200000000');
  });
  it('TC-54-04 AC-5.6: 180m sent, two parallel 15m transfers: exactly one completes', async () => {
    const a = await target('300000000'),
      b = await target();
    for (let i = 0; i < 3; i++) await transfer(a, b.accountId, '50000000').expect(201);
    await transfer(a, b.accountId, '30000000').expect(201);
    const results = await Promise.all([
      transfer(a, b.accountId, '15000000'),
      transfer(a, b.accountId, '15000000'),
    ]);
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    const rejected = results.filter(r => r.status === 422);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].body.errorCode).toBe('LIMIT_PER_DAY_EXCEEDED');
    expect(await balance(b.accountId)).toBe('195000000');
  });
  it('TC-54-05 money received today does not count against the account sending limit', async () => {
    const a = await target('250000000'),
      b = await target();
    for (let i = 0; i < 4; i++) await transfer(a, b.accountId, '50000000').expect(201);
    expect(await balance(b.accountId)).toBe('200000000');
    await transfer(b, a.accountId, '50000000').expect(201);
  });
  it('TC-61-12 Swagger lists JWT,key,DTO example and response statuses', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    const route = doc.paths['/v1/transfers'].post!;
    expect(route.security).toContainEqual({ 'access-token': [] });
    expect(JSON.stringify(route.parameters)).toContain('Idempotency-Key');
    expect(JSON.stringify(doc.components!.schemas!.TransferDto)).toContain('300000');
    for (const status of ['201', '400', '401', '403', '404', '422', '500', '503'])
      expect(route.responses[status]).toBeDefined();
  });
});
