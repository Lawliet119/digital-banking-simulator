import { Module } from '@nestjs/common';
import { LoggingModule } from '@common/logging/logging.module';
import { OutboxWriter } from './outbox-writer';

@Module({
  imports: [LoggingModule],
  providers: [OutboxWriter],
  exports: [OutboxWriter],
})
export class OutboxModule {}
