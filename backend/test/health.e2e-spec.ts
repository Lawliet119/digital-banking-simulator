import { type INestApplication, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HealthCheckError, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureHttpApp } from '../src/app.setup';
import { HealthModule } from '../src/modules/health';
import { RedisClient, RedisUnavailableError } from '@libs/redis';
import { redisConfig } from '@config/redis.config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

describe('Health probes (e2e, database mocked)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const pingCheck = jest.fn();
  const redisPing = jest.fn();

  beforeEach(() => {
    pingCheck.mockReset();
    redisPing.mockReset().mockResolvedValue('PONG');
  });

  beforeAll(async () => {
    // Terminus logs a failed check at error level; that is expected in the 503 case below.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] })
      .overrideProvider(RedisClient)
      .useValue({ ping: redisPing })
      .overrideProvider(redisConfig.KEY)
      .useValue({ url: 'redis://localhost:6379', commandTimeoutMs: 50 })
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
    expect(redisPing).not.toHaveBeenCalled();
  });

  it('GET /health/ready answers 200 when PostgreSQL responds', async () => {
    pingCheck.mockResolvedValueOnce({ database: { status: 'up' } });

    const res = await request(server).get('/health/ready').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
    expect(res.body.redis).toBe('up');
  });
  it('TC-78-01 OpenAPI documents Redis as up or degraded in a successful response', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const response = document.paths['/health/ready'].get!.responses['200'];
    if (!response || '$ref' in response) throw new Error('Readiness response schema missing');
    expect(response.content?.['application/json'].schema).toMatchObject({
      properties: { redis: { enum: ['up', 'degraded'] } },
    });
  });

  it('GET /health/ready answers 503 when PostgreSQL is down, so the ALB drains the task', async () => {
    pingCheck.mockRejectedValueOnce(
      new HealthCheckError('database check failed', { database: { status: 'down' } }),
    );

    const res = await request(server).get('/health/ready').expect(503);

    expect(res.body.details.database.status).toBe('down');
    expect(redisPing).not.toHaveBeenCalled();
  });

  it.each(['TIMEOUT', 'UNAVAILABLE', 'CIRCUIT_OPEN'] as const)(
    'TC-78-02 Redis %s is degraded and remains ready',
    async reason => {
      pingCheck.mockResolvedValueOnce({ database: { status: 'up' } });
      redisPing.mockRejectedValueOnce(new RedisUnavailableError(reason));
      const res = await request(server).get('/health/ready').expect(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        redis: 'degraded',
        info: { database: { status: 'up' } },
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /TIMEOUT|UNAVAILABLE|CIRCUIT_OPEN|stack|password/,
      );
    },
  );
  it('TC-78-02b non-PONG is degraded, not a false healthy cache', async () => {
    pingCheck.mockResolvedValueOnce({ database: { status: 'up' } });
    redisPing.mockResolvedValueOnce('unexpected');
    const res = await request(server).get('/health/ready').expect(200);
    expect(res.body.redis).toBe('degraded');
  });
  it('TC-78-02b programming errors remain sanitized500', async () => {
    pingCheck.mockResolvedValueOnce({ database: { status: 'up' } });
    redisPing.mockRejectedValueOnce(new Error('private credential details'));
    const res = await request(server).get('/health/ready').expect(500);
    expect(res.type).toBe('application/problem+json');
    expect(res.body).toMatchObject({ status: 500, detail: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('private credential details');
  });

  it('are mounted without the /v1 prefix so the path is stable across API versions', async () => {
    await request(server).get('/v1/health/live').expect(404);
  });
});
