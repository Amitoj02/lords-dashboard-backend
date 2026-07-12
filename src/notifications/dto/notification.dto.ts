import { ApiProperty } from '@nestjs/swagger';
import { NotificationTone } from '../../common/enums';
import { Notification } from '../entities/notification.entity';

/**
 * Client-facing projection of a "Field Dispatch" announcement. `read` is
 * computed per-caller (from the notification_reads junction) — the raw entity
 * has no read state of its own.
 */
export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Operation Thunderclap briefing' })
  title: string;

  @ApiProperty({ description: 'Announcement body (free text)' })
  body: string;

  @ApiProperty({ enum: NotificationTone })
  tone: NotificationTone;

  @ApiProperty({ nullable: true, example: 'Command' })
  authorLabel: string | null;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z', description: 'ISO created timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'True when the calling member has read this notification' })
  read: boolean;

  /** Map a Notification entity to its client projection with per-caller read state. */
  static from(notification: Notification, read: boolean): NotificationDto {
    return {
      id: notification.id,
      title: notification.title,
      body: notification.body,
      tone: notification.tone,
      authorLabel: notification.authorLabel,
      createdAt: notification.createdAt.toISOString(),
      read,
    };
  }
}
