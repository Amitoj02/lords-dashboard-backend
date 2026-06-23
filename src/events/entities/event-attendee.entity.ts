import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Member } from '../../members/entities/member.entity';
import { RegimentEvent } from './event.entity';

/** Junction: confirmed attendance (distinct from RSVP intent). */
@Entity('event_attendees')
export class EventAttendee {
  @PrimaryColumn({ type: 'char', length: 36 })
  eventId: string;

  @ManyToOne(() => RegimentEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: RegimentEvent;

  @Index()
  @PrimaryColumn({ type: 'char', length: 36 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  checkedInAt: Date | null;
}
