import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoNestLogger, PinoLogger } from 'nestjs-pino';
import { configureHttpApp, setupSwagger } from '../../src/app.setup';
import { createHttpLogging } from '../../src/common/logging/http-logging';
import { createLoggingOptions, safeErrorMetadata } from '../../src/common/logging/logging.options';
import { SafeLogger } from '../../src/common/logging/safe-logger';
import { SEARCH_FIXTURE, seedAuditSearchData } from '../support/audit-search-fixtures';
import {
  createTempDatabase,
  migrate,
  requireDatabaseUrl,
  type TempDatabase,
} from '../support/temp-database';

function options(): { port: number; stateFile: string } {
  const args = process.argv.slice(2);
  let port = 3103;
  let stateFile: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = args.slice(index, index + 2);
    if (name === '--port' && value && /^\d+$/.test(value)) {
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Invalid session port');
    } else if (name === '--db-name-file' && value) {
      stateFile = resolve(value);
    } else {
      throw new Error('Use --port <0..65535> --db-name-file <path>');
    }
  }
  if (!stateFile) throw new Error('--db-name-file is required');
  return { port, stateFile };
}

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(): Promise<void> {
  const { port, stateFile } = options();
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('Manual session requires NODE_ENV=development or test');
  }
  if (process.env.APP_ROLE !== 'api') throw new Error('Manual session requires APP_ROLE=api');
  const adminUrl = requireDatabaseUrl();
  let db: TempDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let failure: unknown;
  let stop: () => void = () => undefined;
  const shutdown = new Promise<void>(resolve => {
    stop = resolve;
  });
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    if (line.trim() === 'quit') stop();
  });
  input.once('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    db = await createTempDatabase();
    // State is available even if migration, seed, boot or listen fails after this handle exists.
    writeFileSync(stateFile, `${db.name}\n`, 'utf8');
    await migrate(db.url);
    await seedAuditSearchData(db.runner, { large: true });
    const [row] = (await db.runner.query('SELECT count(*)::text AS count FROM audit_log')) as {
      count: string;
    }[];
    emit({ event: 'audit-search-seed-sql', tables: ['users', 'audit_log'], rows: row.count });
    process.env.DATABASE_URL = db.url;
    const settings = { role: 'api', logLevel: process.env.LOG_LEVEL ?? 'log' } as const;
    const logger = new SafeLogger(
      new PinoNestLogger(new PinoLogger({ pinoHttp: createLoggingOptions(settings) }), {}),
    );
    const { AppModule } = await import('../../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger,
      abortOnError: false,
    });
    configureHttpApp(
      app,
      { trustProxyHops: 0, corsOrigins: [], isProduction: false },
      createHttpLogging(await app.resolve(PinoLogger), settings),
    );
    setupSwagger(app);
    await app.listen(port, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Session has no TCP address');
    emit({
      event: 'audit-search-ready',
      database: db.name,
      port: address.port,
      fixture: SEARCH_FIXTURE,
    });
    await shutdown;
  } catch (error) {
    failure = error;
  } finally {
    try {
      await app?.close();
    } catch (error) {
      failure ??= error;
    } finally {
      // drop() reads the live DATABASE_URL for its admin connection. Restore before calling it,
      // even when app.close() failed: otherwise it would try to drop its own connected database.
      process.env.DATABASE_URL = adminUrl;
      if (db) {
        try {
          await db.drop();
          emit({ event: 'audit-search-cleaned', database: db.name });
        } catch (error) {
          failure ??= error;
          emit({
            event: 'audit-search-cleanup-failed',
            database: db.name,
            ...safeErrorMetadata(error),
          });
        }
      }
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      input.close();
      process.stdin.pause();
    }
  }
  if (failure !== undefined) {
    // Preserve the original driver code for a setup/listen failure without publishing its text.
    if (failure instanceof Error) throw failure;
    throw new Error('Manual session failed');
  }
}

void run().catch((error: unknown) => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  emit({
    event: 'audit-search-session-failed',
    ...safeErrorMetadata(error),
    ...(code === 'EADDRINUSE' ? { code: 'EADDRINUSE' } : {}),
  });
  process.exitCode = 1;
});
