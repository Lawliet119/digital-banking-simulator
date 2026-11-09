import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { EmfDocument } from '../src/common/metrics/emf';
import type { MetricsService } from '../src/common/metrics';

/**
 * DBS-144: the REAL AppModule (role api) with the EMF export on, measured through the same
 * `configureHttpApp` wiring that `main.ts` uses. Guards answer 401 after the route is matched, so
 * the route template is visible without a database row.
 */
describe('HTTP metrics (e2e, real AppModule)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let metrics: MetricsService;
  const docs: EmfDocument[] = [];
  const original = process.env;

  const names = (doc: EmfDocument): string[] =>
    doc._aws.CloudWatchMetrics[0].Metrics.map(m => m.Name);
  const lineFor = (route: string, method: string, metric: string): EmfDocument | undefined =>
    docs.find(d => d.Route === route && d.Method === method && names(d).includes(metric));

  beforeAll(async () => {
    process.env = {
      ...original,
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      METRICS_EMF: 'true',
      METRICS_FLUSH_MS: '600000',
      RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE: '100000',
      DATABASE_URL:
        original.DATABASE_URL ?? 'postgres://banking:banking_local_only@localhost:5432/banking',
      REDIS_URL: original.REDIS_URL ?? 'redis://localhost:6379',
    };
    const { AppModule } = await import('../src/app.module');
    const { configureHttpApp } = await import('../src/app.setup');
    const { MetricsService: Service } = await import('../src/common/metrics');
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: ['error', 'warn'],
    });
    metrics = app.get(Service);
    Object.assign(metrics, { sink: (doc: EmfDocument) => docs.push(doc) });
    configureHttpApp(
      app as NestExpressApplication,
      { trustProxyHops: 0, corsOrigins: [], isProduction: false },
      undefined,
      metrics.httpMiddleware(),
    );
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
    process.env = original;
  });

  it('TC-144-05 measures a route by its template: two ids, one line, no id anywhere', async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) await request(server).get(`/v1/accounts/${id}`).expect(401);
    await request(server).get('/v1/identity/me').expect(401);

    await metrics.flush();

    const counters = lineFor('/v1/accounts/:id', 'GET', 'http_requests_total');
    expect(counters).toBeDefined();
    expect(counters?.http_requests_total).toBe(2);
    expect(counters?.http_5xx_total).toBe(0);
    expect(lineFor('/v1/identity/me', 'GET', 'http_requests_total')?.http_requests_total).toBe(1);
    const latency = lineFor('/v1/accounts/:id', 'GET', 'http_request_duration_ms');
    expect((latency?.http_request_duration_ms as number[]).length).toBe(2);

    const text = JSON.stringify(docs);
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('TC-144-05 a path that matches no route is unmatched, and a 401 is not a 5xx', async () => {
    docs.length = 0;
    await request(server).get(`/no/such/${randomUUID()}`).expect(404);
    await request(server).get('/v1/identity/me').expect(401);
    await metrics.flush();

    expect(lineFor('unmatched', 'GET', 'http_requests_total')?.http_requests_total).toBe(1);
    expect(lineFor('/v1/identity/me', 'GET', 'http_5xx_total')?.http_5xx_total).toBe(0);
    expect(JSON.stringify(docs)).not.toContain('/no/such');
  });

  it('TC-144-05 a health probe reports per route only, so it does not dilute the service-wide rate', async () => {
    docs.length = 0;
    await request(server).get('/health/live').expect(200);
    await metrics.flush();

    const probe = lineFor('/health/live', 'GET', 'http_requests_total');
    expect(probe?._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Route', 'Method']]);
    const api = docs.find(d => d.Route === '/v1/identity/me');
    expect(api).toBeUndefined();
  });

  it('TC-144-05 every line is valid for CloudWatch: numbers or arrays of at most 100, a known dimension set', async () => {
    docs.length = 0;
    for (let i = 0; i < 150; i++) await request(server).get('/v1/identity/me').expect(401);
    await metrics.flush();

    expect(docs.length).toBeGreaterThan(2);
    for (const doc of docs) {
      for (const name of names(doc)) {
        const value = doc[name];
        expect(typeof value === 'number' || (Array.isArray(value) && value.length <= 100)).toBe(
          true,
        );
      }
    }
    const samples = docs
      .filter(d => d.http_request_duration_ms !== undefined)
      .flatMap(d => d.http_request_duration_ms as number[]);
    expect(samples).toHaveLength(150);
    expect(lineFor('/v1/identity/me', 'GET', 'http_requests_total')?.http_requests_total).toBe(150);
  });
});
