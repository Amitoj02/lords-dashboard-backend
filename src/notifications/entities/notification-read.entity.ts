import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Member } from '../../members/entities/member.entity';
import { Notification } from './notification.entity';

/** Junction: per-member read state for notifications. */
@Entity('notification_reads')
export class NotificationRead {
  @PrimaryColumn({ type: 'char', length: 36 })
  notificationId: string;

  @ManyToOne(() => Notification, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification?: Notification;

  @Index()
  @PrimaryColumn({ type: 'char', length: 36 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  @Column({ type: 'datetime', precision: 6 })
  readAt: Date;
}
