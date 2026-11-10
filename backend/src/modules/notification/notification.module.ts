import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { sqsConfig } from '@config/sqs.config';
import { SqsModule } from '@libs/sqs';
import { AuditModule } from '@modules/audit';
import { NotificationConsumer } from './notification.consumer';

/** Worker-only (`workerModules`): the consumer also checks `runsWorkers()` before it polls. */
@Module({
  imports: [ConfigModule.forFeature(sqsConfig), SqsModule, AuditModule],
  providers: [NotificationConsumer],
  exports: [NotificationConsumer],
})
export class NotificationModule {}
