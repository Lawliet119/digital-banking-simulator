import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '@common/clock';
import { AccountsModule } from '@modules/accounts';
import { AuditModule } from '@modules/audit';
import { OutboxModule } from '@modules/outbox';
import { DepositService } from './deposit.service';
import { LedgerPostingService } from './ledger-posting.service';
import { OperatorDepositsController } from './operator-deposits.controller';
import { SyncGuardService } from './sync-guard.service';
import { TransferService } from './transfer.service';
import { TransfersController } from './transfers.controller';

@Module({
  imports: [AccountsModule, AuditModule, OutboxModule],
  providers: [
    { provide: Clock, useClass: SystemClock },
    LedgerPostingService,
    DepositService,
    SyncGuardService,
    TransferService,
  ],
  controllers: [OperatorDepositsController, TransfersController],
})
export class LedgerModule {}
