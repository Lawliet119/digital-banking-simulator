import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { createClient, type RedisClientType } from 'redis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { LATEST_KEY, RuleSetRepository } from '@modules/risk/config/rule-set.repository';
import { RiskMetrics } from '@modules/risk/risk.metrics';
import { startRiskConfigApp } from '../support/risk-config-app';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

async function main(): Promise<void> {
  const fixture = await startRiskConfigApp();
  let valkey: StartedValkey | undefined;
  let redis: RedisClient | undefined;
  let adminRedis: RedisClientType | undefined;
  try {
    const admin = await fixture.issuer.token('admin', { sub: randomUUID() });
    const operator = await fixture.issuer.token('operator', { sub: randomUUID() });
    const root = '/v1/admin/risk-config';
    const initial = await request(fixture.url)
      .get(root)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    assert.equal(initial.body.version, 1);
    const config = initial.body.config as Record<string, unknown>;
    const create = () =>
      request(fixture.url)
        .post(`${root}/versions`)
        .auth(admin, { type: 'bearer' })
        .send({ config });
    const first = await create().expect(201);
    assert.equal(first.body.version, 2);
    const detail = await request(fixture.url)
      .get(`${root}/versions/2`)
      .auth(admin, { type: 'bearer' })
      .expect(200);
    assert.deepEqual(detail.body, first.body);
    await request(fixture.url).get(root).auth(operator, { type: 'bearer' }).expect(403);
    await request(fixture.url)
      .post(`${root}/versions`)
      .auth(admin, { type: 'bearer' })
      .send({ config: { ...config, ai: { threshold: 0 } } })
      .expect(400);
    const concurrent = await Promise.all([create(), create()]);
    assert.deepEqual(
      concurrent.map(response => Number(response.body.version)).sort((a, b) => a - b),
      [3, 4],
    );
    assert.deepEqual(
      concurrent.map(response => response.status),
      [201, 201],
    );
    valkey = await startValkeyContainer();
    adminRedis = createClient({ url: valkey.url });
    adminRedis.on('error', () => undefined);
    await adminRedis.connect();
    redis = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    const deadline = Date.now() + 5000;
    while (!redis.isReady && Date.now() < deadline) await wait(10);
    if (!redis.isReady) throw new Error('Valkey unavailable');
    const db = fixture.app.get(DataSource);
    const repo = new RuleSetRepository({ redis, db, metrics: new RiskMetrics() });
    assert.equal((await repo.current()).version, 4);
    const ttl = await adminRedis.pTTL(LATEST_KEY);
    assert.ok(ttl > 0 && ttl <= 60_000);
    const latest = await create().expect(201);
    assert.equal(latest.body.version, 5);
    assert.equal((await repo.current()).version, 4);
    await adminRedis.del(LATEST_KEY);
    assert.equal((await repo.current()).version, 5);
    redis.onModuleDestroy();
    const fallback = new RuleSetRepository({ redis, db, metrics: new RiskMetrics() });
    assert.equal((await fallback.current()).version, 5);
    const [audit] = (await fixture.db.runner.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action='risk_config.create'",
    )) as { n: number }[];
    assert.equal(audit.n, 4);
    console.log(`M-160 correlationId=${String(first.headers['x-correlation-id'])}`);
    console.log('M-160 PASS: admin GET v1, create v2, GET detail v2; operator 403, invalid AI 400');
    console.log(
      'M-160 PASS: concurrent versions 3/4; four committed versions have four audit rows',
    );
    console.log('M-160 PASS: cache latest TTL <=60s, miss and Redis outage read PostgreSQL v5');
  } finally {
    redis?.onModuleDestroy();
    if (adminRedis?.isOpen) adminRedis.destroy();
    await valkey?.stop();
    await fixture.close();
  }
}

void main().catch(() => {
  console.error('M-160 FAIL: inspect isolated test prerequisites and assertions');
  process.exitCode = 1;
});
