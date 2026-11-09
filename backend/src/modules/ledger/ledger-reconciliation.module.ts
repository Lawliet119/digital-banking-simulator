import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '@common/clock';
import { ReconciliationService } from './reconciliation.service';

/**
 * Worker-side ledger reconciliation scheduler (`DBS-117`, `ADR-13`).
 *
 * Kept separate from `LedgerModule` (which owns HTTP controllers and `AccountsModule`) so a
 * `worker` instance never loads HTTP endpoints, and an `api` instance never loads the
 * reconciliation scheduler.
 */
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }, ReconciliationService],
  exports: [ReconciliationService],
})
export class LedgerReconciliationModule {}
