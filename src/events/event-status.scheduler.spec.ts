import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventStatusScheduler } from './event-status.scheduler';
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

describe('EventStatusScheduler', () => {
  let scheduler: EventStatusScheduler;
  const events = { createQueryBuilder: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventStatusScheduler,
        { provide: getRepositoryToken(RegimentEvent), useValue: events },
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
