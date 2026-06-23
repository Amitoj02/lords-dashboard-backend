import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { RegimentEvent } from './event.entity';

/** Junction: free-form tags on an event. */
@Entity('event_tags')
export class EventTag {
  @PrimaryColumn({ type: 'char', length: 36 })
  eventId: string;

  @ManyToOne(() => RegimentEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: RegimentEvent;

  @PrimaryColumn({ length: 40 })
  tag: string;
}
