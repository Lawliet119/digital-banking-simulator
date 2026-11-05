import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AuditModule } from '@modules/audit';

@Module({
  imports: [AuditModule],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
