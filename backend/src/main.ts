// Must stay the first import: fills process.env from env/.env.<NODE_ENV> before AppModule is
// evaluated, because APP_ROLE decides which modules AppModule imports.
import './config/env.bootstrap';
// Every role, the worker included, must be able to JSON.stringify a bigint (SQS payloads, outbox,
// audit jsonb); the worker never goes through configureHttpApp.
import '@common/money/bigint-json.bootstrap';
import type { INestApplicationContext } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, PinoLogger } from 'nestjs-pino';
import { configureHttpApp, setupSwagger } from './app.setup';
import { AppRole, getAppRole, runsHttp } from './common/app-role/app-role';
import { createHttpLogging } from './common/logging/http-logging';
import { createLoggingOptions, safeErrorMetadata } from './common/logging/logging.options';
import { appConfig } from './config/app.config';

async function bootstrap(): Promise<void> {
  // Establish JSON logging before AppModule evaluation, which can reject invalid configuration.
  let initialRole = AppRole.Api;
  try {
    initialRole = getAppRole();
  } catch {
    /* Invalid roles are reported safely below. */
  }
  const logger = new Logger(
    new PinoLogger({
      pinoHttp: createLoggingOptions({ role: initialRole, logLevel: process.env.LOG_LEVEL }),
    }),
    {},
  );
  let context: INestApplicationContext | undefined;
  try {
    const role = getAppRole();
    const { AppModule } = await import('./app.module');
    const options = { logger, abortOnError: false };

    if (!runsHttp(role)) {
      context = await NestFactory.createApplicationContext(AppModule, options);
      context.enableShutdownHooks();
      setInterval(() => undefined, 60_000);
      logger.log('Worker started — no HTTP listener', 'Bootstrap');
      return;
    }

    const app = await NestFactory.create<NestExpressApplication>(AppModule, options);
    context = app;
    const config: ConfigType<typeof appConfig> = app.get(appConfig.KEY);
    app.enableShutdownHooks();
    configureHttpApp(app, config, createHttpLogging(await app.resolve(PinoLogger), config));
    if (!config.isProduction) setupSwagger(app);
    await app.listen(config.port, '0.0.0.0');
    logger.log({ port: config.port }, 'HTTP listener started', 'Bootstrap');
    if (!config.isProduction) logger.log('Swagger UI available at /docs', 'Bootstrap');
  } catch (error) {
    logger.error(safeErrorMetadata(error), 'Application startup failed', 'Bootstrap');
    if (context) {
      try {
        await context.close();
      } catch (closeError) {
        logger.error(safeErrorMetadata(closeError), 'Application shutdown failed', 'Bootstrap');
      }
    }
    process.exitCode = 1;
  }
}

void bootstrap();
