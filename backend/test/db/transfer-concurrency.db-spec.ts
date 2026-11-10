import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuditService } from '@modules/audit';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
type Target = Awaited<ReturnType<typeof seedDepositTarget>> & { token: string };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Runs the tasks with at most `limit` in flight, keeping the order of the results. */
async function limited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }),
  );
  return results;
}

describe('DBS-80 cross transfers, deadlock retry and database timeouts on the real transfer flow', () => {
  let db: TempDatabase, app: App, fast: App, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const balance = async (id: string): Promise<string> =>
    ((await q('SELECT balance::text AS b FROM accounts WHERE id=$1', [id])) as { b: string }[])[0]
      .b;
  const counts = async () =>
    (
      (await q(
        `SELECT (SELECT count(*) FROM transfers WHERE type='TRANSFER')::int AS transfers,
          (SELECT count(*) FROM ledger_entries)::int AS lines,
          (SELECT count(*) FROM audit_log)::int AS audits,
          (SELECT count(*) FROM outbox_events)::int AS events,
          (SELECT count(*) FROM idempotency_keys)::int AS keys,
          (SELECT jsonb_object_agg(id,balance::text) FROM accounts) AS balances`,
      )) as Record<string, unknown>[]
    )[0];
  /** `via` picks the app (and so the issuer) that signs and serves the request. */
  const send = (via: App, a: Target, to: string, amount: string, key: string) =>
    request(via.url)
      .post('/v1/transfers')
      .auth(a.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ fromAccountId: a.accountId, toAccountId: to, amount });
  async function target(via: App = app, amount = '0'): Promise<Target> {
    const row = await seedDepositTarget(db.runner);
    if (amount !== '0')
      await request(app.url)
        .post('/v1/operator/deposits')
        .auth(operator, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountId: row.accountId, amount })
        .expect(201);
    return { ...row, token: await via.issuer.token('customer', { sub: row.sub }) };
  }

  /**
   * A real PostgreSQL trigger on `ledger_entries`. `nextval` is not rolled back, so the sequence
   * counts how many times the transfer's callback reached its first ledger INSERT.
   */
  async function inject(body: string, action: () => Promise<void>) {
    await q('DROP SEQUENCE IF EXISTS dbs80_attempts');
    await q('CREATE SEQUENCE dbs80_attempts');
    await q(
      `CREATE FUNCTION dbs80_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NULL; END $$`,
    );
    await q(
      'CREATE TRIGGER dbs80_fault BEFORE INSERT ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION dbs80_fault()',
    );
    try {
      await action();
    } finally {
      await q('DROP TRIGGER dbs80_fault ON ledger_entries');
      await q('DROP FUNCTION dbs80_fault()');
    }
  }
  const attempts = async () =>
    (
      (await q(
        'SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS n FROM dbs80_attempts',
      )) as { n: number }[]
    )[0].n;
  const failFirst = (n: number, sqlstate: string) =>
    `IF nextval('dbs80_attempts') <= ${n} THEN RAISE EXCEPTION 'injected %', '${sqlstate}' USING ERRCODE = '${sqlstate}'; END IF;`;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    fast = await startDepositApp(db.url, {
      timeouts: { lockTimeoutMs: 300, statementTimeoutMs: 300, idleInTransactionTimeoutMs: 300 },
    });
    operator = await app.issuer.token('operator', { sub: randomUUID() });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const result = await checkLedgerInvariants(db.runner);
    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
  afterAll(async () => {
    try {
      await fast?.close();
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-99-01..03: ten fifty-request cross-transfer and hot-account bursts', async () => {
    const hotApp = await startDepositApp(db.url, { poolMax: 60 });
    try {
      const peers: Target[] = [];
      for (let i = 0; i < 5; i++) peers.push(await target(hotApp, '100000'));
      const hot = await target(hotApp);
      for (let round = 1; round <= 10; round++) {
        const before = await counts();
        const jobs: { from: Target; to: Target; key: string }[] = [];
        for (let r = 0; r < 5; r++)
          for (let i = 0; i < 5; i++) {
            jobs.push({ from: peers[i], to: peers[(i + 1) % 5], key: randomUUID() });
            jobs.push({ from: peers[i], to: hot, key: randomUUID() });
          }
        const responses = await Promise.all(
          jobs.map(j =>
            send(hotApp, j.from, j.to.accountId, '1000', j.key).timeout({
              response: 15000,
              deadline: 20000,
            }),
          ),
        );
        expect(responses.map(r => r.status)).toEqual(Array(50).fill(201));
        expect(new Set(responses.map(r => r.body.transferId as string)).size).toBe(50);
        const after = await counts();
        for (const [field, delta] of Object.entries({
          transfers: 50,
          lines: 100,
          audits: 50,
          events: 50,
          keys: 50,
        }))
          expect(after[field]).toBe((before[field] as number) + delta);
        for (const peer of peers)
          expect(await balance(peer.accountId)).toBe(String(100000n - BigInt(round) * 5000n));
        expect(await balance(hot.accountId)).toBe(String(BigInt(round) * 25000n));
        const report = await checkLedgerInvariants(db.runner);
        expect(report.status).toBe('PASS');
        expect(report.violations).toEqual([]);
        console.log(
          JSON.stringify({
            scenario: 'DBS-99',
            round,
            responses: 50,
            hotBalance: await balance(hot.accountId),
            invariants: report,
          }),
        );
      }
    } finally {
      await hotApp.close();
    }
  });

  it('TC-98-01..02: AC-5.6 daily limit boundary under parallel race (10 consecutive rounds)', async () => {
    for (let round = 1; round <= 10; round++) {
      const a = await target(app, '300000000'),
        b = await target(app);
      // Pre-send 180,000,000 sequentially (3 x 50m + 1 x 30m)
      for (let i = 0; i < 3; i++) {
        const res = await send(app, a, b.accountId, '50000000', randomUUID());
        expect(res.status).toBe(201);
      }
      const pre30 = await send(app, a, b.accountId, '30000000', randomUUID());
      expect(pre30.status).toBe(201);

      // Fire two parallel 15,000,000 transfers. Exactly one must succeed (201), exactly one must fail (422 LIMIT_PER_DAY_EXCEEDED).
      const [r1, r2] = await Promise.all([
        send(app, a, b.accountId, '15000000', randomUUID()),
        send(app, a, b.accountId, '15000000', randomUUID()),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 422]);

      const rejected = [r1, r2].find(r => r.status === 422)!;
      expect(rejected.body.errorCode).toBe('LIMIT_PER_DAY_EXCEEDED');

      // Verify balances and daily debit limit invariant
      expect(await balance(b.accountId)).toBe('195000000');
      const [{ sent }] = (await q(
        "SELECT sum(amount)::text AS sent FROM ledger_entries WHERE account_id=$1 AND direction='DEBIT'",
        [a.accountId],
      )) as { sent: string }[];
      expect(sent).toBe('195000000');
      expect(BigInt(sent)).toBeLessThanOrEqual(200_000_000n);

      const report = await checkLedgerInvariants(db.runner);
      expect(report.status).toBe('PASS');
      expect(report.violations).toEqual([]);
      console.log(
        JSON.stringify({
          scenario: 'DBS-98-AC-5.6',
          round,
          dailySent: sent,
          invariants: report.status,
        }),
      );
    }
  });

  it('TC-98-03..04: AC-5.2 parallel balance exhaustion: multiple concurrent transfers never drain balance below zero (10 consecutive rounds)', async () => {
    for (let round = 1; round <= 10; round++) {
      const src = await target(app, '50000'),
        dest = await target(app);
      const jobs = Array.from({ length: 20 }, () =>
        send(app, src, dest.accountId, '10000', randomUUID()),
      );
      const responses = await Promise.all(jobs);
      const successes = responses.filter(r => r.status === 201);
      const failures = responses.filter(r => r.status === 422);

      expect(successes).toHaveLength(5);
      expect(failures).toHaveLength(15);
      for (const f of failures) {
        expect(f.body.errorCode).toBe('INSUFFICIENT_FUNDS');
      }

      // Balance must be exactly zero, never negative
      const srcBalance = await balance(src.accountId);
      const destBalance = await balance(dest.accountId);
      expect(srcBalance).toBe('0');
      expect(destBalance).toBe('50000');
      expect(BigInt(srcBalance)).toBeGreaterThanOrEqual(0n);

      const [{ totalOut }] = (await q(
        'SELECT coalesce(sum(amount), 0)::text AS "totalOut" FROM ledger_entries WHERE account_id=$1 AND direction=\'DEBIT\'',
        [src.accountId],
      )) as { totalOut: string }[];
      expect(totalOut).toBe('50000');

      const report = await checkLedgerInvariants(db.runner);
      expect(report.status).toBe('PASS');
      expect(report.violations).toEqual([]);
      console.log(
        JSON.stringify({
          scenario: 'DBS-98-AC-5.2',
          round,
          srcBalance,
          destBalance,
          invariants: report.status,
        }),
      );
    }
  });

  it('TC-80-01 100 A→B and 100 B→A, 20 at a time: all 201, balances back, nothing hangs', async () => {
    const a = await target(app, '10000000'),
      b = await target(app, '10000000');
    const tasks = Array.from({ length: 200 }, (_, i) => () => {
      const [from, to] = i % 2 ? [a, b] : [b, a];
      return send(app, from, to.accountId, '1000', randomUUID());
    });
    const before = await counts();
    const results = await limited(tasks, 20);
    expect(results.map(r => r.status)).toEqual(Array(200).fill(201));
    expect(await balance(a.accountId)).toBe('10000000');
    expect(await balance(b.accountId)).toBe('10000000');
    const after = await counts();
    expect(after.transfers).toBe((before.transfers as number) + 200);
    expect(after.lines).toBe((before.lines as number) + 400);
    expect(after.keys).toBe((before.keys as number) + 200);
  });

  it('TC-80-02 200 opposite transfers at once: only 201 or a well-formed 503, never 500; retries finish once', async () => {
    const a = await target(app, '10000000'),
      b = await target(app, '10000000');
    const jobs = Array.from({ length: 200 }, (_, i) => {
      const [from, to] = i % 2 ? [a, b] : [b, a];
      return { from, to, key: randomUUID() };
    });
    const before = await counts();
    const burst = await Promise.all(
      jobs.map(j => send(app, j.from, j.to.accountId, '1000', j.key)),
    );
    const refused: typeof jobs = [];
    burst.forEach((res, i) => {
      expect([201, 503]).toContain(res.status);
      if (res.status === 503) {
        expect(res.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
        expect(res.headers['retry-after']).toMatch(/^\d+$/);
        refused.push(jobs[i]);
      }
    });
    // The same keys again: a 503 left no key behind, so each is processed as new and only once.
    let pending = refused;
    for (let round = 0; round < 5 && pending.length > 0; round++) {
      const again = await limited(
        pending.map(j => () => send(app, j.from, j.to.accountId, '1000', j.key)),
        5,
      );
      pending = pending.filter((_, i) => again[i].status !== 201);
      for (const res of again) expect([201, 503]).toContain(res.status);
    }
    expect(pending).toHaveLength(0);
    const after = await counts();
    expect(after.transfers).toBe((before.transfers as number) + 200);
    expect(after.keys).toBe((before.keys as number) + 200);
    expect(await balance(a.accountId)).toBe('10000000');
    expect(await balance(b.accountId)).toBe('10000000');
  });

  it.each(['40P01', '40001'])(
    'TC-80-03 %s on the first two attempts: the whole callback runs again and one transfer remains',
    async sqlstate => {
      const a = await target(app, '1000000'),
        b = await target(),
        key = randomUUID(),
        before = await counts();
      await inject(failFirst(2, sqlstate), async () => {
        const res = await send(app, a, b.accountId, '50000', key).expect(201);
        expect(await attempts()).toBe(3);
        const after = await counts();
        expect(after).toMatchObject({
          transfers: (before.transfers as number) + 1,
          lines: (before.lines as number) + 2,
          audits: (before.audits as number) + 1,
          events: (before.events as number) + 1,
          keys: (before.keys as number) + 1,
        });
        expect(
          await q('SELECT transfer_id,response_code FROM idempotency_keys WHERE idem_key=$1', [
            key,
          ]),
        ).toEqual([{ transfer_id: res.body.transferId, response_code: 201 }]);
      });
      expect(await balance(a.accountId)).toBe('950000');
      expect(await balance(b.accountId)).toBe('50000');
    },
  );

  it.each(['40P01', '40001'])(
    'TC-80-04 %s on every attempt: four runs, then 503 + Retry-After and no trace; same key then works',
    async sqlstate => {
      const a = await target(app, '1000000'),
        b = await target(),
        key = randomUUID(),
        before = await counts();
      await inject(failFirst(1000, sqlstate), async () => {
        const res = await send(app, a, b.accountId, '50000', key).expect(503);
        expect(res.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
        expect(res.headers['retry-after']).toMatch(/^\d+$/);
        expect(await attempts()).toBe(4);
        expect(await counts()).toEqual(before);
      });
      await send(app, a, b.accountId, '50000', key).expect(201);
      expect(await balance(b.accountId)).toBe('50000');
    },
  );

  it('TC-80-05 statement timeout: 503 + Retry-After, not retried, no trace; same key then works', async () => {
    const a = await target(fast, '1000000'),
      b = await target(fast),
      key = randomUUID(),
      before = await counts();
    await inject("PERFORM nextval('dbs80_attempts'); PERFORM pg_sleep(1.5);", async () => {
      const res = await send(fast, a, b.accountId, '50000', key).expect(503);
      expect(res.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(await attempts()).toBe(1);
      expect(await counts()).toEqual(before);
    });
    await send(fast, a, b.accountId, '50000', key).expect(201);
  });

  it('TC-80-06 idle in transaction: the server closes the session, 503 + Retry-After, no trace; same key then works', async () => {
    const a = await target(fast, '1000000'),
      b = await target(fast),
      key = randomUUID(),
      before = await counts();
    const audit = fast.app.get(AuditService, { strict: false });
    const original = audit.record.bind(audit);
    // Real flow, real transaction: only a pause of 4x the idle limit is put between two statements.
    jest
      .spyOn(audit, 'record')
      .mockImplementationOnce(async (...args: Parameters<typeof audit.record>) => {
        await sleep(1200);
        return original(...args);
      });
    const res = await send(fast, a, b.accountId, '50000', key).expect(503);
    expect(res.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    expect(await counts()).toEqual(before);
    await send(fast, a, b.accountId, '50000', key).expect(201);
  });

  it('TC-80-07 lock timeout of 300 ms: 503 + Retry-After in about that time, not a hang; same key then works', async () => {
    const a = await target(fast, '1000000'),
      b = await target(fast),
      key = randomUUID(),
      before = await counts(),
      held = fast.source.createQueryRunner();
    await held.connect();
    await held.startTransaction();
    try {
      await held.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [a.accountId]);
      const started = Date.now();
      const res = await send(fast, a, b.accountId, '50000', key).expect(503);
      const elapsed = Date.now() - started;
      expect(res.body.errorCode).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(3000);
      expect(await counts()).toEqual(before);
    } finally {
      await held.rollbackTransaction();
      await held.release();
    }
    await send(fast, a, b.accountId, '50000', key).expect(201);
  });

  it('TC-80-08 every row one transfer wrote (transfer, lines, audit, outbox, key, both balances) comes from a single database transaction', async () => {
    const a = await target(app, '1000000'),
      b = await target(),
      key = randomUUID();
    const res = await send(app, a, b.accountId, '1000', key).expect(201);
    const id = res.body.transferId as string;
    const [x] = (await q(
      `SELECT (SELECT array_agg(DISTINCT xmin::text) FROM transfers WHERE id=$1::uuid) AS transfers,
        (SELECT array_agg(DISTINCT xmin::text) FROM ledger_entries WHERE transfer_id=$1::uuid) AS lines,
        (SELECT array_agg(DISTINCT xmin::text) FROM audit_log WHERE target_id=$1::uuid::text) AS audit,
        (SELECT array_agg(DISTINCT xmin::text) FROM outbox_events WHERE aggregate_id=$1::uuid) AS outbox,
        (SELECT array_agg(DISTINCT xmin::text) FROM idempotency_keys WHERE user_id=$2 AND idem_key=$3) AS key,
        (SELECT array_agg(DISTINCT xmin::text) FROM accounts WHERE id=ANY($4::uuid[])) AS balances`,
      [id, a.userId, key, [a.accountId, b.accountId]],
    )) as Record<string, string[]>[];
    const writers = new Set(Object.values(x).flat());
    expect(Object.values(x).every(list => list.length > 0)).toBe(true);
    expect(writers.size).toBe(1);
  });
});
