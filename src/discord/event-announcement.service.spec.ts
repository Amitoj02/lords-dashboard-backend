import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RecurrenceCadence, RsvpStatus } from '../common/enums';
import { EventAnnouncement } from '../events/entities/event-announcement.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { EventAnnouncementService, eventTypeLabel } from './event-announcement.service';

const EVENT_ID = 'evt000000001';
const REGIMENT = 'Rgmt00000001';

const event = (overrides: Partial<RegimentEvent> = {}): RegimentEvent =>
  ({
    id: EVENT_ID,
    regimentId: REGIMENT,
    title: 'Line Battle',
    description: 'Bring your muskets.',
    startsAt: new Date('2026-08-01T19:00:00.000Z'),
    endsAt: new Date('2026-08-01T21:00:00.000Z'),
    timezone: 'America/Toronto',
    bannerUrl: null,
    isRecurring: false,
    recurrenceCadence: null,
    recurrenceTemplateId: null,
    announceRoleId: null,
    // Present on the ROW and deliberately absent from every projection below.
    serverPassword: 'hunter2',
    serverName: 'Lords Official',
    ...overrides,
  }) as unknown as RegimentEvent;

describe('EventAnnouncementService (T-0205)', () => {
  let service: EventAnnouncementService;

  /** A chainable query builder over a fixed raw-row list. */
  const rosterQb = (rows: Record<string, unknown>[]) => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'innerJoin',
      'leftJoin',
      'select',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
    ]) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue(rows);
    return qb;
  };

  const eventsRepo = { findOne: jest.fn() };
  const rsvpsRepo = { createQueryBuilder: jest.fn() };
  const announcementsRepo = { findOne: jest.fn(), upsert: jest.fn(), update: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    rsvpsRepo.createQueryBuilder.mockReturnValue(rosterQb([]));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventAnnouncementService,
        { provide: getRepositoryToken(RegimentEvent), useValue: eventsRepo },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvpsRepo },
        { provide: getRepositoryToken(EventAnnouncement), useValue: announcementsRepo },
      ],
    }).compile();
    service = module.get(EventAnnouncementService);
  });

  describe('summaryFor', () => {
    it('NEVER projects the server password — there is no field to carry one', async () => {
      // The password is gated behind an RSVP in the app; an announcement channel
      // is readable by the whole guild, so a leak here would retire that gate.
      const summary = await service.summaryFor(event());

      expect(JSON.stringify(summary)).not.toContain('hunter2');
      expect(summary).not.toHaveProperty('serverPassword');
      expect(summary).not.toHaveProperty('serverName');
    });

    it("carries the EVENT's own timezone, never the process locale", async () => {
      expect((await service.summaryFor(event())).timezone).toBe('America/Toronto');
    });
  });

  describe('rosterFor', () => {
    it('renders a linked member as a mention and everyone else by name', async () => {
      // A mention shows the member's own guild identity — and, inside an embed,
      // notifies nobody, which is what makes it safe to re-render on every press.
      rsvpsRepo.createQueryBuilder.mockReturnValue(
        rosterQb([
          { status: RsvpStatus.Interested, inGameName: 'Nolt', discordUserId: '111' },
          { status: RsvpStatus.Interested, inGameName: 'Rennick', discordUserId: null },
          { status: RsvpStatus.Tentative, inGameName: 'Sabine', discordUserId: '222' },
          { status: RsvpStatus.Declined, inGameName: 'Tarn', discordUserId: '333' },
        ]),
      );

      expect(await service.rosterFor(EVENT_ID)).toEqual({
        attending: ['<@111>', 'Rennick'],
        tentative: ['<@222>'],
        declined: ['<@333>'],
      });
    });

    it('drops a `neutral` RSVP rather than inventing a fourth section', async () => {
      // The buttons never produce one, and a member who cleared their answer on
      // the website should read as having no answer.
      rsvpsRepo.createQueryBuilder.mockReturnValue(
        rosterQb([{ status: RsvpStatus.Neutral, inGameName: 'Nolt', discordUserId: '111' }]),
      );

      expect(await service.rosterFor(EVENT_ID)).toEqual({
        attending: [],
        tentative: [],
        declined: [],
      });
    });
  });

  describe('pingTargets', () => {
    it('asks only for the members who said they are coming', async () => {
      const qb = rosterQb([{ discordUserId: '111' }, { discordUserId: '222' }]);
      rsvpsRepo.createQueryBuilder.mockReturnValue(qb);

      expect(await service.pingTargets(EVENT_ID)).toEqual(['111', '222']);
      // Declined is excluded BY CONSTRUCTION, in the query — somebody who took
      // the trouble to say they are not coming has opted out of this ping.
      expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('rsvp.status IN'), {
        coming: [RsvpStatus.Interested, RsvpStatus.Tentative],
      });
    });
  });

  describe('the delivery record', () => {
    it('UPSERTS, so a re-announce repoints at the live message', async () => {
      await service.recordDelivery(EVENT_ID, 'c1', 'msg-9');

      expect(announcementsRepo.upsert).toHaveBeenCalledWith(
        { eventId: EVENT_ID, channelId: 'c1', messageId: 'msg-9', threadId: null, closedAt: null },
        ['eventId'],
      );
    });

    it('records the thread and the close stamp against the event', async () => {
      await service.recordThread(EVENT_ID, 'thread-7');
      expect(announcementsRepo.update).toHaveBeenCalledWith(
        { eventId: EVENT_ID },
        { threadId: 'thread-7' },
      );

      const at = new Date('2026-08-01T22:00:00.000Z');
      await service.markClosed(EVENT_ID, at);
      expect(announcementsRepo.update).toHaveBeenCalledWith(
        { eventId: EVENT_ID },
        { closedAt: at },
      );
    });
  });

  describe('loadEvent', () => {
    it('refuses to announce a draft or archived event', async () => {
      await service.loadEvent(REGIMENT, EVENT_ID);

      expect(eventsRepo.findOne).toHaveBeenCalledWith({
        where: { id: EVENT_ID, regimentId: REGIMENT, isDraft: false, isArchived: false },
      });
    });
  });

  describe('eventTypeLabel', () => {
    it('tells a template, an occurrence and a one-off apart', () => {
      expect(eventTypeLabel(event())).toBe('One-off');
      expect(
        eventTypeLabel(event({ isRecurring: true, recurrenceCadence: RecurrenceCadence.Weekly })),
      ).toBe('Recurring (weekly)');
      expect(eventTypeLabel(event({ recurrenceTemplateId: 'tmpl-1' }))).toBe(
        'Recurring occurrence',
      );
    });
  });
});
