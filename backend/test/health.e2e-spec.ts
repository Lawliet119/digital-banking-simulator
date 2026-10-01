import { type INestApplication, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HealthCheckError, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureHttpApp } from '../src/app.setup';
import { HealthModule } from '../src/modules/health';

describe('Health probes (e2e, database mocked)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const pingCheck = jest.fn();

  beforeAll(async () => {
    // Terminus logs a failed check at error level; that is expected in the 503 case below.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] })
      .overrideProvider(TypeOrmHealthIndicator)
      .useValue({ pingCheck })
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
    await nest.init();
    app = nest;
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('GET /health/live answers 200 without touching the database', async () => {
    const res = await request(server).get('/health/live').expect(200);

    expect(res.body).toEqual({ status: 'ok' });
    expect(pingCheck).not.toHaveBeenCalled();
  });

  it('GET /health/ready answers 200 when PostgreSQL responds', async () => {
    pingCheck.mockResolvedValueOnce({ database: { status: 'up' } });

    const res = await request(server).get('/health/ready').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
  });

  it('GET /health/ready answers 503 when PostgreSQL is down, so the ALB drains the task', async () => {
    pingCheck.mockRejectedValueOnce(
      new HealthCheckError('database check failed', { database: { status: 'down' } }),
    );

    const res = await request(server).get('/health/ready').expect(503);

    expect(res.body.details.database.status).toBe('down');
  });

  it('are mounted without the /v1 prefix so the path is stable across API versions', async () => {
    await request(server).get('/v1/health/live').expect(404);
  });
});
