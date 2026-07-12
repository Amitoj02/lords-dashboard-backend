import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventStatus } from '../common/enums';
import { RegimentEvent } from './entities/event.entity';

/** How often the sweep runs. */
const TICK_INTERVAL_MS = 60_000;

/** An open-ended event (no `endsAt`) is considered over this long after it starts. */
const OPEN_ENDED_DURATION_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Background sweep that advances event lifecycle statuses on the clock, so the
 * calendar reflects reality without anyone touching each event. It runs
 * system-wide (across every regiment, no authenticated caller) on a plain
 * `setInterval` timer that is `unref()`-ed — it never keeps the process alive and
 * never blocks a graceful shutdown. The tick is fully guarded: any failure is
 * logged and swallowed so a bad sweep can never crash the app.
 */
@Injectable()
export class EventStatusScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventStatusScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(RegimentEvent)
    private readonly events: Repository<RegimentEvent>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    // Do not let the timer hold the event loop open (clean shutdown / tests).
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
      const updated = await this.advanceStatuses();
      if (updated > 0) {
        this.logger.log(`Advanced ${updated} event status(es).`);
      }
    } catch (error) {
      this.logger.error(`Event status sweep failed: ${(error as Error).message}`);
    }
  }

  /**
   * Advance statuses for all live (non-draft, non-archived, non-deleted) events:
   *   - upcoming → ongoing  when now ≥ startsAt AND (no endsAt OR now < endsAt).
   *   - upcoming/ongoing → previous  when endsAt is set and now ≥ endsAt, OR the
   *     event is open-ended and now ≥ startsAt + 6h.
   * Returns the number of rows updated. Runs the → ongoing pass first so an event
   * that has already ended skips straight to `previous` in the second pass.
   */
  async advanceStatuses(now: Date = new Date()): Promise<number> {
    const toOngoing = await this.events
      .createQueryBuilder()
      .update(RegimentEvent)
      .set({ status: EventStatus.Ongoing })
      .where('isDraft = :isDraft', { isDraft: false })
      .andWhere('isArchived = :isArchived', { isArchived: false })
      .andWhere('deletedAt IS NULL')
      .andWhere('status = :upcoming', { upcoming: EventStatus.Upcoming })
      .andWhere('startsAt <= :now', { now })
      .andWhere('(endsAt IS NULL OR endsAt > :now)', { now })
      .execute();

    const openEndedCutoff = new Date(now.getTime() - OPEN_ENDED_DURATION_MS);
    const toPrevious = await this.events
      .createQueryBuilder()
      .update(RegimentEvent)
      .set({ status: EventStatus.Previous })
      .where('isDraft = :isDraft', { isDraft: false })
      .andWhere('isArchived = :isArchived', { isArchived: false })
      .andWhere('deletedAt IS NULL')
      .andWhere('status IN (:...active)', {
        active: [EventStatus.Upcoming, EventStatus.Ongoing],
      })
      .andWhere(
        '((endsAt IS NOT NULL AND endsAt <= :now) OR (endsAt IS NULL AND startsAt <= :cutoff))',
        { now, cutoff: openEndedCutoff },
      )
      .execute();

    return (toOngoing.affected ?? 0) + (toPrevious.affected ?? 0);
  }
}
