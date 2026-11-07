import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type Target = Awaited<ReturnType<typeof seedDepositTarget>> & { token: string };

const GATE = 8181;
const ROUNDS = 20;

/**
 * Review Focus 1 (ADR-05): the original request A holds Idempotency-Key K, an identical request B
 * waits on it at INSERT … ON CONFLICT DO NOTHING, then A either rolls back or commits.
 *
 * The order is forced by real database state, never by sleeping:
 *   1. the test holds a session advisory lock (the gate);
 *   2. a trigger on `audit_log` makes A request that lock after it has inserted K, locked the
 *      accounts and written the ledger lines, so A stops there while holding K;
 *   3. B is sent only once pg_locks shows A stopped, and the gate opens only once pg_locks shows
 *      B waiting for A's transaction.
 */
describe('DBS-81 original rolls back or commits while an identical request waits on its key', () => {
  let db: TempDatabase, app: Awaited<ReturnType<typeof startDepositApp>>, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const balance = async (id: string): Promise<string> =>
    ((await q('SELECT balance::text AS b FROM accounts WHERE id=$1', [id])) as { b: string }[])[0]
      .b;
  const n = async (sql: string, args: unknown[] = []): Promise<number> =>
    ((await q(sql, args)) as { n: number }[])[0].n;

  async function target(amount = '0'): Promise<Target> {
    const row = await seedDepositTarget(db.runner);
    if (amount !== '0')
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operator, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: row.accountId, amount })
        .expect(201);
    return { ...row, token: await app.issuer.token('customer', { sub: row.sub }) };
  }
  /** Lazy supertest request turned into a started promise, so the test can go on while it runs. */
  const start = (a: Target, to: string, amount: string, key: string) =>
    Promise.resolve(
      request(app.url)
        .post('/v1/transfers')
        .auth(a.token, { type: 'bearer' })
        .set('Idempotency-Key', key)
        .send({ fromAccountId: a.accountId, toAccountId: to, amount }),
    );
  /** Polls a real database condition (25 ms steps, 5 s limit); it is not a fixed delay. */
  async function until(sql: string, label: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if ((await n(sql)) > 0) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }
  // Backends of this test database only: pg_locks is cluster-wide and other suites may run beside it.
  const waiting = (locktype: string) =>
    `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid
     WHERE l.locktype='${locktype}' AND NOT l.granted AND s.datname=current_database()`;
  const waitingPid = async (locktype: string): Promise<number> =>
    (
      (await q(
        `SELECT l.pid::int AS pid FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid
         WHERE l.locktype=$1 AND NOT l.granted AND s.datname=current_database()`,
        [locktype],
      )) as { pid: number }[]
    )[0].pid;

  /** The trigger that stops A at the gate; `fail` makes the FIRST caller (A) raise afterwards. */
  async function withGate(fail: boolean, action: () => Promise<void>) {
    await q('DROP SEQUENCE IF EXISTS dbs81_calls');
    await q('CREATE SEQUENCE dbs81_calls');
    await q(`CREATE FUNCTION dbs81_gate() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE call_no bigint; BEGIN
      IF NEW.action = 'transfer' THEN
        PERFORM pg_advisory_xact_lock(${GATE});
        call_no := nextval('dbs81_calls');
        IF call_no = 1 AND ${fail} THEN RAISE EXCEPTION 'dbs81 the original fails'; END IF;
      END IF;
      RETURN NEW; END $$`);
    await q(
      'CREATE TRIGGER dbs81_gate BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs81_gate()',
    );
    try {
      await action();
    } finally {
      await q('DROP TRIGGER dbs81_gate ON audit_log');
      await q('DROP FUNCTION dbs81_gate()');
    }
  }
  const calls = async () =>
    n('SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS n FROM dbs81_calls');

  /** Opens the gate, runs `body`, and always releases the gate session. */
  async function gated<T>(body: (open: () => Promise<void>) => Promise<T>): Promise<T> {
    const gate = app.source.createQueryRunner();
    await gate.connect();
    try {
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);
      return await body(() => gate.query('SELECT pg_advisory_unlock_all()').then(() => undefined));
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()');
      await gate.release();
    }
  }

  /** One full scenario; returns what A and B answered and the ids involved. */
  async function scenario(withWaiter: boolean) {
    const a = await target('2000000'),
      b = await target(),
      key = randomUUID();
    return gated(async open => {
      const first = start(a, b.accountId, '700000', key);
      await until(waiting('advisory'), 'A stopped at the gate holding key K');
      let second: ReturnType<typeof start> | undefined;
      let secondAnswered = false;
      if (withWaiter) {
        second = start(a, b.accountId, '700000', key);
        void second.then(() => (secondAnswered = true));
        await until(waiting('transactionid'), 'B waiting for the transaction of A');
        expect(secondAnswered).toBe(false);
      }
      await open();
      return { a, b, key, first: await first, second: second ? await second : undefined };
    });
  }
  async function expectOneTransfer(a: Target, b: Target, key: string, transferId: string) {
    expect(
      await n('SELECT count(*)::int AS n FROM transfers WHERE from_account_id=$1', [a.accountId]),
    ).toBe(1);
    expect(
      await n('SELECT count(*)::int AS n FROM ledger_entries WHERE transfer_id=$1', [transferId]),
    ).toBe(2);
    expect(
      await n('SELECT count(*)::int AS n FROM audit_log WHERE target_id=$1::uuid::text', [
        transferId,
      ]),
    ).toBe(1);
    expect(
      await n('SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1', [transferId]),
    ).toBe(1);
    expect(
      await n('SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2', [
        a.userId,
        key,
      ]),
    ).toBe(1);
    expect(await balance(a.accountId)).toBe('1300000');
    expect(await balance(b.accountId)).toBe('700000');
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

  it(`TC-81-01 A fails and rolls back: B is processed as new and COMPLETED (${ROUNDS} rounds)`, async () => {
    await withGate(true, async () => {
      for (let round = 1; round <= ROUNDS; round++) {
        await q('ALTER SEQUENCE dbs81_calls RESTART');
        const { a, b, key, first, second } = await scenario(true);
        expect(first.status).toBe(500);
        expect(first.body).not.toHaveProperty('transferId');
        expect(second!.status).toBe(201);
        expect(second!.body).toEqual({ transferId: expect.any(String), status: 'COMPLETED' });
        await expectOneTransfer(a, b, key, second!.body.transferId);
        // The stored answer is B's own, never anything of A.
        expect(
          await q(
            'SELECT transfer_id,response_code,response_body FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2',
            [a.userId, key],
          ),
        ).toEqual([
          { transfer_id: second!.body.transferId, response_code: 201, response_body: second!.body },
        ]);
        expect(await calls()).toBe(2); // A reached the audit once and failed, B reached it once
      }
    });
  });

  it(`TC-81-02 A commits: B gets exactly A's answer and does nothing a second time (${ROUNDS} rounds)`, async () => {
    await withGate(false, async () => {
      for (let round = 1; round <= ROUNDS; round++) {
        await q('ALTER SEQUENCE dbs81_calls RESTART');
        const { a, b, key, first, second } = await scenario(true);
        expect(first.status).toBe(201);
        expect(second!.status).toBe(201);
        expect(second!.body).toEqual(first.body);
        await expectOneTransfer(a, b, key, first.body.transferId);
        expect(await calls()).toBe(1); // only A ever reached the audit step
      }
    });
  });

  it(`TC-81-03 A rolls back with nobody waiting: the same key sent again is processed as new (${ROUNDS} rounds)`, async () => {
    await withGate(true, async () => {
      for (let round = 1; round <= ROUNDS; round++) {
        await q('ALTER SEQUENCE dbs81_calls RESTART');
        const { a, b, key, first } = await scenario(false);
        expect(first.status).toBe(500);
        expect(
          await n(
            'SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2',
            [a.userId, key],
          ),
        ).toBe(0);
        const again = await start(a, b.accountId, '700000', key);
        expect(again.status).toBe(201);
        await expectOneTransfer(a, b, key, again.body.transferId);
      }
    });
  });

  it('TC-81-04 B really waits on the transaction of A (pg_blocking_pids) and does not hang after A ends', async () => {
    const a = await target('2000000'),
      b = await target(),
      key = randomUUID();
    await withGate(true, async () => {
      await q('ALTER SEQUENCE dbs81_calls RESTART');
      await gated(async open => {
        const first = start(a, b.accountId, '700000', key);
        await until(waiting('advisory'), 'A stopped at the gate');
        const pidA = await waitingPid('advisory');
        const second = start(a, b.accountId, '700000', key);
        await until(waiting('transactionid'), 'B waiting for A');
        const pidB = await waitingPid('transactionid');
        const blockers = (await q('SELECT pg_blocking_pids($1) AS pids', [pidB])) as {
          pids: number[];
        }[];
        expect(blockers[0].pids).toContain(pidA);
        await open();
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('B did not finish within 10 s')), 10_000).unref(),
        );
        const [x, y] = await Promise.race([Promise.all([first, second]), timeout]);
        expect([x.status, y.status]).toEqual([500, 201]);
      });
    });
  });
});
