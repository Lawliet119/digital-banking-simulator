import request from 'supertest';
import { startReadinessApp } from '../support/readiness-app';

describe('DBS-78 real HTTP readiness with PostgreSQL17 and Valkey', () => {
  let stack: Awaited<ReturnType<typeof startReadinessApp>>;
  beforeAll(async () => {
    stack = await startReadinessApp();
  });
  afterAll(async () => {
    await stack?.close();
  });
  it('TC-78-05 PostgreSQL/Redis up returns200 and redis up', async () => {
    const res = await request(stack.url).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      redis: 'up',
      details: { database: { status: 'up' } },
    });
  });
  it('TC-78-05 real slow Redis remains200/degraded, then recovers', async () => {
    stack.proxy.setDelay(250);
    try {
      const res = await request(stack.url).get('/health/ready').expect(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        redis: 'degraded',
        details: { database: { status: 'up' } },
      });
      expect(await stack.metrics.count()).toBe(1);
    } finally {
      stack.proxy.setDelay(0);
    }
    const restored = await request(stack.url).get('/health/ready').expect(200);
    expect(restored.body.redis).toBe('up');
  });
  it('TC-78-05 stopped Valkey still gives200 while PostgreSQL is alive', async () => {
    await stack.stopRedis();
    const res = await request(stack.url).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      redis: 'degraded',
      info: { database: { status: 'up' } },
    });
    await request(stack.url).get('/health/live').expect(200, { status: 'ok' });
  });
  it('TC-78-03/05 stopped PostgreSQL gives503 while liveness stays200', async () => {
    await stack.stopPostgres();
    const before = await stack.metrics.count();
    const res = await request(stack.url).get('/health/ready').expect(503);
    expect(res.body.details.database.status).toBe('down');
    expect(await stack.metrics.count()).toBe(before);
    await request(stack.url).get('/health/live').expect(200, { status: 'ok' });
  });
});
