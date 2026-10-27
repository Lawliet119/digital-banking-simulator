import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { AppRole } from '@common/app-role/app-role';
import * as publicApi from '@modules/outbox';

describe('TC-57-12 OutboxModule public API and dependency injection', () => {
  const originalEnv = process.env;
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    process.env = originalEnv;
  });

  it('exports only the writer and its module through the public index', () => {
    expect(Object.keys(publicApi).sort()).toEqual(['OutboxModule', 'OutboxWriter']);
  });

  it.each(Object.values(AppRole))(
    'resolves the real writer in the %s role without a database',
    async role => {
      process.env = {
        NODE_ENV: 'test',
        APP_ROLE: role,
        DATABASE_URL: 'postgres://localhost:5432/not_opened',
        REDIS_URL: 'redis://localhost:6379',
        SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk-events',
        SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification-events',
      };
      const { ConfigModule } = await import('../../config/config.module');
      moduleRef = await Test.createTestingModule({
        imports: [ConfigModule, publicApi.OutboxModule],
      }).compile();

      expect(moduleRef.get(publicApi.OutboxWriter)).toBeInstanceOf(publicApi.OutboxWriter);
      expect(await moduleRef.resolve(PinoLogger)).toBeInstanceOf(PinoLogger);
      expect(() => moduleRef!.get(DataSource)).toThrow();
    },
  );
});
