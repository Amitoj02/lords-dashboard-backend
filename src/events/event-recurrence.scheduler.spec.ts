import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DateTime } from 'luxon';
import { DataSource } from 'typeorm';
import { RecurrenceCadence } from '../common/enums';
import { RegimentEvent } from './entities/event.entity';
import { computeOccurrenceStarts, EventRecurrenceScheduler } from './event-recurrence.scheduler';

/** The local wall-clock hour of a UTC instant, viewed in the given IANA zone. */
const localHour = (d: Date, zone: string): number => DateTime.fromJSDate(d, { zone }).hour;

describe('computeOccurrenceStarts (DST correctness)', () => {
  it('keeps 20:00 local across the US spring-forward for a weekly America/New_York template', () => {
    const zone = 'America/New_York';
    // A Saturday at 20:00 local, before the 2025-03-09 spring-forward.
    const seedStart = DateTime.fromObject(
      { year: 2025, month: 3, day: 1, hour: 20 },
      { zone },
    ).toJSDate();
    const now = DateTime.fromObject(
      { year: 2025, month: 3, day: 1, hour: 21 },
      { zone },
    ).toJSDate();
    const horizonEnd = DateTime.fromObject({ year: 2025, month: 4, day: 15 }, { zone }).toJSDate();

    const starts = computeOccurrenceStarts({
      seedStart,
      cadence: RecurrenceCadence.Weekly,
      timezone: zone,
      now,
      horizonEnd,
    });

    expect(starts.length).toBeGreaterThanOrEqual(5);
    // Every materialized occurrence lands at 20:00 local, NOT drifting to 19:00
    // or 21:00 when the offset changes (EST -5 → EDT -4 on 2025-03-09).
    for (const s of starts) {
      expect(localHour(s, zone)).toBe(20);
    }
    // Prove the UTC instant actually shifted across the boundary: an occurrence
    // before DST is at 01:00 UTC, one after is at 00:00 UTC (same 20:00 local).
    const beforeDst = starts.find((s) => s < new Date('2025-03-09T07:00:00Z'));
    const afterDst = starts.find((s) => s > new Date('2025-03-09T07:00:00Z'));
    expect(beforeDst?.getUTCHours()).toBe(1);
    expect(afterDst?.getUTCHours()).toBe(0);
  });

  it('keeps the local day-of-month + time for a monthly Europe/London template across GMT→BST', () => {
    const zone = 'Europe/London';
    // 15th at 19:00 local in February (GMT), stepping into BST (starts 2025-03-30).
    const seedStart = DateTime.fromObject(
      { year: 2025, month: 2, day: 15, hour: 19 },
      { zone },
    ).toJSDate();
    const now = DateTime.fromObject({ year: 2025, month: 2, day: 16 }, { zone }).toJSDate();
    const horizonEnd = DateTime.fromObject({ year: 2025, month: 6, day: 1 }, { zone }).toJSDate();

    const starts = computeOccurrenceStarts({
      seedStart,
      cadence: RecurrenceCadence.Monthly,
      timezone: zone,
      now,
      horizonEnd,
    });

    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const s of starts) {
      const dt = DateTime.fromJSDate(s, { zone });
      expect(dt.day).toBe(15);
      expect(dt.hour).toBe(19);
    }
  });

  it('is idempotent: never re-emits a start already present', () => {
    const zone = 'UTC';
    const seedStart = new Date('2026-01-01T12:00:00Z');
    const now = new Date('2026-01-01T13:00:00Z');
    const horizonEnd = new Date('2026-01-10T12:00:00Z');

    const first = computeOccurrenceStarts({
      seedStart,
      cadence: RecurrenceCadence.Daily,
      timezone: zone,
      now,
      horizonEnd,
    });
    expect(first.length).toBeGreaterThan(0);

    // Feeding the produced starts back as "existing" yields nothing new.
    const existingStartMs = new Set(first.map((d) => d.getTime()));
    const second = computeOccurrenceStarts({
      seedStart,
      cadence: RecurrenceCadence.Daily,
      timezone: zone,
      now,
      horizonEnd,
      existingStartMs,
    });
    expect(second).toHaveLength(0);
  });

  it('emits nothing past the horizon', () => {
    const starts = computeOccurrenceStarts({
      seedStart: new Date('2026-01-01T00:00:00Z'),
      cadence: RecurrenceCadence.Weekly,
      timezone: 'UTC',
      now: new Date('2026-01-01T00:00:00Z'),
      horizonEnd: new Date('2026-01-05T00:00:00Z'), // < 1 week ahead
    });
    expect(starts).toHaveLength(0);
  });
});

describe('EventRecurrenceScheduler.generate', () => {
  let scheduler: EventRecurrenceScheduler;

  const events = { find: jest.fn() };
  const eventTxRepo = {
    create: jest.fn((d: Partial<RegimentEvent>) => ({
      id: `occ-${Math.round(d.startsAt!.getTime())}`,
      ...d,
    })),
    save: jest.fn((e: RegimentEvent) => Promise.resolve(e)),
    insert: jest.fn().mockResolvedValue({}),
  };
  const childRepo = {
    find: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue({}),
  };
  const dataSource = {
    getRepository: jest.fn(() => childRepo),
    transaction: jest.fn(),
  };

  const template = (overrides: Partial<RegimentEvent> = {}): RegimentEvent =>
    ({
      id: 'tmpl-1',
      regimentId: 'reg-1',
      createdByMemberId: 'mem-1',
      title: 'Weekly Muster',
      description: null,
      bannerUrl: null,
      startsAt: new Date('2026-07-01T18:00:00.000Z'),
      endsAt: new Date('2026-07-01T20:00:00.000Z'),
      timezone: 'UTC',
      isRecurring: true,
      recurrenceRule: null,
      recurrenceCadence: RecurrenceCadence.Weekly,
      recurrenceActive: true,
      recurrenceTemplateId: null,
      serverName: 'S1',
      serverPassword: 'pw',
      serverRegion: 'EU',
      status: 'upcoming',
      expectedAttendance: null,
      attendanceGoal: null,
      outcome: null,
      twitchUrl: null,
      startedAt: null,
      inLineCount: null,
      isDraft: false,
      isArchived: false,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      deletedAt: null,
      ...overrides,
    }) as RegimentEvent;

  beforeEach(async () => {
    jest.clearAllMocks();
    childRepo.find.mockResolvedValue([]);
    dataSource.transaction.mockImplementation((cb: (m: unknown) => unknown) =>
      cb({ getRepository: () => eventTxRepo }),
    );
    dataSource.getRepository.mockReturnValue(childRepo);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventRecurrenceScheduler,
        { provide: getRepositoryToken(RegimentEvent), useValue: events },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    scheduler = module.get(EventRecurrenceScheduler);
  });

  it('materializes future weekly occurrences within the horizon, linked to the template', async () => {
    events.find.mockImplementation((opts: { where: Record<string, unknown> }) => {
      // The templates query vs the existing-occurrences query.
      if ('recurrenceTemplateId' in opts.where && opts.where.recurrenceTemplateId === 'tmpl-1') {
        return Promise.resolve([]); // no existing occurrences yet
      }
      return Promise.resolve([template()]);
    });

    const created = await scheduler.generate(new Date('2026-07-01T19:00:00.000Z'));

    // 60-day horizon / 7-day cadence ≈ 8 occurrences.
    expect(created).toBeGreaterThanOrEqual(7);
    expect(created).toBeLessThanOrEqual(9);
    const firstOccurrence = eventTxRepo.create.mock.calls[0][0];
    expect(firstOccurrence.recurrenceTemplateId).toBe('tmpl-1');
    expect(firstOccurrence.isRecurring).toBe(false);
    expect(firstOccurrence.recurrenceActive).toBe(false);
    // Duration preserved (2h template).
    expect(firstOccurrence.endsAt!.getTime() - firstOccurrence.startsAt!.getTime()).toBe(
      2 * 60 * 60 * 1000,
    );
  });

  it('skips templates whose stop flag is off (no generation)', async () => {
    events.find.mockResolvedValue([]); // the query already filters recurrenceActive=true
    const created = await scheduler.generate(new Date('2026-07-01T19:00:00.000Z'));
    expect(created).toBe(0);
    expect(eventTxRepo.save).not.toHaveBeenCalled();
  });
});
