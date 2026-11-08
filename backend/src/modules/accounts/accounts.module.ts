import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AuditModule } from '@modules/audit';
import { CustomerProfileService } from './customer-profile.service';
import { CustomersController } from './customers.controller';
import { AccountOpeningService } from './account-opening.service';
import { AccountsController } from './accounts.controller';
import { AccountQueryService } from './account-query.service';
import { OperatorAccountSearchService } from './operator-account-search.service';
import { OperatorAccountsController } from './operator-accounts.controller';

@Module({
  imports: [AuditModule],
  controllers: [CustomersController, AccountsController, OperatorAccountsController],
  providers: [
    AccountsService,
    CustomerProfileService,
    AccountOpeningService,
    AccountQueryService,
    OperatorAccountSearchService,
  ],
  exports: [AccountsService],
})
export class AccountsModule {}
