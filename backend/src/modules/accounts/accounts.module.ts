import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AuditModule } from '@modules/audit';
import { CustomerProfileService } from './customer-profile.service';
import { CustomersController } from './customers.controller';
import { AccountOpeningService } from './account-opening.service';
import { AccountsController } from './accounts.controller';

@Module({
  imports: [AuditModule],
  controllers: [CustomersController, AccountsController],
  providers: [AccountsService, CustomerProfileService, AccountOpeningService],
  exports: [AccountsService],
})
export class AccountsModule {}
