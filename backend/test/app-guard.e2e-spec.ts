import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';

/**
 * Boots the REAL `AppModule` (role `api`, real PostgreSQL from docker compose) — every other e2e
 * spec boots a single module in isolation, so none of them proves that `JwtAuthGuard` actually
 * applies by default to a route that does nothing to opt in (DBS-50, domain-review vòng 2 #1).
 * `process.env` is set before the dynamic import, same technique as transaction-wiring.e2e-spec.ts,
 * because `modules/index.ts` reads `APP_ROLE` the moment `app.module.ts` is evaluated.
 */
describe('JwtAuthGuard as the default global guard (e2e, real AppModule)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const original = process.env;

  beforeAll(async () => {
    process.env = {
      ...original,
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      // CI's postgres service already sets DATABASE_URL (see .github/workflows/ci.yml); local
      // dev falls back to docker-compose's default. Never hardcode a port here — a machine with
      // its own native PostgreSQL on 5432 may need docker-compose remapped, same as any other
      // manual test (see manual-testing.md).
      DATABASE_URL:
        original.DATABASE_URL ?? 'postgres://banking:banking_local_only@localhost:5432/banking',
      REDIS_URL: original.REDIS_URL ?? 'redis://localhost:6379',
    };

    const { AppModule } = await import('../src/app.module');
    const { configureHttpApp } = await import('../src/app.setup');
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: ['error', 'warn'],
    });
    configureHttpApp(app as NestExpressApplication, {
      trustProxyHops: 0,
      corsOrigins: [],
      isProduction: false,
    });
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
    process.env = original;
  });

  it('TC-50-23: rejects an authenticated-by-default route with no token (401 UNAUTHENTICATED)', async () => {
    // /v1/identity/me has no @Public() and no special wiring beyond being a normal controller —
    // it is the global guard, not a guard it registers itself, that rejects this.
    const res = await request(server).get('/v1/identity/me').expect(401);

    expect(res.body.errorCode).toBe('UNAUTHENTICATED');
  });

  it('TC-50-24: lets the liveness probe through with no token (@Public())', async () => {
    await request(server).get('/health/live').expect(200);
  });

  it('TC-50-25: lets the readiness probe through with no token (@Public())', async () => {
    const res = await request(server).get('/health/ready');

    // Real PostgreSQL from docker compose: expect 200. A reachable-but-not-ready DB would be 503,
    // which is also a legitimate pass for "no token required" — only 401 would be a failure here.
    expect(res.status).not.toBe(401);
  });
});
