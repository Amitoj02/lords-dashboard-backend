import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { EventNotifyOffset } from './entities/event-notify-offset.entity';

/** How often the reminder sweep runs. One minute is the offsets' own resolution. */
const TICK_INTERVAL_MS = 60_000;

/** Upper bound on offsets considered per sweep (keeps a tick cheap and bounded). */
const BATCH_SIZE = 50;

/**
 * Fires the lead-time reminders recorded in `event_notify_offsets` (T-0174).
 *
 * Those rows have existed since the events feature shipped — written by the
 * authoring path and cloned onto every generated recurrence occurrence — but
 * NOTHING ever read them: the only `enqueueEventAnnounce` call site in the repo
 * was the create path, so "remind me 60 minutes before" was persisted and then
 * silently ignored. This sweep is the missing consumer.
 *
 * Shaped exactly like {@link EventStatusScheduler} / {@link EventRecurrenceScheduler}:
 * a plain `setInterval` that is `unref()`-ed so it never holds the process open,
 * a fully guarded tick that logs and swallows every failure, and a bounded batch.
 *
 * ── ONCE-ONLY, DURABLY ──────────────────────────────────────────────────────
 * A reminder is a non-idempotent side effect, and the API restarts on every
 * deploy, so an in-memory "already fired" set would forget its contents exactly
 * when it matters. The record lives in the database instead:
 * `event_notify_offsets.sent_at`, claimed with a conditional UPDATE
 * (`... WHERE sent_at IS NULL`) that only one sweep — in one process, on one
 * instance — can win. The claim happens BEFORE the enqueue: at-most-once is the
 * right bias for an announcement, matching the worker's own refusal to re-run a
 * non-idempotent job after an orphaned restart.
 *
 * ── MISSED OFFSETS ──────────────────────────────────────────────────────────
 * If the process was down past an offset's fire time, that offset is still due
 * when it comes back. Two rules stop a burst of stale reminders:
 *
 *   1. An offset whose event has ALREADY STARTED is retired without sending.
 *      "Starts in 15 minutes" posted an hour after the muster began is noise at
 *      best and misdirection at worst.
 *   2. When several offsets of the SAME event come due in one sweep, only the
 *      one CLOSEST to the start (the smallest `minutes`) is sent; the rest are
 *      retired. A 26-hour outage would otherwise fire the 1440-, 60- and
 *      15-minute reminders for one event back to back, and only the last of
 *      them is true.
 *
 * Retired offsets are stamped with the same `sent_at`, so they are resolved for
 * good rather than re-evaluated on the next tick.
 *
 * ── WHAT A REMINDER ACTUALLY IS NOW (T-0205) ────────────────────────────────
 * This sweep still decides WHEN; it no longer decides WHAT. When the event has a
 * live announcement, the enqueue turns into a thread opened on that message,
 * pinging only the members who said they were coming — which is how the app
 * reaches attendees without DM'ing them, something Discord's policy treats as
 * abuse at any useful scale. The announcement's own ping role is NOT re-pinged;
 * it fired once, at creation, and this is not creation.
 */
@Injectable()
export class EventReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventReminderScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(EventNotifyOffset)
    private readonly offsets: Repository<EventNotifyOffset>,
    private readonly discordSync: DiscordSyncService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One guarded sweep. Never throws. */
  private async tick(): Promise<void> {
    try {
      const sent = await this.sweep();
      if (sent > 0) this.logger.log(`Enqueued ${sent} event reminder(s).`);
    } catch (error) {
      this.logger.error(`Event reminder sweep failed: ${(error as Error).message}`);
    }
  }

  /**
   * Resolve every due offset. Returns how many reminders were actually enqueued
   * (retired-as-stale offsets are resolved but not counted).
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const due = await this.findDueOffsets(now);
    if (due.length === 0) return 0;

    // Group by event so rule 2 (only the nearest reminder survives) can be
    // applied per event rather than per row.
    const byEvent = new Map<string, EventNotifyOffset[]>();
    for (const offset of due) {
      const bucket = byEvent.get(offset.eventId);
      if (bucket) bucket.push(offset);
      else byEvent.set(offset.eventId, [offset]);
    }

    let enqueued = 0;
    for (const [eventId, offsetsForEvent] of byEvent) {
      const event = offsetsForEvent[0].event;
      if (!event) continue;
      // Ordered by minutes ASC, so the head is the one closest to the start.
      const [nearest, ...superseded] = offsetsForEvent;
      const started = event.startsAt.getTime() <= now.getTime();

      for (const stale of superseded) {
        if (await this.claim(stale, now)) {
          this.logger.warn(
            `Retiring stale ${stale.minutes}m reminder for event ${eventId}: a nearer offset is also due`,
          );
        }
      }

      if (!(await this.claim(nearest, now))) continue;
      if (started) {
        this.logger.warn(
          `Retiring missed ${nearest.minutes}m reminder for event ${eventId}: it already started`,
        );
        continue;
      }
      await this.discordSync.enqueueEventReminder(event.regimentId, eventId, nearest.minutes);
      enqueued++;
    }
    return enqueued;
  }

  /**
   * Unresolved offsets whose fire time has passed, on live events only.
   *
   * The fire time is computed IN SQL (`starts_at - INTERVAL minutes MINUTE`)
   * rather than by loading every offset and filtering in JS: the offsets table
   * grows with every recurrence occurrence generated for the next 60 days, and a
   * sweep must stay a bounded index-assisted read.
   */
  private findDueOffsets(now: Date): Promise<EventNotifyOffset[]> {
    return (
      this.offsets
        .createQueryBuilder('offset')
        .innerJoinAndSelect('offset.event', 'event')
        .where('offset.sentAt IS NULL')
        .andWhere('event.deletedAt IS NULL')
        .andWhere('event.isDraft = :draft', { draft: false })
        .andWhere('event.isArchived = :archived', { archived: false })
        // A template is a recurrence RULE, not a real muster; its occurrences are
        // materialised as their own rows and carry their own offsets.
        .andWhere('NOT (event.isRecurring = :recurring AND event.recurrenceTemplateId IS NULL)', {
          recurring: true,
        })
        .andWhere('DATE_SUB(event.startsAt, INTERVAL offset.minutes MINUTE) <= :now', { now })
        .orderBy('event.startsAt', 'ASC')
        .addOrderBy('offset.minutes', 'ASC')
        .limit(BATCH_SIZE)
        .getMany()
    );
  }

  /**
   * Atomically take ownership of an offset. Returns false when another sweep (or
   * another instance) already resolved it — the caller must then send nothing.
   */
  private async claim(offset: EventNotifyOffset, now: Date): Promise<boolean> {
    const result = await this.offsets.update(
      { eventId: offset.eventId, minutes: offset.minutes, sentAt: IsNull() },
      { sentAt: now },
    );
    return (result.affected ?? 0) === 1;
  }
}
