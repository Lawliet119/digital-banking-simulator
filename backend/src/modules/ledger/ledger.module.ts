import { Module } from '@nestjs/common';
import { AccountsModule } from '@modules/accounts';
import { AuditModule } from '@modules/audit';
import { OutboxModule } from '@modules/outbox';
import { DepositService } from './deposit.service';
import { OperatorDepositsController } from './operator-deposits.controller';
import { TransferService } from './transfer.service';
import { TransfersController } from './transfers.controller';

@Module({
  imports: [AccountsModule, AuditModule, OutboxModule],
  providers: [DepositService, TransferService],
  controllers: [OperatorDepositsController, TransfersController],
})
export class LedgerModule {}
