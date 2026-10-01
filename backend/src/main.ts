// Must stay the first import: fills process.env from env/.env.<NODE_ENV> before AppModule is
// evaluated, because APP_ROLE decides which modules AppModule imports.
import './config/env.bootstrap';
import { type ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureHttpApp, setupSwagger } from './app.setup';
import { getAppRole, runsHttp } from './common/app-role/app-role';
import { logLevels } from './common/utils/log-levels';
import { appConfig } from './config';

async function bootstrap(): Promise<void> {
  const role = getAppRole();
  const logger = logLevels(process.env.LOG_LEVEL);

  // `worker` role: no HTTP server at all. Consumers and schedulers keep the process alive.
  if (!runsHttp(role)) {
    const context = await NestFactory.createApplicationContext(AppModule, { logger });
    context.enableShutdownHooks();
    // Held open so the process does not exit while no consumer has registered a handle yet.
    // A shutdown signal closes the context and ends the process regardless of this timer.
    setInterval(() => undefined, 60_000);
    console.log(`Worker started (role=${role}) — no HTTP listener`);
    return;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  const config: ConfigType<typeof appConfig> = app.get(appConfig.KEY);

  app.enableShutdownHooks();
  configureHttpApp(app, config);
  if (!config.isProduction) {
    setupSwagger(app);
  }

  await app.listen(config.port, '0.0.0.0');
  console.log(`Listening on http://localhost:${config.port} (role=${role})`);
  if (!config.isProduction) {
    console.log(`Swagger UI: http://localhost:${config.port}/docs`);
  }
}

void bootstrap();
