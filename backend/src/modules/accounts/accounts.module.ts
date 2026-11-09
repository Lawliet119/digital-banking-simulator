import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AuditModule } from '@modules/audit';
import { IdentityModule } from '@modules/identity';
import { OutboxModule } from '@modules/outbox';
import { CustomerProfileService } from './customer-profile.service';
import { CustomersController } from './customers.controller';
import { AccountOpeningService } from './account-opening.service';
import { AccountsController } from './accounts.controller';
import { AccountQueryService } from './account-query.service';
import { OperatorAccountSearchService } from './operator-account-search.service';
import { OperatorAccountStatusService } from './operator-account-status.service';
import { OperatorAccountsController } from './operator-accounts.controller';

@Module({
  imports: [AuditModule, IdentityModule, OutboxModule],
  controllers: [CustomersController, AccountsController, OperatorAccountsController],
  providers: [
    AccountsService,
    CustomerProfileService,
    AccountOpeningService,
    AccountQueryService,
    OperatorAccountSearchService,
    OperatorAccountStatusService,
  ],
  exports: [AccountsService],
})
export class AccountsModule {}
