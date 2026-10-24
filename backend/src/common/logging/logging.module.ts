import { Module } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { appConfig } from '@config/app.config';
import { createLoggingOptions } from './logging.options';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [appConfig.KEY],
      useFactory: (config: ConfigType<typeof appConfig>) => ({
        // HTTP logging is installed earlier by configureHttpApp, before CORS and body parsing.
        forRoutes: [],
        pinoHttp: createLoggingOptions(config),
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
