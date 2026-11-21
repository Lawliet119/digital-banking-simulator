import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';
import { counterOf, ledgerTruth } from '../support/daily-debit-counter';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Target = Awaited<ReturnType<typeof seedDepositTarget>> & { token: string };

/**
 * BL-418, TC-418-07, 08 and 09 on the real transfer flow (HTTP, Nest, TransactionService,
 * PostgreSQL): the counter follows the ledger exactly through rejections, a deadlock retry and
 * parallel transfers, and AC-5.6 / NFR-COR-03 hold.
 */
describe('BL-418 the day counter through the real transfer flow', () => {
  let db: TempDatabase, app: App, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  async function target(amount = '0'): Promise<Target> {
    const row = await seedDepositTarget(db.runner);
    for (let left = BigInt(amount); left > 0n; left -= 100_000_000n) {
      const part = left > 100_000_000n ? 100_000_000n : left;
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operator, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: row.accountId, amount: part.toString() })
        .expect(201);
    }
    return { ...row, token: await app.issuer.token('customer', { sub: row.sub }) };
  }
  const send = (from: Target, to: string, amount: string, key = randomUUID()) =>
    request(app.url)
      .post('/v1/transfers')
      .auth(from.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ fromAccountId: from.accountId, toAccountId: to, amount });
  /** The counter equals what the ledger says, for every account of the run. */
  async function expectCounterEqualsLedger(...ids: string[]) {
    for (const id of ids)
      expect(await counterOf(db.runner, id)).toEqual(await ledgerTruth(db.runner, id));
  }

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const result = await checkLedgerInvariants(db.runner);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe('PASS');
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-418-07 a REJECTED transfer adds nothing, whatever the reason', async () => {
    const source = await target('300000000'),
      sink = await target(),
      poor = await target('10000000');
    const locked = await seedDepositTarget(db.runner, 'LOCKED');
    // 30 + 50 + 50 + 50 = 180 million sent today
    for (const amount of ['30000000', '50000000', '50000000', '50000000'])
      expect((await send(source, sink.accountId, amount)).status).toBe(201);
    expect((await counterOf(db.runner, source.accountId)).sentToday).toBe('180000000');
    const refused = async (from: Target, to: string, amount: string, errorCode: string) => {
      const before = await counterOf(db.runner, from.accountId);
      const response = await send(from, to, amount);
      expect(response.status).toBe(422);
      expect(response.body.errorCode).toBe(errorCode);
      expect(await counterOf(db.runner, from.accountId)).toEqual(before);
    };
    await refused(source, sink.accountId, '60000000', 'LIMIT_PER_TX_EXCEEDED');
    await refused(source, sink.accountId, '30000000', 'LIMIT_PER_DAY_EXCEEDED');
    await refused(source, locked.accountId, '1000', 'ACCOUNT_NOT_ACTIVE');
    await refused(poor, sink.accountId, '20000000', 'INSUFFICIENT_FUNDS');
    // and the next transfer still sees 180 million, not more
    expect((await send(source, sink.accountId, '20000000')).status).toBe(201);
    expect((await counterOf(db.runner, source.accountId)).sentToday).toBe('200000000');
    expect((await send(source, sink.accountId, '1')).status).toBe(422);
    await expectCounterEqualsLedger(source.accountId, sink.accountId, poor.accountId);
  });

  it('TC-418-08 a deadlock retry after the ledger lines were written counts the transfer once', async () => {
    const source = await target('100000000'),
      sink = await target();
    // nextval is not rolled back: it counts the attempts. The trigger runs on the INSERT of the
    // outbox event, which the transfer writes AFTER its ledger lines (and the counter), so the
    // first attempt has already counted the amount when it is rolled back.
    await q('DROP SEQUENCE IF EXISTS dbs418_attempts');
    await q('DROP SEQUENCE IF EXISTS dbs418_seen');
    await q('CREATE SEQUENCE dbs418_attempts');
    await q('CREATE SEQUENCE dbs418_seen MINVALUE 0');
    // setval is not rolled back either: it keeps the counter the FIRST attempt had when it failed
    await q(`CREATE FUNCTION dbs418_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('dbs418_attempts') = 1 THEN
        PERFORM setval('dbs418_seen', (SELECT sent_today FROM public.accounts WHERE id = '${source.accountId}'));
        RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01';
      END IF;
      RETURN NULL; END $$`);
    await q(
      `CREATE TRIGGER dbs418_fault BEFORE INSERT ON outbox_events
       FOR EACH STATEMENT EXECUTE FUNCTION dbs418_fault()`,
    );
    try {
      const response = await send(source, sink.accountId, '7000000');
      expect(response.status).toBe(201);
      const [{ attempts }] = await q('SELECT last_value::int AS attempts FROM dbs418_attempts');
      expect(attempts).toBe(2); // the first attempt failed after its ledger lines, the retry won
      // the failed attempt HAD counted the 7,000,000 before it was rolled back
      const [{ seen }] = await q('SELECT last_value::text AS seen FROM dbs418_seen');
      expect(seen).toBe('7000000');
    } finally {
      await q('DROP TRIGGER dbs418_fault ON outbox_events');
      await q('DROP FUNCTION dbs418_fault()');
    }
    expect(await counterOf(db.runner, source.accountId)).toMatchObject({ sentToday: '7000000' });
    const [{ lines }] = await q(
      `SELECT count(*)::int AS lines FROM ledger_entries WHERE account_id=$1 AND direction='DEBIT'`,
      [source.accountId],
    );
    expect(lines).toBe(1);
    await expectCounterEqualsLedger(source.accountId, sink.accountId);
  });

  it('TC-418-09 AC-5.6 and NFR-COR-03: parallel 15,000,000 transfers after 180,000,000 sent, three accounts at once', async () => {
    const sources: Target[] = [],
      sinks: Target[] = [];
    for (let i = 0; i < 3; i++) {
      sources.push(await target('300000000'));
      sinks.push(await target());
      for (const amount of ['50000000', '50000000', '50000000', '30000000'])
        expect((await send(sources[i], sinks[i].accountId, amount)).status).toBe(201);
    }
    // six parallel 15,000,000 per source, all eighteen released together: 180 + 15 fits, 210 does not
    const answers = await Promise.all(
      sources.flatMap((source, i) =>
        Array.from({ length: 6 }, () => send(source, sinks[i].accountId, '15000000')),
      ),
    );
    for (let i = 0; i < 3; i++) {
      const mine = answers.slice(i * 6, i * 6 + 6);
      expect(mine.filter(a => a.status === 201)).toHaveLength(1);
      const refused = mine.filter(a => a.status === 422);
      expect(refused).toHaveLength(5);
      expect(refused.every(a => a.body.errorCode === 'LIMIT_PER_DAY_EXCEEDED')).toBe(true);
      const counter = await counterOf(db.runner, sources[i].accountId);
      expect(counter.sentToday).toBe('195000000');
      expect(BigInt(counter.sentToday)).toBeLessThanOrEqual(200_000_000n);
    }
    expect(answers.every(a => a.status === 201 || a.status === 422)).toBe(true);
    await expectCounterEqualsLedger(
      ...sources.map(s => s.accountId),
      ...sinks.map(s => s.accountId),
    );
  });
});
