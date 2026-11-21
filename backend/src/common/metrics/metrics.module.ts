import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { RuntimeGauges } from './runtime-stats';

/**
 * Global, so a module that owns something worth measuring (the outbox) can register a gauge
 * without importing this module's internals, and `main.ts` can ask for the HTTP middleware.
 */
@Global()
@Module({
  providers: [MetricsService, RuntimeGauges],
  exports: [MetricsService],
})
export class MetricsModule {}
