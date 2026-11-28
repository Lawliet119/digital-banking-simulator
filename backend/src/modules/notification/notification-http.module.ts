import { Module } from '@nestjs/common';
import { AccountsModule } from '@modules/accounts';
import { LedgerReadModule } from '@modules/ledger';
import { NotificationQueryService } from './notification-query.service';
import { NotificationsController } from './notifications.controller';

/**
 * Api-only (`apiModules`): reads `notification_log` and marks notices read. The writer of notices
 * stays in `NotificationModule`.
 */
@Module({
  imports: [AccountsModule, LedgerReadModule],
  controllers: [NotificationsController],
  providers: [NotificationQueryService],
})
export class NotificationHttpModule {}
