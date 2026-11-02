import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AuditModule } from '@modules/audit';
import { CustomerProfileService } from './customer-profile.service';
import { CustomersController } from './customers.controller';

@Module({
  imports: [AuditModule],
  controllers: [CustomersController],
  providers: [AccountsService, CustomerProfileService],
  exports: [AccountsService],
})
export class AccountsModule {}
