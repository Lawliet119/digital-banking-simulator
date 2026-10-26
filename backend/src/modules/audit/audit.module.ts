import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * No controller: the audit lookup API (UC-8) is a separate task. No import of `DatabaseModule` —
 * it is `@Global()`, so `TransactionService` (what `AuditService` needs) is already available.
 */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
