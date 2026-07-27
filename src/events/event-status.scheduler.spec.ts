import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { EventStatusScheduler } from './event-status.scheduler';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { RegimentEvent } from './entities/event.entity';

/** A chainable UPDATE QueryBuilder that resolves to a fixed `affected` count. */
const updateQb = (affected: number) => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['update', 'set', 'where', 'andWhere']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected });
  return qb;
};

/** A chainable SELECT QueryBuilder over a fixed raw-row list. */
const selectQb = (rows: Record<string, string>[]) => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['innerJoin', 'select', 'addSelect', 'where', 'andWhere', 'orderBy', 'limit']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
};

describe('EventStatusScheduler', () => {
  let scheduler: EventStatusScheduler;
  const events = { createQueryBuilder: jest.fn() };
  const announcements = { createQueryBuilder: jest.fn() };
  const discordSync = { enqueueEventAnnouncementClose: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    announcements.createQueryBuilder.mockReturnValue(selectQb([]));
    discordSync.enqueueEventAnnouncementClose.mockResolvedValue({ id: 'job-1' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventStatusScheduler,
        { provide: getRepositoryToken(RegimentEvent), useValue: events },
        { provide: getRepositoryToken(EventAnnouncement), useValue: announcements },
        { provide: DiscordSyncService, useValue: discordSync },
      ],
    }).compile();
    scheduler = module.get(EventStatusScheduler);
  });

  afterEach(() => scheduler.onModuleDestroy());

  it('runs two update sweeps and returns the total rows advanced', async () => {
    events.createQueryBuilder
      .mockReturnValueOnce(updateQb(2)) // upcoming → ongoing
      .mockReturnValueOnce(updateQb(3)); // upcoming/ongoing → previous

    const updated = await scheduler.advanceStatuses(new Date('2026-07-01T12:00:00.000Z'));

    expect(updated).toBe(5);
    expect(events.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  describe('retiring an ended event announcement (T-0205)', () => {
    it('enqueues a close for every announcement whose event has ended', async () => {
      announcements.createQueryBuilder.mockReturnValue(
        selectQb([
          { eventId: 'evt-1', regimentId: 'rgt-1' },
          { eventId: 'evt-2', regimentId: 'rgt-1' },
        ]),
      );

      expect(await scheduler.closeEndedAnnouncements()).toBe(2);
      expect(discordSync.enqueueEventAnnouncementClose).toHaveBeenCalledWith('rgt-1', 'evt-1');
      expect(discordSync.enqueueEventAnnouncementClose).toHaveBeenCalledWith('rgt-1', 'evt-2');
    });

    it('counts only what was actually queued, so an already-closed one is not double-counted', async () => {
      // The enqueue returns null for an announcement that is already retired.
      // Counting the ROWS instead would report work that never happened, every
      // minute, forever.
      announcements.createQueryBuilder.mockReturnValue(
        selectQb([{ eventId: 'evt-1', regimentId: 'rgt-1' }]),
      );
      discordSync.enqueueEventAnnouncementClose.mockResolvedValue(null);

      expect(await scheduler.closeEndedAnnouncements()).toBe(0);
    });

    it('never lets a Discord-side failure stop the status sweep', async () => {
      // The calendar is what members actually depend on; the buttons are not.
      events.createQueryBuilder.mockReturnValueOnce(updateQb(1)).mockReturnValueOnce(updateQb(0));
      announcements.createQueryBuilder.mockImplementation(() => {
        throw new Error('db down');
      });

      const tick = (scheduler as unknown as { tick(): Promise<void> }).tick();
      await expect(tick).resolves.toBeUndefined();
      expect(events.createQueryBuilder).toHaveBeenCalledTimes(2);
    });
  });

  it('starts an unref-ed interval on init and clears it on destroy', () => {
    const setSpy = jest.spyOn(global, 'setInterval');
    const clearSpy = jest.spyOn(global, 'clearInterval');

    scheduler.onModuleInit();
    expect(setSpy).toHaveBeenCalledTimes(1);

    scheduler.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
