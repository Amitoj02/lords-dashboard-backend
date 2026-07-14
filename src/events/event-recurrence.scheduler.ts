import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DateTime, DurationLikeObject } from 'luxon';
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

/** Upper bound on occurrences emitted per template per sweep (a safety cap). */
const MAX_EMIT = 500;

/** The Nth occurrence's start, anchored to the template's original start. */
function occurrenceAt(
  anchor: DateTime<boolean>,
  cadence: RecurrenceCadence,
  n: number,
): DateTime<boolean> {
  switch (cadence) {
    case RecurrenceCadence.Daily:
      return anchor.plus({ days: n });
    case RecurrenceCadence.Weekly:
      return anchor.plus({ weeks: n });
    case RecurrenceCadence.Monthly:
      return anchor.plus({ months: n });
  }
}

/** A coarse arithmetic estimate of the occurrence index at/near `now` (corrected below). */
function estimateIndex(anchor: DateTime<boolean>, now: Date, cadence: RecurrenceCadence): number {
  const deltaMs = now.getTime() - anchor.toMillis();
  switch (cadence) {
    case RecurrenceCadence.Daily:
      return Math.floor(deltaMs / 86_400_000);
    case RecurrenceCadence.Weekly:
      return Math.floor(deltaMs / (7 * 86_400_000));
    case RecurrenceCadence.Monthly: {
      const nowDt = DateTime.fromJSDate(now, { zone: anchor.zoneName ?? 'UTC' });
      return (nowDt.year - anchor.year) * 12 + (nowDt.month - anchor.month);
    }
  }
}

/**
 * Compute the occurrence start instants to materialize for a recurring template,
 * DST-accurately. Each occurrence N is anchored to the template's ORIGINAL start
 * (`anchorStart`) as `anchor.plus({unit: N})` in `timezone` — NOT stepped from the
 * previous instant — so:
 *   - monthly keeps the original day-of-month (no permanent clamp to the 28th),
 *   - a one-off DST gap/overlap never compounds into later occurrences,
 *   - the local wall-clock time is preserved across DST transitions.
 * We arithmetically fast-forward to the first occurrence strictly after `now`
 * (so a far-past template never exhausts a step budget in the past), then emit up
 * to the horizon, skipping any start already present in `existingStartMs`
 * (idempotent). Pure + deterministic. Invalid IANA zones fall back to UTC.
 */
export function computeOccurrenceStarts(params: {
  anchorStart: Date;
  cadence: RecurrenceCadence;
  timezone: string;
  now: Date;
  horizonEnd: Date;
  existingStartMs?: ReadonlySet<number>;
}): Date[] {
  const { anchorStart, cadence, timezone, now, horizonEnd, existingStartMs } = params;
  const zone = DateTime.now().setZone(timezone).isValid ? timezone : 'UTC';

  let anchor: DateTime<boolean> = DateTime.fromJSDate(anchorStart, { zone });
  if (!anchor.isValid) anchor = DateTime.fromJSDate(anchorStart, { zone: 'UTC' });

  const nowMs = now.getTime();
  const horizonMs = horizonEnd.getTime();

  // Fast-forward arithmetically, then correct to the FIRST occurrence strictly
  // after now. The correction loops are tightly bounded — they absorb only the
  // off-by-one from DST / the coarse estimate, never a walk through the past.
  let n = Math.max(1, estimateIndex(anchor, now, cadence));
  let guard = 0;
  while (occurrenceAt(anchor, cadence, n).toMillis() <= nowMs && guard++ < 32) n++;
  while (n > 1 && occurrenceAt(anchor, cadence, n - 1).toMillis() > nowMs && guard++ < 64) n--;

  const out: Date[] = [];
  for (let emitted = 0; emitted < MAX_EMIT; n++, emitted++) {
    const dt = occurrenceAt(anchor, cadence, n);
    const ms = dt.toMillis();
    if (ms > horizonMs) break;
    if (existingStartMs?.has(ms)) continue; // idempotent: never double-create
    out.push(dt.toJSDate());
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
 * Idempotency: occurrences are anchored to the template's original start and
 * deduped against every existing occurrence (including soft-deleted ones), and a
 * UNIQUE(recurrence_template_id, starts_at) index backstops concurrent sweeps, so
 * rows are never re-created. Timezone accuracy: occurrence N is computed as
 * anchor.plus({unit: N}) in the template's IANA zone via Luxon, keeping the local
 * start time fixed across DST boundaries without compounding drift.
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
    // Include soft-deleted occurrences (withDeleted) so a manually-cancelled
    // occurrence is NOT resurrected on the next sweep — its startsAt still blocks
    // regeneration. Occurrences are anchored to the template's original start.
    const existing = await this.events.find({
      where: { recurrenceTemplateId: template.id },
      select: { id: true, startsAt: true },
      withDeleted: true,
    });
    const existingStartMs = new Set<number>(existing.map((e) => e.startsAt.getTime()));

    const starts = computeOccurrenceStarts({
      anchorStart: template.startsAt,
      cadence: template.recurrenceCadence!,
      timezone: template.timezone,
      now,
      horizonEnd,
      existingStartMs,
    });
    if (starts.length === 0) return 0;

    // Duration is preserved in the template's wall-clock (open-ended stays open),
    // and the child collections are cloned onto every occurrence.
    const durationUnits = this.templateDurationUnits(template);
    const [platforms, tags, notifyOffsets] = await this.loadTemplateChildren(template.id);

    // Insert each occurrence in its own transaction so a unique-constraint
    // collision (a concurrent sweep / second app instance) skips just that one,
    // never the whole batch.
    let created = 0;
    for (const startsAt of starts) {
      const made = await this.tryCreateOccurrence(template, startsAt, durationUnits, {
        platforms,
        tags,
        notifyOffsets,
      });
      if (made) created++;
    }
    return created;
  }

  /**
   * The template's duration as calendar units in its own zone, so an occurrence's
   * end preserves the wall-clock end time across DST (not a fixed ms delta). Null
   * for open-ended templates.
   */
  private templateDurationUnits(template: RegimentEvent): DurationLikeObject | null {
    if (template.endsAt === null) return null;
    const zone = DateTime.now().setZone(template.timezone).isValid ? template.timezone : 'UTC';
    const start = DateTime.fromJSDate(template.startsAt, { zone });
    const end = DateTime.fromJSDate(template.endsAt, { zone });
    return end.diff(start, ['days', 'hours', 'minutes', 'seconds']).toObject();
  }

  /** Create one occurrence in its own transaction; a duplicate-key collision is a no-op. */
  private async tryCreateOccurrence(
    template: RegimentEvent,
    startsAt: Date,
    durationUnits: DurationLikeObject | null,
    children: { platforms: EventPlatform['platform'][]; tags: string[]; notifyOffsets: number[] },
  ): Promise<boolean> {
    try {
      await this.dataSource.transaction((manager) =>
        this.createOccurrence(manager, template, startsAt, durationUnits, children),
      );
      return true;
    } catch (error) {
      if (this.isDuplicateKey(error)) return false; // a concurrent sweep won the race
      throw error;
    }
  }

  /** True when the error is a MySQL duplicate-key (ER_DUP_ENTRY / errno 1062). */
  private isDuplicateKey(error: unknown): boolean {
    const e = error as { code?: string; errno?: number; driverError?: { errno?: number } };
    return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062 || e?.driverError?.errno === 1062;
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
    durationUnits: DurationLikeObject | null,
    children: { platforms: EventPlatform['platform'][]; tags: string[]; notifyOffsets: number[] },
  ): Promise<void> {
    const zone = DateTime.now().setZone(template.timezone).isValid ? template.timezone : 'UTC';
    const eventRepo = manager.getRepository(RegimentEvent);
    const occurrence = eventRepo.create({
      regimentId: template.regimentId,
      createdByMemberId: template.createdByMemberId,
      title: template.title,
      description: template.description,
      bannerUrl: template.bannerUrl,
      startsAt,
      // Preserve the wall-clock end time (DST-correct), not a fixed ms delta.
      endsAt: durationUnits
        ? DateTime.fromJSDate(startsAt, { zone }).plus(durationUnits).toJSDate()
        : null,
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
