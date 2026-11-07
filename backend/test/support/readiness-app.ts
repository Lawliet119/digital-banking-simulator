import { setTimeout as wait } from 'node:timers/promises';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { redisConfig } from '@config/redis.config';
import { HealthModule } from '@modules/health';
import { configureHttpApp } from '../../src/app.setup';
import { startPostgresContainer, stopPostgresContainer } from './postgres.container';
import { startValkeyContainer, type StartedValkey } from './valkey.container';
import { startLatencyProxy } from './latency-proxy';

export async function waitForReadinessCondition(
  condition: () => boolean,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Readiness fixture condition timed out');
    await wait(10);
  }
}

/** Real HTTP/TypeORM/Redis stack; owns only its disposable containers and proxy. */
export async function startReadinessApp() {
  let valkey: StartedValkey | undefined;
  let proxy: Awaited<ReturnType<typeof startLatencyProxy>> | undefined;
  let app: NestExpressApplication | undefined;
  let module: TestingModule | undefined;
  const close = async () => {
    try {
      if (app) await app.close();
      else await module?.close();
    } finally {
      try {
        await proxy?.stop();
      } finally {
        try {
          await valkey?.stop();
        } finally {
          await stopPostgresContainer();
        }
      }
    }
  };
  try {
    const pg = await startPostgresContainer();
    valkey = await startValkeyContainer();
    proxy = await startLatencyProxy(valkey.host, valkey.port);
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: pg.databaseUrl,
          entities: [],
          synchronize: false,
          retryAttempts: 0,
          extra: { connectionTimeoutMillis: 1000 },
        }),
        HealthModule,
      ],
    })
      .overrideProvider(redisConfig.KEY)
      .useValue({ url: proxy.url, commandTimeoutMs: 50 })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false });
    configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: true });
    await app.listen(0, '127.0.0.1');
    const redis = app.get(RedisClient);
    await waitForReadinessCondition(() => redis.isReady);
    return {
      app,
      redis,
      metrics: app.get(RedisMetrics),
      proxy,
      url: await app.getUrl(),
      async stopRedis() {
        await valkey!.stop();
        await waitForReadinessCondition(() => !redis.isReady);
      },
      stopPostgres: stopPostgresContainer,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
