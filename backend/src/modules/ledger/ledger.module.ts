import { Module } from '@nestjs/common';
import { AccountsModule } from '@modules/accounts';
import { AuditModule } from '@modules/audit';
import { OutboxModule } from '@modules/outbox';
import { DepositService } from './deposit.service';
import { OperatorDepositsController } from './operator-deposits.controller';

@Module({
  imports: [AccountsModule, AuditModule, OutboxModule],
  providers: [DepositService],
  controllers: [OperatorDepositsController],
})
export class LedgerModule {}
