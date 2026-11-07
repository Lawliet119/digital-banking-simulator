import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditSearchService } from './audit-search.service';
import { AuditModule } from './audit.module';

/** HTTP lookup is separate so workers can write audit without query/identity providers. */
@Module({
  imports: [AuditModule],
  controllers: [AuditController],
  providers: [AuditSearchService],
})
export class AuditHttpModule {}
