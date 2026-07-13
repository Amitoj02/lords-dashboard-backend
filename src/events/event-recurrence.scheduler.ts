import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DateTime } from 'luxon';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { EventStatus, RecurrenceCadence } from '../common/enums';
import { EventNotifyOffset } from './entities/event-notify-offset.entity';
import { EventPlatform } from './entities/event-platform.entity';
import { EventTag } from './entities/event-tag.entity';
import { RegimentEvent } from './entities/event.entity';

/** How often the generation sweep runs. */
const TICK_INTERVAL_MS = 5 * 60_000; // 5 min

/** How far ahead occurrences are materialized. */
const HORIZON_DAYS = 60;

/**
 * Safety cap on how many cadence steps we walk per template in a single sweep —
 * a backstop against a pathological far-past template. In normal operation we
 * seed from the latest existing occurrence, so only a handful of steps are ever
 * taken to reach the horizon.
 */
const MAX_STEPS = 1000;

/** Add exactly one cadence step, preserving wall-clock time in the given zone. */
function advance(cursor: DateTime<boolean>, cadence: RecurrenceCadence): DateTime<boolean> {
  switch (cadence) {
    case RecurrenceCadence.Daily:
      return cursor.plus({ days: 1 });
    case RecurrenceCadence.Weekly:
      return cursor.plus({ weeks: 1 });
    case RecurrenceCadence.Monthly:
      return cursor.plus({ months: 1 });
  }
}

/**
 * Compute the occurrence start instants to materialize for a recurring template,
 * DST-accurately. `seedStart` is the instant the last-known occurrence (or the
 * template itself) starts; we step from there in `timezone`, keeping the local
 * wall-clock time constant across DST transitions (this is why we use Luxon in
 * the zone rather than adding fixed millisecond deltas). We emit every step that
 * is strictly after `now`, at or before `horizonEnd`, and not already present in
 * `existingStartMs`. Pure + deterministic for unit testing. Invalid IANA zones
 * fall back to UTC (never throw — this runs headless on a timer).
 */
export function computeOccurrenceStarts(params: {
  seedStart: Date;
  cadence: RecurrenceCadence;
  timezone: string;
  now: Date;
  horizonEnd: Date;
  existingStartMs?: ReadonlySet<number>;
}): Date[] {
  const { seedStart, cadence, timezone, now, horizonEnd, existingStartMs } = params;
  const zone = DateTime.now().setZone(timezone).isValid ? timezone : 'UTC';

  let cursor: DateTime<boolean> = DateTime.fromJSDate(seedStart, { zone });
  if (!cursor.isValid) cursor = DateTime.fromJSDate(seedStart, { zone: 'UTC' });

  const out: Date[] = [];
  const horizonMs = horizonEnd.getTime();
  const nowMs = now.getTime();

  for (let steps = 0; steps < MAX_STEPS; steps++) {
    cursor = advance(cursor, cadence);
    const ms = cursor.toMillis();
    if (ms > horizonMs) break;
    if (ms <= nowMs) continue; // already in the past — skip but keep walking
    if (existingStartMs?.has(ms)) continue; // idempotent: never double-create
    out.push(cursor.toJSDate());
  }
  return out;
}

/**
 * Background sweep that materializes future occurrences of active recurring
 * event templates (T-0075) as real event rows, so each occurrence has its own
 * RSVP/attendance. Mirrors {@link EventStatusScheduler}: a plain `unref()`-ed
 * `setInterval` that never keeps the process alive, and a fully guarded tick —
 * any failure is logged and swallowed so a bad sweep can never crash the API.
 *
 * Idempotency: each template is seeded from its latest existing occurrence (or
 * itself), so repeated ticks never re-create rows. Timezone accuracy: stepping
 * is done in the template's IANA zone via Luxon, keeping the local start time
 * fixed across DST boundaries.
 */
@Injectable()
export class EventRecurrenceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventRecurrenceScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(RegimentEvent)
    private readonly events: Repository<RegimentEvent>,
    private readonly dataSource: DataSource,
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
      const created = await this.generate();
      if (created > 0) {
        this.logger.log(`Materialized ${created} recurring event occurrence(s).`);
      }
    } catch (error) {
      this.logger.error(`Recurrence sweep failed: ${(error as Error).message}`);
    }
  }

  /**
   * Materialize any missing occurrences for every active template within the
   * horizon. Returns the number of occurrence rows created.
   */
  async generate(now: Date = new Date()): Promise<number> {
    const horizonEnd = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);

    const templates = await this.events.find({
      where: {
        isRecurring: true,
        recurrenceActive: true,
        recurrenceTemplateId: IsNull(),
        isArchived: false,
      },
    });

    let created = 0;
    for (const template of templates) {
      if (!template.recurrenceCadence) continue;
      created += await this.generateForTemplate(template, now, horizonEnd);
    }
    return created;
  }

  /** Materialize the missing occurrences of one template. */
  private async generateForTemplate(
    template: RegimentEvent,
    now: Date,
    horizonEnd: Date,
  ): Promise<number> {
    // Existing occurrences of this template (plus the template itself) — used
    // both to seed the walk from the latest start and to dedupe candidates.
    const existing = await this.events.find({
      where: { recurrenceTemplateId: template.id },
      select: { id: true, startsAt: true },
    });
    const existingStartMs = new Set<number>(existing.map((e) => e.startsAt.getTime()));
    const latestStart = existing.reduce<Date>(
      (max, e) => (e.startsAt.getTime() > max.getTime() ? e.startsAt : max),
      template.startsAt,
    );

    const starts = computeOccurrenceStarts({
      seedStart: latestStart,
      cadence: template.recurrenceCadence!,
      timezone: template.timezone,
      now,
      horizonEnd,
      existingStartMs,
    });
    if (starts.length === 0) return 0;

    // Duration is preserved as a fixed delta from the template (open-ended stays
    // open-ended). The child collections are cloned onto every occurrence.
    const durationMs =
      template.endsAt !== null ? template.endsAt.getTime() - template.startsAt.getTime() : null;
    const [platforms, tags, notifyOffsets] = await this.loadTemplateChildren(template.id);

    await this.dataSource.transaction(async (manager) => {
      for (const startsAt of starts) {
        await this.createOccurrence(manager, template, startsAt, durationMs, {
          platforms,
          tags,
          notifyOffsets,
        });
      }
    });

    return starts.length;
  }

  /** The template's platform/tag/notify-offset child rows, as plain value arrays. */
  private async loadTemplateChildren(
    templateId: string,
  ): Promise<[EventPlatform['platform'][], string[], number[]]> {
    const [platforms, tags, offsets] = await Promise.all([
      this.dataSource.getRepository(EventPlatform).find({ where: { eventId: templateId } }),
      this.dataSource.getRepository(EventTag).find({ where: { eventId: templateId } }),
      this.dataSource.getRepository(EventNotifyOffset).find({ where: { eventId: templateId } }),
    ]);
    return [
      platforms.map((p) => p.platform),
      tags.map((t) => t.tag),
      offsets.map((o) => o.minutes),
    ];
  }

  /** Insert one occurrence row + its cloned child collections. */
  private async createOccurrence(
    manager: EntityManager,
    template: RegimentEvent,
    startsAt: Date,
    durationMs: number | null,
    children: { platforms: EventPlatform['platform'][]; tags: string[]; notifyOffsets: number[] },
  ): Promise<void> {
    const eventRepo = manager.getRepository(RegimentEvent);
    const occurrence = eventRepo.create({
      regimentId: template.regimentId,
      createdByMemberId: template.createdByMemberId,
      title: template.title,
      description: template.description,
      bannerUrl: template.bannerUrl,
      startsAt,
      endsAt: durationMs !== null ? new Date(startsAt.getTime() + durationMs) : null,
      timezone: template.timezone,
      // An occurrence is a concrete instance, never itself a template.
      isRecurring: false,
      recurrenceRule: null,
      recurrenceCadence: null,
      recurrenceActive: false,
      recurrenceTemplateId: template.id,
      serverName: template.serverName,
      // Reading the transformer-backed column yields plaintext; saving re-encrypts.
      serverPassword: template.serverPassword,
      serverRegion: template.serverRegion,
      status: EventStatus.Upcoming,
      expectedAttendance: template.expectedAttendance,
      attendanceGoal: template.attendanceGoal,
      twitchUrl: template.twitchUrl,
      isDraft: false,
      isArchived: false,
    });
    const saved = await eventRepo.save(occurrence);

    if (children.platforms.length > 0) {
      await manager
        .getRepository(EventPlatform)
        .insert(children.platforms.map((platform) => ({ eventId: saved.id, platform })));
    }
    if (children.tags.length > 0) {
      await manager
        .getRepository(EventTag)
        .insert(children.tags.map((tag) => ({ eventId: saved.id, tag })));
    }
    if (children.notifyOffsets.length > 0) {
      await manager
        .getRepository(EventNotifyOffset)
        .insert(children.notifyOffsets.map((minutes) => ({ eventId: saved.id, minutes })));
    }
  }
}
