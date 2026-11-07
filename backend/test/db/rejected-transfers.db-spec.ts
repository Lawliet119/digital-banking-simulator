import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { isRejectReason, REJECT_REASONS } from '@common/errors/reject-reason';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Target = Awaited<ReturnType<typeof seedDepositTarget>> & { token: string };

const FUNDING = '00000000-0000-4000-8000-000000000001';

/**
 * A refused transfer leaves a trace (transfers REJECTED + audit REJECTED + the answer under the
 * Idempotency-Key), all committed BEFORE the 422 is sent. Every check below reads through
 * `db.runner`, a connection of its own: what it sees was committed, not merely done by the request.
 */
describe('DBS-83 refused transfers are stored, committed before the 422, and hide the destination', () => {
  let db: TempDatabase, app: App, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const balance = async (id: string): Promise<string> =>
    ((await q('SELECT balance::text AS b FROM accounts WHERE id=$1', [id])) as { b: string }[])[0]
      .b;
  const totals = async () =>
    (
      (await q(
        `SELECT (SELECT count(*) FROM transfers)::int AS transfers,
          (SELECT count(*) FROM ledger_entries)::int AS lines,
          (SELECT count(*) FROM audit_log)::int AS audits,
          (SELECT count(*) FROM outbox_events)::int AS events,
          (SELECT count(*) FROM idempotency_keys)::int AS keys`,
      )) as Record<string, number>[]
    )[0];
  const deposit = (to: string, amount: string) =>
    request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: to, amount })
      .expect(201);
  async function account(amount = '0', status: 'ACTIVE' | 'LOCKED' = 'ACTIVE'): Promise<Target> {
    const row = await seedDepositTarget(db.runner, status);
    if (amount !== '0') await deposit(row.accountId, amount);
    return { ...row, token: await app.issuer.token('customer', { sub: row.sub }) };
  }
  const send = (a: Target, to: string, amount: string, key: string = randomUUID()) =>
    request(app.url)
      .post('/v1/transfers')
      .auth(a.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ fromAccountId: a.accountId, toAccountId: to, amount });
  /** What the client may compare between two refusals: everything but the two per-request ids. */
  const publicPart = (body: Record<string, unknown>) => {
    const { transferId: _t, correlationId: _c, ...rest } = body;
    return rest;
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

  // One scenario per RejectReason, each ending in a transfer the guard must refuse for that reason.
  const scenarios: [string, () => Promise<{ from: Target; to: Target; amount: string }>][] = [
    [
      'ACCOUNT_NOT_ACTIVE',
      async () => ({
        from: await account('1000000'),
        to: await account('0', 'LOCKED'),
        amount: '300000',
      }),
    ],
    [
      'LIMIT_PER_TX_EXCEEDED',
      async () => ({
        from: await account('60000000'),
        to: await account(),
        amount: '50000001',
      }),
    ],
    [
      'LIMIT_PER_DAY_EXCEEDED',
      async () => {
        const from = await account('250000000'),
          to = await account();
        for (let i = 0; i < 4; i++) await send(from, to.accountId, '50000000').expect(201);
        return { from, to, amount: '1' };
      },
    ],
    [
      'INSUFFICIENT_FUNDS',
      async () => ({ from: await account('100000'), to: await account(), amount: '300000' }),
    ],
  ];
  it('TC-83-01 the scenarios cover every RejectReason', () => {
    expect(scenarios.map(([reason]) => reason).sort()).toEqual([...REJECT_REASONS].sort());
  });
  it.each(scenarios)(
    'TC-83-01 %s: stored in one committed transaction, then 422, with no money moved',
    async (reason, build) => {
      const { from, to, amount } = await build();
      const key = randomUUID(),
        before = await totals(),
        balances = [await balance(from.accountId), await balance(to.accountId)];
      const res = await send(from, to.accountId, amount, key).expect(422);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(Object.keys(res.body).sort()).toEqual(
        ['correlationId', 'detail', 'errorCode', 'status', 'title', 'transferId', 'type'].sort(),
      );
      expect(res.body).toMatchObject({
        errorCode: reason,
        status: 422,
        detail: 'Transfer rejected',
        correlationId: res.headers['x-correlation-id'],
      });
      const id = res.body.transferId as string;
      // Read by another connection, after the answer: it was committed before the 422 was thrown.
      expect(
        await q('SELECT status,reject_reason,type,amount::text FROM transfers WHERE id=$1', [id]),
      ).toEqual([{ status: 'REJECTED', reject_reason: reason, type: 'TRANSFER', amount }]);
      expect(isRejectReason(reason)).toBe(true);
      expect(
        await q(
          'SELECT response_code,response_body,transfer_id FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2',
          [from.userId, key],
        ),
      ).toEqual([
        {
          response_code: 422,
          response_body: { errorCode: reason, transferId: id, message: 'Transfer rejected' },
          transfer_id: id,
        },
      ]);
      expect(
        await q(
          'SELECT actor_user_id,actor_role,action,outcome,metadata,correlation_id FROM audit_log WHERE target_id=$1::uuid::text',
          [id],
        ),
      ).toEqual([
        {
          actor_user_id: from.userId,
          actor_role: 'customer',
          action: 'transfer',
          outcome: 'REJECTED',
          metadata: { id: to.accountId, reason },
          correlation_id: res.body.correlationId,
        },
      ]);
      // AC-5.2 / AC-5.7: no ledger line, no event, no balance change.
      expect(
        await q('SELECT count(*)::int AS n FROM ledger_entries WHERE transfer_id=$1', [id]),
      ).toEqual([{ n: 0 }]);
      expect(await totals()).toEqual({
        ...before,
        transfers: before.transfers + 1,
        audits: before.audits + 1,
        keys: before.keys + 1,
      });
      expect([await balance(from.accountId), await balance(to.accountId)]).toEqual(balances);
    },
  );

  it('TC-83-02 a destination that does not exist, the funding account and a LOCKED account get one answer', async () => {
    const from = await account('100000000'),
      locked = await account('0', 'LOCKED');
    for (const amount of ['1000', '60000000']) {
      const answers = [];
      for (const to of [randomUUID(), FUNDING, locked.accountId])
        answers.push(await send(from, to, amount).expect(422));
      for (const res of answers) {
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(publicPart(res.body)).toEqual({
          errorCode: 'ACCOUNT_NOT_ACTIVE',
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Transfer rejected',
        });
      }
      const stored = await q(
        'SELECT to_account_id FROM transfers WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)',
        [answers.map(r => (r.body as { transferId: string }).transferId)],
      );
      // Only the stored row tells them apart: NULL for "no such customer account", the id otherwise.
      expect(stored).toEqual([
        { to_account_id: null },
        { to_account_id: null },
        { to_account_id: locked.accountId },
      ]);
    }
  });

  it('TC-83-03 a refusal to an unknown destination is replayed word for word, even after the source could pay', async () => {
    const from = await account('1000'),
      unknown = randomUUID(),
      key = randomUUID();
    const first = await send(from, unknown, '500', key).expect(422);
    const before = await totals();
    const again = await send(from, unknown, '500', key).expect(422);
    expect(again.headers['content-type']).toContain('application/problem+json');
    expect(again.body.transferId).toBe(first.body.transferId);
    expect(publicPart(again.body)).toEqual(publicPart(first.body));
    expect(await totals()).toEqual(before);
    await deposit(from.accountId, '1000000');
    const later = await send(from, unknown, '500', key).expect(422);
    expect(later.body.transferId).toBe(first.body.transferId);
    expect(await totals()).toEqual({
      ...before,
      lines: before.lines + 2,
      events: before.events + 1,
      audits: before.audits + 1,
      transfers: before.transfers + 1,
      keys: before.keys + 1,
    });
    expect(await balance(from.accountId)).toBe('1001000');
  });
});
