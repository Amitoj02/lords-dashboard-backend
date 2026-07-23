import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
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

  /**
   * When the reminder scheduler RESOLVED this offset — either by enqueuing the
   * reminder or by deliberately retiring it as stale (T-0174).
   *
   * This column is what makes "fire once, ever" durable. An in-memory set would
   * be emptied by every deploy, and the API is restarted on every release, so a
   * restart shortly after a reminder went out would send it a second time. Null
   * means "not resolved yet"; it is the only value an existing row can have, so
   * every offset already in production is treated as still pending and is
   * governed by the staleness rules in the scheduler.
   */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  sentAt: Date | null;
}
