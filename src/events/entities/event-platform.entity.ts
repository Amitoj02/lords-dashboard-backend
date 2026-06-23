import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Platform } from '../../common/enums';
import { RegimentEvent } from './event.entity';

/** Junction: platforms an event runs on. */
@Entity('event_platforms')
export class EventPlatform {
  @PrimaryColumn({ type: 'char', length: 36 })
  eventId: string;

  @ManyToOne(() => RegimentEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: RegimentEvent;

  @PrimaryColumn({ type: 'enum', enum: Platform })
  platform: Platform;
}
