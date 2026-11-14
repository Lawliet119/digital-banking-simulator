import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { limitsConfig } from '@config/limits.config';
import { sqsConfig } from '@config/sqs.config';
import { SqsModule } from '@libs/sqs';
import { Clock, SystemClock } from '@common/clock';
import { OutboxAgeGauge } from './outbox-age.gauge';
import { OutboxCleanupService } from './outbox-cleanup.service';
import { OutboxQuarantineGauge } from './outbox-quarantine.gauge';
import { OutboxRelayService } from './outbox-relay.service';

/**
 * The relay half of the outbox (docs/03 §10). Kept apart from `OutboxModule`, which every role
 * loads to write events: a producer needs no queue client, and an `api` instance must not own a
 * relay. It is listed in `workerModules`; the relay and the cleanup job (DBS-92) also check
 * `runsWorkers()` before they start.
 */
@Module({
  imports: [ConfigModule.forFeature(sqsConfig), ConfigModule.forFeature(limitsConfig), SqsModule],
  providers: [
    { provide: Clock, useClass: SystemClock },
    OutboxRelayService,
    OutboxCleanupService,
    OutboxAgeGauge,
    OutboxQuarantineGauge,
  ],
  exports: [OutboxRelayService],
})
export class OutboxRelayModule {}
