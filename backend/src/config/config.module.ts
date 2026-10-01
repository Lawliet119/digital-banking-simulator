import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import {
  appConfig,
  authConfig,
  databaseConfig,
  limitsConfig,
  redisConfig,
  sqsConfig,
  validateEnv,
} from './index';

/**
 * Global typed configuration.
 *
 * `process.env` is already populated by `env.bootstrap.ts` (env file) or by the platform (ECS),
 * so Nest is told to ignore env files. `validate` runs the Joi schema at boot: a missing or
 * malformed variable stops the process before it serves a single request.
 *
 * Inject a group with `@Inject(databaseConfig.KEY) private cfg: ConfigType<typeof databaseConfig>`.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [appConfig, authConfig, databaseConfig, limitsConfig, redisConfig, sqsConfig],
      validate: validateEnv,
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
