import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { EventNotifyOffset } from './entities/event-notify-offset.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { RegimentEvent } from './entities/event.entity';
import { EventReminderScheduler } from './event-reminder.scheduler';

const NOW = new Date('2026-08-01T18:00:00.000Z');
const REGIMENT = 'Rgmt00000001';

const event = (overrides: Partial<RegimentEvent> = {}): RegimentEvent =>
  ({
    id: 'evt-1',
    regimentId: REGIMENT,
    title: 'Line Battle',
    description: null,
    bannerUrl: null,
    startsAt: new Date('2026-08-01T19:00:00.000Z'),
    endsAt: null,
    timezone: 'America/Toronto',
    isRecurring: false,
    recurrenceCadence: null,
    recurrenceTemplateId: null,
    serverPassword: 'hunter2',
    ...overrides,
  }) as unknown as RegimentEvent;

const offset = (minutes: number, ev = event()): EventNotifyOffset => ({
  eventId: ev.id,
  minutes,
  sentAt: null,
  event: ev,
});

describe('EventReminderScheduler (T-0174)', () => {
  let scheduler: EventReminderScheduler;

  /** A chainable query-builder stub over a fixed due-offset list. */
  const qb: Record<string, jest.Mock> = {
    innerJoinAndSelect: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    addOrderBy: jest.fn(() => qb),
    limit: jest.fn(() => qb),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const offsetsRepo = {
    createQueryBuilder: jest.fn(() => qb),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const rsvpsRepo = { count: jest.fn().mockResolvedValue(4) };
  const discordSync = { enqueueEventReminder: jest.fn().mockResolvedValue(null) };

  beforeEach(async () => {
    jest.clearAllMocks();
    qb.getMany.mockResolvedValue([]);
    offsetsRepo.update.mockResolvedValue({ affected: 1 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventReminderScheduler,
        { provide: getRepositoryToken(EventNotifyOffset), useValue: offsetsRepo },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvpsRepo },
        { provide: DiscordSyncService, useValue: discordSync },
      ],
    }).compile();
    scheduler = module.get(EventReminderScheduler);
  });

  it('fires a due offset once, with its lead time and the live RSVP count', async () => {
    qb.getMany.mockResolvedValue([offset(60)]);

    expect(await scheduler.sweep(NOW)).toBe(1);

    expect(discordSync.enqueueEventReminder).toHaveBeenCalledWith(
      REGIMENT,
      expect.objectContaining({ title: 'Line Battle', rsvpCount: 4, timezone: 'America/Toronto' }),
      60,
    );
  });

  it('NEVER puts the event server password in the reminder', async () => {
    qb.getMany.mockResolvedValue([offset(60)]);

    await scheduler.sweep(NOW);

    const summary = discordSync.enqueueEventReminder.mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(summary)).not.toContain('hunter2');
    expect(summary).not.toHaveProperty('serverPassword');
  });

  it('CLAIMS the offset before sending, so a restart can never re-fire it', async () => {
    // Durability: the "already fired" record is a column, not memory. Claiming
    // first makes the delivery at-most-once, which is the right bias for a
    // non-idempotent announcement.
    qb.getMany.mockResolvedValue([offset(60)]);

    await scheduler.sweep(NOW);

    expect(offsetsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-1', minutes: 60 }),
      { sentAt: NOW },
    );
    const claimOrder = offsetsRepo.update.mock.invocationCallOrder[0];
    const sendOrder = discordSync.enqueueEventReminder.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it('sends NOTHING when another sweep already claimed the offset', async () => {
    qb.getMany.mockResolvedValue([offset(60)]);
    offsetsRepo.update.mockResolvedValue({ affected: 0 });

    expect(await scheduler.sweep(NOW)).toBe(0);
    expect(discordSync.enqueueEventReminder).not.toHaveBeenCalled();
  });

  it('retires a missed reminder for an event that ALREADY STARTED', async () => {
    // The server was down past the muster; "starts in 15 minutes" an hour late is
    // misinformation. The offset is still resolved so it cannot fire later.
    const started = event({ startsAt: new Date('2026-08-01T17:00:00.000Z') });
    qb.getMany.mockResolvedValue([offset(15, started)]);

    expect(await scheduler.sweep(NOW)).toBe(0);

    expect(offsetsRepo.update).toHaveBeenCalledTimes(1);
    expect(discordSync.enqueueEventReminder).not.toHaveBeenCalled();
  });

  it('collapses a backlog to the NEAREST offset instead of firing a burst', async () => {
    // A long outage leaves the 1440-, 60- and 15-minute offsets all due at once.
    // Only the 15-minute one is still true; the others are retired.
    const ev = event();
    qb.getMany.mockResolvedValue([offset(15, ev), offset(60, ev), offset(1440, ev)]);

    expect(await scheduler.sweep(NOW)).toBe(1);

    expect(discordSync.enqueueEventReminder).toHaveBeenCalledTimes(1);
    expect(discordSync.enqueueEventReminder).toHaveBeenCalledWith(REGIMENT, expect.anything(), 15);
    // All three are resolved, so the backlog cannot fire again next tick.
    expect(offsetsRepo.update).toHaveBeenCalledTimes(3);
  });

  it('handles several events in one sweep independently', async () => {
    const other = event({ id: 'evt-2', title: 'Siege' });
    qb.getMany.mockResolvedValue([offset(60), offset(30, other)]);

    expect(await scheduler.sweep(NOW)).toBe(2);
  });

  it('does nothing at all when no offset is due', async () => {
    expect(await scheduler.sweep(NOW)).toBe(0);
    expect(offsetsRepo.update).not.toHaveBeenCalled();
  });

  it('never lets a failure escape the tick', async () => {
    qb.getMany.mockRejectedValue(new Error('db down'));
    const tick = (scheduler as unknown as { tick(): Promise<void> }).tick();
    await expect(tick).resolves.toBeUndefined();
  });

  it('does not hold the event loop open', () => {
    scheduler.onModuleInit();
    const timer = (scheduler as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);
    scheduler.onModuleDestroy();
    expect((scheduler as unknown as { timer: unknown }).timer).toBeNull();
  });
});
