import { APP_GUARD } from '@nestjs/core';

/**
 * TC-89-13. The rate limit is only worth anything if the real `AppModule` wires it: the per-IP
 * middleware (inside `RateLimitModule`) in front of everything, the per-customer guard after the
 * JWT and role guards, and the transfer route marked. Static facts of the module graph, so no
 * database is needed; `process.env` is set before the dynamic import because `modules/index.ts`
 * reads `APP_ROLE` when `app.module.ts` is evaluated (same technique as app-guard.e2e-spec.ts).
 */
describe('TC-89-13 the real AppModule wires the rate limit', () => {
  const original = process.env;
  beforeAll(() => {
    process.env = {
      ...original,
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL: original.DATABASE_URL ?? 'postgres://banking:x@localhost:5432/banking',
      REDIS_URL: original.REDIS_URL ?? 'redis://localhost:6379',
    };
  });
  afterAll(() => {
    process.env = original;
  });

  it('registers the global guards JWT, roles, then the per-customer transfer limit', async () => {
    const { AppModule } = await import('../src/app.module');
    const { JwtAuthGuard, RolesGuard } = await import('@modules/identity');
    const { TransferRateLimitGuard } = await import('@common/rate-limit');
    const providers = Reflect.getMetadata('providers', AppModule) as {
      provide?: unknown;
      useClass?: unknown;
    }[];
    const guards = providers.filter(p => p.provide === APP_GUARD).map(p => p.useClass);
    expect(guards).toEqual([JwtAuthGuard, RolesGuard, TransferRateLimitGuard]);
  });

  it('loads RateLimitModule (and so the per-IP middleware) when the process serves HTTP', async () => {
    const { AppModule } = await import('../src/app.module');
    const { RateLimitModule } = await import('@common/rate-limit');
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(RateLimitModule);
  });

  it('keeps RateLimitModule out of a worker process (it has no HTTP to limit)', async () => {
    jest.resetModules();
    // A worker also validates the queue settings; the module graph is all this reads.
    process.env = {
      ...process.env,
      APP_ROLE: 'worker',
      SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk',
      SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification',
    };
    const { AppModule } = await import('../src/app.module');
    const { RateLimitModule } = await import('@common/rate-limit');
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).not.toContain(RateLimitModule);
    const providers = Reflect.getMetadata('providers', AppModule) as { provide?: unknown }[];
    expect(providers.filter(p => p.provide === APP_GUARD)).toEqual([]);
  });

  it('marks POST /v1/transfers, and nothing else, for the per-customer limit', async () => {
    jest.resetModules();
    const { TransfersController } = await import('@modules/ledger/transfers.controller');
    const { LIMIT_TRANSFERS_KEY } = await import('@common/rate-limit/limit-transfers.decorator');
    const proto = TransfersController.prototype as unknown as Record<string, unknown>;
    const marked = Object.getOwnPropertyNames(proto).filter(
      name =>
        name !== 'constructor' &&
        Reflect.getMetadata(LIMIT_TRANSFERS_KEY, proto[name] as object) === true,
    );
    expect(marked).toEqual(['transfer']);
  });
});
