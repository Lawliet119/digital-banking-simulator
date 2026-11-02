import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { sqsConfig } from '@config/sqs.config';
import { SqsClient } from './sqs.client';

@Module({
  imports: [ConfigModule.forFeature(sqsConfig)],
  providers: [SqsClient],
  exports: [SqsClient],
})
export class SqsModule {}
