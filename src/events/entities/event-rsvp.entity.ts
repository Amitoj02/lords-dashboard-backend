import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RsvpStatus } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { RegimentEvent } from './event.entity';

/** A member's RSVP to an event (backs rsvp_counts + the password-reveal gate). */
@Entity('event_rsvps')
@Index(['eventId', 'memberId'], { unique: true })
export class EventRsvp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 36 })
  eventId: string;

  @ManyToOne(() => RegimentEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: RegimentEvent;

  @Index()
  @Column({ type: 'char', length: 36 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  @Column({ type: 'enum', enum: RsvpStatus })
  status: RsvpStatus;

  @Column({ type: 'int', nullable: true })
  reminderOffsetMinutes: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  respondedAt: Date | null;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
