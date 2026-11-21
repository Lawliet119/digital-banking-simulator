import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createClient } from 'redis';
import { validateEvent } from '@common/events';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startDepositApp } from '../support/deposit-app';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';
import { checkLedgerInvariants } from '../support/invariants';

const FUNDING = '00000000-0000-4000-8000-000000000001';
type Customer = { token: string; userId: string; accountId: string };
type Snapshot = {
  transfers: number;
  lines: number;
  audits: number;
  keys: number;
  events: number;
  balances: Record<string, string>;
};
type Movement = {
  type: 'DEPOSIT' | 'TRANSFER';
  from: string;
  to: string;
  amount: string;
  before: string;
  debitAfter: string;
  creditAfter: string;
  actor: string;
  fromUser: string | null;
  toUser: string;
};

describe('DBS-65 full HTTP/JWT money flow on real PostgreSQL and Valkey', () => {
  let db: TempDatabase | undefined;
  let app: Awaited<ReturnType<typeof startDepositApp>> | undefined;
  let valkey: StartedValkey | undefined;
  let redis: ReturnType<typeof createClient> | undefined;
  let operator: string;
  let operatorSub: string;
  const q = (sql: string, args: unknown[] = []) => db!.runner.query(sql, args);
  const post = (
    path: string,
    token: string | null,
    body: object,
    key: string | null = randomUUID(),
  ) => {
    const req = request(app!.url).post(path);
    if (token) req.auth(token, { type: 'bearer' });
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const get = (token: string, path: string) =>
    request(app!.url).get(path).auth(token, { type: 'bearer' });
  const transferBody = (a: Customer, b: Customer, amount = '300000') => ({
    fromAccountId: a.accountId,
    toAccountId: b.accountId,
    amount,
  });
  const snapshot = async (): Promise<Snapshot> =>
    (
      await q(`SELECT (SELECT count(*)::int FROM transfers) AS transfers,
      (SELECT count(*)::int FROM ledger_entries) AS lines,
      (SELECT count(*)::int FROM audit_log) AS audits,
      (SELECT count(*)::int FROM idempotency_keys) AS keys,
      (SELECT count(*)::int FROM outbox_events) AS events,
      (SELECT jsonb_object_agg(id,balance::text) FROM accounts) AS balances`)
    )[0] as Snapshot;

  async function audit(
    res: request.Response,
    actor: string,
    role: string,
    action: string,
    outcome: string,
    targetType: string,
    targetId: string,
    metadata: object,
  ) {
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await q(
        `SELECT actor_user_id,actor_role,action,outcome,target_type,target_id,metadata
      FROM audit_log WHERE correlation_id=$1`,
        [res.headers['x-correlation-id']],
      ),
    ).toEqual([
      {
        actor_user_id: actor,
        actor_role: role,
        action,
        outcome,
        target_type: targetType,
        target_id: targetId,
        metadata,
      },
    ]);
  }

  async function customer(fullName: string): Promise<Customer> {
    const sub = randomUUID(),
      token = await app!.issuer.token('customer', { sub });
    const profile = await post('/v1/customers/me', token, { fullName }).expect(200);
    const [user] = await q('SELECT id FROM users WHERE cognito_sub=$1', [sub]);
    await audit(
      profile,
      user.id,
      'customer',
      'customer.created',
      'SUCCESS',
      'customer',
      profile.body.id,
      { id: profile.body.id },
    );
    const opened = await post('/v1/accounts', token, { type: 'CHECKING' }).expect(201);
    expect(opened.body).toMatchObject({ balance: '0', type: 'CHECKING', status: 'ACTIVE' });
    await audit(opened, user.id, 'customer', 'account.open', 'SUCCESS', 'account', opened.body.id, {
      id: opened.body.id,
    });
    return { token, userId: user.id, accountId: opened.body.id };
  }

  async function balances(a: Customer, b: Customer, expected: [string, string]) {
    for (const [index, owner] of [a, b].entries()) {
      const list = await get(owner.token, '/v1/accounts').expect(200);
      const detail = await get(owner.token, '/v1/accounts/' + owner.accountId).expect(200);
      expect(list.body).toEqual([detail.body]);
      expect(detail.body).toMatchObject({
        id: owner.accountId,
        balance: expected[index],
        type: 'CHECKING',
        status: 'ACTIVE',
      });
      expect(Object.keys(detail.body).sort()).toEqual(
        ['id', 'type', 'status', 'balance', 'createdAt', 'updatedAt'].sort(),
      );
      await audit(list, owner.userId, 'customer', 'account.list', 'SUCCESS', 'user', owner.userId, {
        count: 1,
      });
      await audit(
        detail,
        owner.userId,
        'customer',
        'account.read',
        'SUCCESS',
        'account',
        owner.accountId,
        { id: owner.accountId },
      );
    }
  }

  async function movement(res: request.Response, expected: Movement) {
    const id: string = res.body.transferId;
    expect(res.body).toEqual({ transferId: expect.any(String), status: 'COMPLETED' });
    const [row] = await q('SELECT * FROM transfers WHERE id=$1', [id]);
    expect(row).toMatchObject({
      type: expected.type,
      from_account_id: expected.from,
      to_account_id: expected.to,
      amount: expected.amount,
      status: 'COMPLETED',
      reject_reason: null,
      initiated_by: expected.actor,
      correlation_id: res.headers['x-correlation-id'],
    });
    expect(
      await q(
        'SELECT direction,account_id,amount::text,balance_after::text FROM ledger_entries WHERE transfer_id=$1 ORDER BY direction',
        [id],
      ),
    ).toEqual([
      {
        direction: 'CREDIT',
        account_id: expected.to,
        amount: expected.amount,
        balance_after: expected.creditAfter,
      },
      {
        direction: 'DEBIT',
        account_id: expected.from,
        amount: expected.amount,
        balance_after: expected.debitAfter,
      },
    ]);
    await audit(
      res,
      expected.actor,
      expected.type === 'DEPOSIT' ? 'operator' : 'customer',
      expected.type === 'DEPOSIT' ? 'deposit' : 'transfer',
      'SUCCESS',
      'transfer',
      id,
      { id: expected.to },
    );
    const events = await q('SELECT * FROM outbox_events WHERE aggregate_id=$1', [id]);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({
      aggregate_id: id,
      event_type: 'TransferCompleted',
      correlation_id: row.correlation_id,
      published_at: null,
    });
    expect(validateEvent(event.payload).ok).toBe(true);
    const dates = await q('SELECT id,created_at FROM accounts WHERE id=ANY($1::uuid[])', [
      [expected.from, expected.to],
    ]);
    expect(event.payload).toEqual({
      eventId: event.event_id,
      eventType: 'TransferCompleted',
      transferId: id,
      type: expected.type,
      amount: expected.amount,
      fromAccountId: expected.from,
      toAccountId: expected.to,
      occurredAt: row.created_at.toISOString(),
      correlationId: row.correlation_id,
      fromBalanceBefore: expected.before,
      fromAccountCreatedAt: dates
        .find((d: { id: string }) => d.id === expected.from)
        .created_at.toISOString(),
      toAccountCreatedAt: dates
        .find((d: { id: string }) => d.id === expected.to)
        .created_at.toISOString(),
      fromUserId: expected.fromUser,
      toUserId: expected.toUser,
      sameOwner: false,
    });
  }

  async function pair(amount = '1000000') {
    const a = await customer('Nguyễn Minh Anh'),
      b = await customer('Trần Thu Hà');
    const depositKey = randomUUID(),
      depositBody = { toAccountId: a.accountId, amount };
    const deposit = await post('/v1/operator/deposits', operator, depositBody, depositKey).expect(
      201,
    );
    const [actor] = await q('SELECT id FROM users WHERE cognito_sub=$1', [operatorSub]);
    await movement(deposit, {
      type: 'DEPOSIT',
      from: FUNDING,
      to: a.accountId,
      amount,
      before: '0',
      debitAfter: (-BigInt(amount)).toString(),
      creditAfter: amount,
      actor: actor.id,
      fromUser: null,
      toUser: a.userId,
    });
    return { a, b, deposit, depositKey, depositBody };
  }

  async function flow(amount = '1000000') {
    const context = await pair(amount),
      { a, b } = context;
    await balances(a, b, [amount, '0']);
    const key = randomUUID(),
      body = transferBody(a, b);
    const res = await post('/v1/transfers', a.token, body, key).expect(201);
    await movement(res, {
      type: 'TRANSFER',
      from: a.accountId,
      to: b.accountId,
      amount: '300000',
      before: amount,
      debitAfter: (BigInt(amount) - 300000n).toString(),
      creditAfter: '300000',
      actor: a.userId,
      fromUser: a.userId,
      toUser: b.userId,
    });
    await balances(a, b, [(BigInt(amount) - 300000n).toString(), '300000']);
    return { ...context, key, body, res };
  }

  beforeAll(async () => {
    valkey = await startValkeyContainer();
    redis = createClient({
      url: valkey.url,
      socket: { connectTimeout: 1000, reconnectStrategy: false },
    });
    redis.on('error', () => undefined);
    await redis.connect();
  }, 420000);
  beforeEach(async () => {
    db = undefined;
    app = undefined;
    // Only the container this suite created: never reset a shared Redis or a money table.
    await redis!.flushDb();
    expect(await redis!.ping()).toBe('PONG');
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url, { rateLimit: { redisUrl: valkey!.url } });
    operatorSub = randomUUID();
    operator = await app.issuer.token('operator', { sub: operatorSub });
  });
  afterEach(async () => {
    try {
      if (db) {
        const report = await checkLedgerInvariants(db.runner);
        expect(report.status).toBe('PASS');
        expect(report.violations).toEqual([]);
        expect(report.totals.balance).toBe('0');
      }
    } finally {
      try {
        await app?.close();
      } finally {
        await db?.drop();
      }
    }
  });
  afterAll(async () => {
    try {
      if (redis?.isOpen) redis.destroy();
    } finally {
      await valkey?.stop();
    }
  });

  it('TC-65-01 onboard → open → deposit → transfer → both balances, audit and outbox', async () => {
    const { a, b } = await flow();
    expect(await snapshot()).toMatchObject({
      transfers: 2,
      lines: 4,
      keys: 2,
      events: 2,
      balances: { [FUNDING]: '-1000000', [a.accountId]: '700000', [b.accountId]: '300000' },
    });
  });

  it('TC-65-02 replays deposit and transfer without duplicating any money effect', async () => {
    const { a, b, deposit, depositKey, depositBody, res, key, body } = await flow();
    const before = await snapshot();
    const replayDeposit = await post(
      '/v1/operator/deposits',
      operator,
      depositBody,
      depositKey,
    ).expect(201);
    const replayTransfer = await post('/v1/transfers', a.token, body, key).expect(201);
    expect(replayDeposit.body).toEqual(deposit.body);
    expect(replayTransfer.body).toEqual(res.body);
    expect(replayTransfer.headers['x-correlation-id']).not.toBe(res.headers['x-correlation-id']);
    for (const [path, actor, original, k] of [
      ['/v1/operator/deposits', operator, depositBody, depositKey],
      ['/v1/transfers', a.token, body, key],
    ] as const) {
      const conflict = await post(path, actor, { ...original, amount: '1' }, k).expect(422);
      expect(conflict.body.errorCode).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    expect(await snapshot()).toEqual(before);
    expect(
      await q('SELECT correlation_id FROM transfers WHERE id=$1', [res.body.transferId]),
    ).toEqual([{ correlation_id: res.headers['x-correlation-id'] }]);
    await balances(a, b, ['700000', '300000']);
  });

  it('TC-65-03 scopes the same key by customer on the same transfer endpoint', async () => {
    const { a, b } = await flow(),
      shared = randomUUID();
    const bodyA = transferBody(a, b, '100000'),
      bodyB = transferBody(b, a, '50000');
    const sentA = await post('/v1/transfers', a.token, bodyA, shared).expect(201);
    const sentB = await post('/v1/transfers', b.token, bodyB, shared).expect(201);
    expect(sentA.body.transferId).not.toBe(sentB.body.transferId);
    expect(
      await q(
        'SELECT user_id,transfer_id FROM idempotency_keys WHERE idem_key=$1 ORDER BY user_id',
        [shared],
      ),
    ).toEqual(
      [
        { user_id: a.userId, transfer_id: sentA.body.transferId },
        { user_id: b.userId, transfer_id: sentB.body.transferId },
      ].sort((x, y) => x.user_id.localeCompare(y.user_id)),
    );
    await movement(sentA, {
      type: 'TRANSFER',
      from: a.accountId,
      to: b.accountId,
      amount: '100000',
      before: '700000',
      debitAfter: '600000',
      creditAfter: '400000',
      actor: a.userId,
      fromUser: a.userId,
      toUser: b.userId,
    });
    await movement(sentB, {
      type: 'TRANSFER',
      from: b.accountId,
      to: a.accountId,
      amount: '50000',
      before: '400000',
      debitAfter: '350000',
      creditAfter: '650000',
      actor: b.userId,
      fromUser: b.userId,
      toUser: a.userId,
    });
    const before = await snapshot();
    expect((await post('/v1/transfers', a.token, bodyA, shared).expect(201)).body).toEqual(
      sentA.body,
    );
    expect((await post('/v1/transfers', b.token, bodyB, shared).expect(201)).body).toEqual(
      sentB.body,
    );
    expect(await snapshot()).toEqual(before);
    expect(before).toMatchObject({ transfers: 4, lines: 8, events: 4, keys: 4 });
    await balances(a, b, ['650000', '350000']);
  });

  it('TC-65-04 AC-5.2 commits one insufficient-funds rejection and replays it', async () => {
    const { a, b } = await pair('100000'),
      key = randomUUID(),
      body = transferBody(a, b);
    const before = await snapshot();
    const rejected = await post('/v1/transfers', a.token, body, key).expect(422);
    expect(rejected.body).toMatchObject({
      status: 422,
      errorCode: 'INSUFFICIENT_FUNDS',
      transferId: expect.any(String),
      correlationId: rejected.headers['x-correlation-id'],
    });
    await audit(
      rejected,
      a.userId,
      'customer',
      'transfer',
      'REJECTED',
      'transfer',
      rejected.body.transferId,
      { id: b.accountId, reason: 'INSUFFICIENT_FUNDS' },
    );
    expect(
      await q('SELECT status,reject_reason FROM transfers WHERE id=$1', [rejected.body.transferId]),
    ).toEqual([{ status: 'REJECTED', reject_reason: 'INSUFFICIENT_FUNDS' }]);
    expect(
      await q('SELECT id FROM ledger_entries WHERE transfer_id=$1', [rejected.body.transferId]),
    ).toEqual([]);
    expect(
      await q('SELECT id FROM outbox_events WHERE aggregate_id=$1', [rejected.body.transferId]),
    ).toEqual([]);
    const after = await snapshot();
    expect(after).toEqual({
      ...before,
      transfers: before.transfers + 1,
      audits: before.audits + 1,
      keys: before.keys + 1,
    });
    const replay = await post('/v1/transfers', a.token, body, key).expect(422);
    expect(replay.body).toMatchObject({
      errorCode: 'INSUFFICIENT_FUNDS',
      transferId: rejected.body.transferId,
    });
    expect(await snapshot()).toEqual(after);
    expect(
      await q(
        'SELECT response_code,response_body,transfer_id FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2',
        [a.userId, key],
      ),
    ).toEqual([
      {
        response_code: 422,
        response_body: expect.objectContaining({
          errorCode: 'INSUFFICIENT_FUNDS',
          transferId: rejected.body.transferId,
        }),
        transfer_id: rejected.body.transferId,
      },
    ]);
    await balances(a, b, ['100000', '0']);
  });

  function problem(res: request.Response, status: number, code?: string) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status, correlationId: res.headers['x-correlation-id'] });
    if (code) expect(res.body.errorCode).toBe(code);
    else expect(res.body).not.toHaveProperty('errorCode');
    // A fixed "Authorization header missing" explanation is safe; reject leaked values instead.
    expect(JSON.stringify(res.body)).not.toMatch(/select |password[=:]|bearer eyJ|stack["']?\s*:/i);
  }

  it('TC-65-05 hides foreign, missing and hostile accounts and commits ownership denials', async () => {
    const { a, b } = await flow(),
      before = await snapshot();
    for (const id of [b.accountId, randomUUID(), "x' OR 1=1 --"]) {
      const res = await get(a.token, '/v1/accounts/' + encodeURIComponent(id)).expect(404);
      problem(res, 404);
      expect(res.body).not.toHaveProperty('balance');
      await audit(
        res,
        a.userId,
        'customer',
        'account.read',
        'DENIED',
        id.startsWith("x'") ? 'user' : 'account',
        id.startsWith("x'") ? a.userId : id,
        { reason: 'NOT_OWNER' },
      );
    }
    const denied = await post('/v1/transfers', a.token, transferBody(b, a)).expect(404);
    problem(denied, 404);
    await audit(denied, a.userId, 'customer', 'ledger.transfer', 'DENIED', 'account', b.accountId, {
      reason: 'NOT_OWNER',
    });
    expect(await snapshot()).toEqual({ ...before, audits: before.audits + 4 });
    await balances(a, b, ['700000', '300000']);
  });

  it('TC-65-06 refuses wrong roles at real deposit and transfer routes', async () => {
    const { a, b } = await flow(),
      auditor = await app!.issuer.token('auditor', { sub: randomUUID() });
    const before = await snapshot();
    for (const token of [a.token, auditor]) {
      problem(
        await post('/v1/operator/deposits', token, {
          toAccountId: b.accountId,
          amount: '100000',
        }).expect(403),
        403,
        'FORBIDDEN',
      );
    }
    problem(
      await post('/v1/transfers', operator, transferBody(a, b)).expect(403),
      403,
      'FORBIDDEN',
    );
    // BL-132: every refusal also leaves one DENIED row (2 deposits by a customer and an auditor,
    // 1 transfer by an operator); no transfer, ledger line, key, event or balance changed.
    expect(await snapshot()).toEqual({ ...before, audits: before.audits + 3 });
    await balances(a, b, ['700000', '300000']);
  });

  it('TC-65-07 preserves 2^53+1 through funding, transfer, balance reads and events', async () => {
    const amount = '9007199254740993',
      { a, b } = await flow(amount);
    expect(await snapshot()).toMatchObject({
      transfers: 2,
      lines: 4,
      keys: 2,
      events: 2,
      balances: {
        [FUNDING]: '-9007199254740993',
        [a.accountId]: '9007199254440993',
        [b.accountId]: '300000',
      },
    });
    expect(await q("SELECT amount::text FROM transfers WHERE type='DEPOSIT'")).toEqual([
      { amount },
    ]);
    expect(
      await q(
        "SELECT payload->>'amount' AS amount FROM outbox_events WHERE payload->>'type'='DEPOSIT'",
      ),
    ).toEqual([{ amount }]);
  });

  it('TC-65-08 rejects absent credentials, absent keys and noncanonical amounts without money effects', async () => {
    const { a, b } = await pair(),
      before = await snapshot(),
      body = transferBody(a, b);
    problem(await post('/v1/transfers', null, body).expect(401), 401, 'UNAUTHENTICATED');
    problem(
      await post('/v1/transfers', a.token, body, null).expect(400),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    for (const amount of [300000, '300000.5']) {
      const res = await post('/v1/transfers', a.token, { ...body, amount }).expect(400);
      problem(res, 400);
      expect(res.body.errors.length).toBeGreaterThan(0);
    }
    expect(await snapshot()).toEqual(before);
    await balances(a, b, ['1000000', '0']);
  });
});
