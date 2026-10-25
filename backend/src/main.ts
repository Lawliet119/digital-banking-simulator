// Must stay the first import: fills process.env from env/.env.<NODE_ENV> before AppModule is
// evaluated, because APP_ROLE decides which modules AppModule imports.
import './config/env.bootstrap';
// Must stay second: builds the process logger and the crash handlers from LOG_LEVEL and APP_ROLE,
// so even an error thrown while the rest loads is reported as JSON.
import { bootstrapLogger } from './common/logging/process-logging.bootstrap';
// Every role, the worker included, must be able to JSON.stringify a bigint (SQS payloads, outbox,
// audit jsonb); the worker never goes through configureHttpApp.
import '@common/money/bigint-json.bootstrap';
import type { INestApplicationContext } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, PinoLogger } from 'nestjs-pino';
import { configureHttpApp, setupSwagger } from './app.setup';
import { getAppRole, runsHttp } from './common/app-role/app-role';
import { createHttpLogging } from './common/logging/http-logging';
import { safeErrorMetadata } from './common/logging/logging.options';
import { SafeLogger } from './common/logging/safe-logger';
import { appConfig } from './config/app.config';
import { ConfigValidationError } from './config/validation.schema';

async function bootstrap(): Promise<void> {
  // A failing log call must never change what the app does, so every Nest log goes through
  // SafeLogger.
  const logger = new SafeLogger(new Logger(bootstrapLogger, {}));
  let context: INestApplicationContext | undefined;
  let invalidKeys: string[] | undefined;
  try {
    let role;
    try {
      role = getAppRole();
    } catch (error) {
      // Report the key, never the value the operator typed.
      invalidKeys = ['APP_ROLE'];
      throw error;
    }
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
    // Only key names, never the error text: it can quote a credential or a connection string.
    const keys = error instanceof ConfigValidationError ? error.invalidKeys : invalidKeys;
    logger.error(
      { ...safeErrorMetadata(error), ...(keys ? { invalidKeys: keys } : {}) },
      'Application startup failed',
      'Bootstrap',
    );
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
