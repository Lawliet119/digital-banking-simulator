import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { AiGate } from '../../src/modules/risk/ai/ai-gate';
import { CreateAiGate1795000001000 } from '../../src/database/migrations/1795000001000-CreateAiGate';

async function main() {
  const connectionString = process.env.AI_GATE_SMOKE_DATABASE_URL;
  assert(
    connectionString,
    'AI_GATE_SMOKE_DATABASE_URL must point to an isolated empty PostgreSQL database',
  );
  const childMode = process.argv.includes('--abandon') || process.argv.includes('--probe');
  const policy = childMode
    ? (JSON.parse(process.env.AI_GATE_SMOKE_POLICY ?? 'null') as {
        revision: string;
        dailyRequestLimit: number;
        concurrentLimit: number;
      })
    : { revision: 'isolated-smoke', dailyRequestLimit: 2, concurrentLimit: 1 };
  const gate = new AiGate({ connectionString, policy, deadlineMs: 1000 });
  if (childMode) {
    const permit = await gate.tryAcquire();
    if (process.argv.includes('--abandon')) assert.equal(permit.kind, 'granted');
    else console.log(permit.kind);
    // Deliberate process death: no release; DB capacity must remain reserved.
    process.exit(0);
  }
  assert.equal(
    process.env.AI_GATE_SMOKE_ALLOW_DDL,
    'isolated-only',
    'Explicit isolated DDL acknowledgement required',
  );
  const source = await new DataSource({ type: 'postgres', url: connectionString }).initialize();
  const runner = source.createQueryRunner();
  await runner.connect();
  try {
    assert.deepEqual(
      await runner.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"),
      [],
      'Smoke refuses any database containing public tables',
    );
    await new CreateAiGate1795000001000().up(runner);
    await runner.query(
      'INSERT INTO ai_gate_policy(revision,daily_limit,concurrent_limit) VALUES($1,$2,$3)',
      [policy.revision, policy.dailyRequestLimit, policy.concurrentLimit],
    );
    const results = await Promise.all(Array.from({ length: 8 }, () => gate.tryAcquire()));
    assert.equal(results.filter(r => r.kind === 'granted').length, 1);
    const permit = results.find(r => r.kind === 'granted');
    assert(permit?.kind === 'granted');
    permit.release();
    permit.release();
    let active = 1;
    for (let i = 0; i < 100 && active; i++) {
      [{ active }] = await runner.query(
        'SELECT count(*)::int AS active FROM ai_gate_permits WHERE released_at IS NULL',
      );
      if (active) await delay(10);
    }
    assert.equal(active, 0);
    assert.equal((await gate.tryAcquire()).kind, 'granted');
    assert.deepEqual(await gate.tryAcquire(), { kind: 'budget_exhausted' });
    console.log('Durable gate smoke passed; no provider requests sent.');
  } finally {
    // The populated gate deliberately refuses rollback. Its caller drops the isolated database.
    await runner.release();
    await source.destroy();
  }
}

void main().catch(() => {
  // Never print connection strings or driver error details.
  console.error('Gate smoke failed; check isolated DB prerequisites and assertions.');
  process.exitCode = 1;
});
