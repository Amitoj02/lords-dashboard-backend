import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { RegimentEvent } from './event.entity';

/** Junction: notification lead times for an event, normalized to minutes. */
@Entity('event_notify_offsets')
export class EventNotifyOffset {
  @PrimaryColumn({ type: 'char', length: 12 })
  eventId: string;

  @ManyToOne(() => RegimentEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: RegimentEvent;

  @PrimaryColumn({ type: 'int' })
  minutes: number;
}
