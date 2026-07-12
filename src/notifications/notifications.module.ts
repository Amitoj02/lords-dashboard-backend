import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Member } from '../members/entities/member.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationRead } from './entities/notification-read.entity';
import { Notification } from './entities/notification.entity';

/**
 * "Field Dispatch" announcements with per-member read tracking. Reads the Member
 * repository only to resolve a default author label. AuditService is global (no
 * import needed).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Notification, NotificationRead, Member])],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
