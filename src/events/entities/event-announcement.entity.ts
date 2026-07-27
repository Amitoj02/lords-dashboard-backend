import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { RegimentEvent } from './event.entity';

/**
 * Where an event's Discord announcement actually LANDED (T-0205) — 1—1 with the
 * event (PK = FK), and written by the outbox worker after the post succeeds.
 *
 * ── WHY THIS IS A TABLE AND NOT FOUR COLUMNS ON `events` ────────────────────
 * Every column here is DELIVERY state, not event state: it exists only once a
 * message has really been posted, it is written by the bot rather than by an
 * author, and an event that was created while the bot was off has none of it.
 * A row's PRESENCE is therefore the answer to "has this been announced?", which
 * is a question four nullable columns can only approximate.
 *
 * Each id is load-bearing for a different follow-up:
 *  - `messageId` + `channelId` are what let an RSVP re-render the SAME message
 *    instead of posting a second one, and what the close sweep edits to disable
 *    the buttons. The channel is stored rather than re-read from the bot
 *    settings because an admin can re-point the announcement channel at any
 *    time, and the message does not move when they do.
 *  - `threadId` is the once-only guard on the pre-event ping: the reminder
 *    sweep claims its offset durably, but a thread is a visible, non-idempotent
 *    side effect, so the id is written back here as well.
 *  - `closedAt` stops the close sweep re-editing an already-retired
 *    announcement on every tick for the rest of the event's life.
 */
@Entity('event_announcements')
export class EventAnnouncement {
  @PrimaryColumn({ type: 'char', length: 12 })
  eventId: string;

  @OneToOne(() => RegimentEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event?: RegimentEvent;

  /** The channel the announcement was posted to, as it was AT POST TIME. */
  @Column({ type: 'varchar', length: 20 })
  channelId: string;

  /** The announcement message itself — the anchor for edits and the thread. */
  @Column({ type: 'varchar', length: 20 })
  messageId: string;

  /** The pre-event thread, once opened. Null until the lead-time ping fires. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  threadId: string | null;

  /** When the RSVP buttons were disabled because the event ended. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  closedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
