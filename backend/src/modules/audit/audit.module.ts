import { Module } from '@nestjs/common';
import { RoleDenialAudit } from '@modules/identity';
import { AuditService } from './audit.service';

/**
 * No controller: the audit lookup API (UC-8) is a separate task. No import of `DatabaseModule` —
 * it is `@Global()`, so `TransactionService` (what `AuditService` needs) is already available.
 */
@Module({
  // RoleDenialAudit is the port RolesGuard (identity) writes its 403 DENIED row through; the guard
  // is an APP_GUARD in AppModule, which imports this module, so it resolves it from here.
  providers: [AuditService, { provide: RoleDenialAudit, useExisting: AuditService }],
  exports: [AuditService, RoleDenialAudit],
})
export class AuditModule {}
