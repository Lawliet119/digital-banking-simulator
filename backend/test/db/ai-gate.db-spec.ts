import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { CreateAiGate1795000001000 } from '../../src/database/migrations/1795000001000-CreateAiGate';
import { AiGatePermitExpiry1795000003000 } from '../../src/database/migrations/1795000003000-AiGatePermitExpiry';
import { AiGate, type AiGatePolicy } from '../../src/modules/risk/ai/ai-gate';
import { createTempDatabase, type TempDatabase } from '../support/temp-database';

const policy: AiGatePolicy = { revision: 'test-v1', dailyRequestLimit: 7, concurrentLimit: 3 };

describe('RSK-02 durable PostgreSQL gate', () => {
  let db: TempDatabase;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const gate = (p = policy, deadlineMs = 1000) =>
    new AiGate({ connectionString: db.url, policy: p, deadlineMs });
  const acquireSql = (token = randomUUID()) =>
    q('SELECT public.ai_gate_acquire($1,$2,$3,$4) AS result', [
      token,
      policy.revision,
      policy.dailyRequestLimit,
      policy.concurrentLimit,
    ]);
  beforeEach(async () => {
    db = await createTempDatabase();
    await new CreateAiGate1795000001000().up(db.runner);
    await new AiGatePermitExpiry1795000003000().up(db.runner);
    await q(
      'INSERT INTO public.ai_gate_policy(revision,daily_limit,concurrent_limit) VALUES($1,$2,$3)',
      [policy.revision, policy.dailyRequestLimit, policy.concurrentLimit],
    );
  });
  afterEach(async () => {
    if (db?.runner.isTransactionActive) await db.runner.rollbackTransaction();
    await db?.drop();
  });

  it('shares distinct durable permits between simultaneously running worker processes', async () => {
    const run = promisify(execFile);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            resolve(__dirname, '../manual/ai-gate-smoke.ts'),
            '--probe',
          ],
          {
            env: {
              ...process.env,
              AI_GATE_SMOKE_DATABASE_URL: db.url,
              AI_GATE_SMOKE_POLICY: JSON.stringify(policy),
            },
            timeout: 15000,
          },
        ),
      ),
    );
    expect(results.filter(r => r.stdout.trim() === 'granted')).toHaveLength(3);
    expect(results.every(r => ['granted', 'unavailable'].includes(r.stdout.trim()))).toBe(true);
    const [state] =
      await q(`SELECT count(*)::int AS active, count(DISTINCT token)::int AS distinct_tokens
      FROM ai_gate_permits WHERE released_at IS NULL`);
    expect(state).toEqual({ active: 3, distinct_tokens: 3 });
    expect((await q('SELECT requests::int AS used FROM ai_gate_days'))[0].used).toBe(3);
  }, 30000);

  it('never reissues a known token, even after release', async () => {
    const token = randomUUID();
    expect((await acquireSql(token))[0].result).toBe('granted');
    expect((await acquireSql(token))[0].result).toBe('unavailable');
    await q('SELECT public.ai_gate_release($1)', [token]);
    expect((await acquireSql(token))[0].result).toBe('unavailable');
    expect((await q('SELECT requests::int AS used FROM ai_gate_days'))[0].used).toBe(1);
  });

  it('refuses rollback after a reservation so quota cannot silently reset', async () => {
    expect((await gate().tryAcquire()).kind).toBe('granted');
    await db.runner.startTransaction();
    await expect(new CreateAiGate1795000001000().down(db.runner)).rejects.toThrow(
      'Refusing to revert populated AI gate',
    );
    await db.runner.rollbackTransaction();
    expect((await q('SELECT requests::int AS used FROM ai_gate_days'))[0].used).toBe(1);
    expect((await q('SELECT count(*)::int AS active FROM ai_gate_permits'))[0].active).toBe(1);
  });

  it('refuses stale-snapshot rollback after another session reserves a permit', async () => {
    await db.runner.startTransaction('REPEATABLE READ');
    expect((await q('SELECT count(*)::int AS n FROM public.ai_gate_permits'))[0].n).toBe(0);
    expect((await gate().tryAcquire()).kind).toBe('granted');
    await expect(new CreateAiGate1795000001000().down(db.runner)).rejects.toThrow(
      'AI gate rollback requires READ COMMITTED',
    );
    await db.runner.rollbackTransaction();
    expect((await q('SELECT count(*)::int AS n FROM public.ai_gate_permits'))[0].n).toBe(1);
  });

  it('bounds failed cleanup and conservatively retains the stranded permit', async () => {
    const permit = await gate(policy, 100).tryAcquire();
    expect(permit.kind).toBe('granted');
    if (permit.kind !== 'granted') throw new Error('Expected permit');
    await db.runner.startTransaction();
    await q('SELECT * FROM ai_gate_permits FOR UPDATE');
    const started = performance.now();
    permit.release();
    permit.release();
    expect(performance.now() - started).toBeLessThan(100);
    await delay(300);
    await db.runner.rollbackTransaction();
    expect(
      (await q('SELECT count(*)::int AS active FROM ai_gate_permits WHERE released_at IS NULL'))[0]
        .active,
    ).toBe(1);
    expect((await q('SELECT requests::int AS used FROM ai_gate_days'))[0].used).toBe(1);
  });

  it('expires a stranded permit after the policy TTL but never refunds the daily request', async () => {
    for (let i = 0; i < policy.concurrentLimit; i++) {
      expect((await gate().tryAcquire()).kind).toBe('granted');
    }
    expect(await gate().tryAcquire()).toEqual({ kind: 'unavailable' }); // all three slots busy
    // Two permits were lost long ago (killed worker); one is still inside its TTL.
    await q(
      `UPDATE ai_gate_permits SET reserved_at = clock_timestamp() - interval '1 hour'
       WHERE token IN (SELECT token FROM ai_gate_permits ORDER BY token LIMIT 2)`,
    );
    expect((await gate().tryAcquire()).kind).toBe('granted');
    expect((await gate().tryAcquire()).kind).toBe('granted');
    expect(await gate().tryAcquire()).toEqual({ kind: 'unavailable' }); // back at 3 live permits
    expect((await q('SELECT requests::int AS used FROM ai_gate_days'))[0].used).toBe(5);
  });

  it('keeps a permit that is still inside its TTL', async () => {
    await q('UPDATE ai_gate_policy SET permit_ttl_seconds = 60');
    for (let i = 0; i < policy.concurrentLimit; i++) await gate().tryAcquire();
    await q("UPDATE ai_gate_permits SET reserved_at = clock_timestamp() - interval '30 seconds'");
    expect(await gate().tryAcquire()).toEqual({ kind: 'unavailable' });
    await q("UPDATE ai_gate_permits SET reserved_at = clock_timestamp() - interval '61 seconds'");
    expect((await gate().tryAcquire()).kind).toBe('granted');
  });

  it('reverts the expiry migration back to the unbounded count', async () => {
    await new AiGatePermitExpiry1795000003000().down(db.runner);
    for (let i = 0; i < policy.concurrentLimit; i++) await gate().tryAcquire();
    await q("UPDATE ai_gate_permits SET reserved_at = clock_timestamp() - interval '1 day'");
    expect(await gate().tryAcquire()).toEqual({ kind: 'unavailable' });
  });

  it('serializes independent clients and never exceeds either limit', async () => {
    let granted = 0;
    for (let wave = 0; wave < 4; wave++) {
      const results = await Promise.all(Array.from({ length: 20 }, () => gate().tryAcquire()));
      const permits = results.filter(r => r.kind === 'granted');
      expect(permits.length).toBeLessThanOrEqual(3);
      granted += permits.length;
      const [counts] =
        await q(`SELECT (SELECT count(*) FROM ai_gate_permits WHERE released_at IS NULL)::int AS active,
        (SELECT requests::int FROM ai_gate_days WHERE day = (clock_timestamp() AT TIME ZONE 'UTC')::date) AS used`);
      expect(counts.active).toBeLessThanOrEqual(3);
      expect(counts.used).toBeLessThanOrEqual(7);
      await q(
        'UPDATE ai_gate_permits SET released_at = clock_timestamp() WHERE released_at IS NULL',
      );
    }
    expect(granted).toBe(7);
    expect(await gate().tryAcquire()).toEqual({ kind: 'budget_exhausted' });
  });

  it('release is idempotent, bounded, and does not refund requests', async () => {
    const permit = await gate().tryAcquire();
    expect(permit.kind).toBe('granted');
    if (permit.kind !== 'granted') throw new Error('Expected permit');
    permit.release();
    permit.release();
    // release is deliberately void; wait for its actual database effect, with a fixed bound.
    let active = 1;
    for (let i = 0; i < 100 && active; i++) {
      [{ active }] = await q(
        'SELECT count(*)::int AS active FROM ai_gate_permits WHERE released_at IS NULL',
      );
      if (active) await delay(10);
    }
    expect(active).toBe(0);
    const [{ token, released_at: first }] = await q(
      'SELECT token,released_at FROM ai_gate_permits',
    );
    await q('SELECT public.ai_gate_release($1)', [token]);
    const [{ released_at: second }] = await q('SELECT released_at FROM ai_gate_permits');
    expect(second).toEqual(first);
    expect((await q('SELECT requests::int AS used FROM ai_gate_days'))[0].used).toBe(1);
  });

  it('new UTC day resets only request accounting, retaining permits still inside their TTL', async () => {
    // Operator-owned fixture models persisted state immediately after midnight; never mock DB time.
    await q(`INSERT INTO ai_gate_days VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date - 1, 7);
      INSERT INTO ai_gate_permits(token,reserved_at)
      SELECT gen_random_uuid(), clock_timestamp() - interval '1 minute' FROM generate_series(1,3)`);
    expect(await gate().tryAcquire()).toEqual({ kind: 'unavailable' });
    await q('UPDATE ai_gate_permits SET released_at = clock_timestamp()');
    expect((await gate().tryAcquire()).kind).toBe('granted');
    expect(
      (await q('SELECT requests::int AS used FROM ai_gate_days ORDER BY day')).map(
        (r: { used: number }) => r.used,
      ),
    ).toEqual([7, 1]);
  });

  it('client death/restart never frees a committed permit or request', async () => {
    execFileSync(
      process.execPath,
      ['-r', 'ts-node/register', resolve(__dirname, '../manual/ai-gate-smoke.ts'), '--abandon'],
      {
        env: {
          ...process.env,
          AI_GATE_SMOKE_DATABASE_URL: db.url,
          AI_GATE_SMOKE_POLICY: JSON.stringify(policy),
        },
        timeout: 15000,
        stdio: 'pipe',
      },
    );
    expect((await acquireSql())[0].result).toBe('granted');
    expect((await acquireSql())[0].result).toBe('granted');
    expect(await gate().tryAcquire()).toEqual({ kind: 'unavailable' });
    expect((await q('SELECT requests::int AS used FROM ai_gate_days'))[0].used).toBe(3);
  });

  it('denies absent, malformed and mismatched policies without reserving', async () => {
    expect(await new AiGate().tryAcquire()).toEqual({ kind: 'unavailable' });
    for (const p of [
      { ...policy, dailyRequestLimit: NaN },
      { ...policy, concurrentLimit: 0 },
      { ...policy, dailyRequestLimit: 8 },
      { ...policy, revision: 'different' },
    ])
      expect(await gate(p).tryAcquire()).toEqual({ kind: 'unavailable' });
    await q('DELETE FROM ai_gate_policy');
    expect(await gate().tryAcquire()).toEqual({ kind: 'unavailable' });
    expect(await q('SELECT * FROM ai_gate_permits')).toEqual([]);
  });

  it('fails closed within its deadline on row lock and refused connection', async () => {
    await db.runner.startTransaction();
    await q('SELECT * FROM ai_gate_policy FOR UPDATE');
    const start = performance.now();
    expect(await gate(policy, 100).tryAcquire()).toEqual({ kind: 'unavailable' });
    expect(performance.now() - start).toBeLessThan(2000);
    // A client deadline can precede PostgreSQL observing the closed socket. Keep the policy lock
    // until the server session has finished, or unlocking can let the abandoned query commit.
    const closeDeadline = Date.now() + 5000;
    for (;;) {
      await q('SELECT pg_stat_clear_snapshot()');
      const [{ active }] = await q(
        `SELECT count(*)::int AS active FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = 'fraud-ai-gate'`,
      );
      if (active === 0) break;
      if (Date.now() >= closeDeadline) throw new Error('AI gate session did not close');
      await delay(25);
    }
    await db.runner.rollbackTransaction();
    const bad = new URL(db.url);
    bad.port = '1';
    expect(
      await new AiGate({ connectionString: bad.toString(), policy, deadlineMs: 100 }).tryAcquire(),
    ).toEqual({ kind: 'unavailable' });
    expect(await q('SELECT * FROM ai_gate_permits')).toEqual([]);
  });

  it('PUBLIC has neither table access nor function execute', async () => {
    const rows = await q(`SELECT EXISTS (
      SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = 'public.ai_gate_policy'::regclass AND a.grantee = 0
    ) AS table_access, EXISTS (
      SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = 'public.ai_gate_acquire(uuid,text,integer,integer)'::regprocedure AND a.grantee = 0
    ) AS acquire, EXISTS (
      SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = 'public.ai_gate_release(uuid)'::regprocedure AND a.grantee = 0
    ) AS release`);
    expect(rows[0]).toEqual({ table_access: false, acquire: false, release: false });
  });
});
