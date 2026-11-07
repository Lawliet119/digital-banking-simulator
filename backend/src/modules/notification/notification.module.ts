import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { sqsConfig } from '@config/sqs.config';
import { SqsModule } from '@libs/sqs';
import { NotificationConsumer } from './notification.consumer';

/** Worker-only (`workerModules`): the consumer also checks `runsWorkers()` before it polls. */
@Module({
  imports: [ConfigModule.forFeature(sqsConfig), SqsModule],
  providers: [NotificationConsumer],
  exports: [NotificationConsumer],
})
export class NotificationModule {}
