import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { sqsConfig } from '@config/sqs.config';
import { SqsModule } from '@libs/sqs';
import { OutboxRelayService } from './outbox-relay.service';

/**
 * The relay half of the outbox (docs/03 §10). Kept apart from `OutboxModule`, which every role
 * loads to write events: a producer needs no queue client, and an `api` instance must not own a
 * relay. It is listed in `workerModules`; the relay also checks `runsWorkers()` before it polls.
 */
@Module({
  imports: [ConfigModule.forFeature(sqsConfig), SqsModule],
  providers: [OutboxRelayService],
  exports: [OutboxRelayService],
})
export class OutboxRelayModule {}
