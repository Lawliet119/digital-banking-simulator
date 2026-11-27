import { Module } from '@nestjs/common';
import { NotificationQueryService } from './notification-query.service';
import { NotificationsController } from './notifications.controller';

/** Api-only (`apiModules`): reads `notification_log`. The writer stays in `NotificationModule`. */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationQueryService],
})
export class NotificationHttpModule {}
