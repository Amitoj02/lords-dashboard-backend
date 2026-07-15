import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { StorageService } from '../storage/storage.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { EventStatus, MemberRole, RecurrenceCadence, RsvpStatus } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { EventAttendee } from './entities/event-attendee.entity';
import { EventNotifyOffset } from './entities/event-notify-offset.entity';
import { EventPlatform } from './entities/event-platform.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { EventTag } from './entities/event-tag.entity';
import { RegimentEvent } from './entities/event.entity';
import { EventsService } from './events.service';

const REGIMENT = 'regiment-1';
const MEMBER = 'member-1';
const NOW = new Date('2026-07-01T00:00:00.000Z');

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  identityId: 'identity-1',
  memberId: MEMBER,
  discordUserId: 'discord-1',
  role: MemberRole.Admin,
  regimentId: REGIMENT,
  ...overrides,
});

const buildEvent = (overrides: Partial<RegimentEvent> = {}): RegimentEvent => ({
  id: 'event-1',
  regimentId: REGIMENT,
  createdByMemberId: MEMBER,
  title: 'Friday Line Battle',
  description: null,
  bannerUrl: null,
  startsAt: new Date('2026-08-01T18:00:00.000Z'),
  endsAt: null,
  timezone: 'UTC',
  isRecurring: false,
  recurrenceRule: null,
  recurrenceCadence: null,
  recurrenceActive: false,
  recurrenceTemplateId: null,
  serverName: 'LORDS-1',
  serverPassword: 'hunter2',
  serverRegion: 'EU',
  status: EventStatus.Upcoming,
  expectedAttendance: null,
  attendanceGoal: null,
  outcome: null,
  twitchUrl: null,
  startedAt: null,
  inLineCount: null,
  isDraft: false,
  isArchived: false,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

/** A chainable SELECT/grouped QueryBuilder returning a fixed raw/entity result. */
const selectQb = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('EventsService', () => {
  let service: EventsService;

  let eventsQb: Record<string, jest.Mock>;
  let rsvpsQb: Record<string, jest.Mock>;
  let attendeesQb: Record<string, jest.Mock>;

  const events = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    softRemove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const rsvps = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const attendees = {
    find: jest.fn(),
    insert: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const platforms = { find: jest.fn() };
  const tags = { find: jest.fn() };
  const notifyOffsets = { find: jest.fn() };
  const members = { find: jest.fn() };
  const settings = { find: jest.fn(), findOne: jest.fn() };
  const audit = { record: jest.fn() };
  const discordSync = { enqueueEventAnnounce: jest.fn().mockResolvedValue(null) };
  const storage = {
    resolveKeyToPublicUrl: jest.fn((_u: unknown, key: string) => `https://cdn.example/${key}`),
  };

  // Transaction manager repositories (rebuilt each test).
  let eventTxRepo: { create: jest.Mock; save: jest.Mock; softDelete: jest.Mock };
  let platformTxRepo: { delete: jest.Mock; insert: jest.Mock };
  let tagTxRepo: { delete: jest.Mock; insert: jest.Mock };
  let notifyTxRepo: { delete: jest.Mock; insert: jest.Mock };
  const dataSource = { transaction: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    eventsQb = selectQb();
    rsvpsQb = selectQb();
    attendeesQb = selectQb();

    events.findOne.mockResolvedValue(null);
    events.find.mockResolvedValue([]);
    events.save.mockImplementation((e: RegimentEvent) => Promise.resolve(e));
    events.softRemove.mockImplementation((e: RegimentEvent) => Promise.resolve(e));
    events.createQueryBuilder.mockReturnValue(eventsQb);

    rsvps.findOne.mockResolvedValue(null);
    rsvps.find.mockResolvedValue([]);
    rsvps.save.mockImplementation((r: unknown) => Promise.resolve(r));
    rsvps.create.mockImplementation((r: unknown) => r);
    rsvps.delete.mockResolvedValue({ affected: 0 });
    rsvps.createQueryBuilder.mockReturnValue(rsvpsQb);

    attendees.find.mockResolvedValue([]);
    attendees.insert.mockResolvedValue({});
    attendees.delete.mockResolvedValue({ affected: 0 });
    attendees.createQueryBuilder.mockReturnValue(attendeesQb);

    platforms.find.mockResolvedValue([]);
    tags.find.mockResolvedValue([]);
    notifyOffsets.find.mockResolvedValue([]);
    members.find.mockResolvedValue([]);

    settings.find.mockResolvedValue([{ regimentId: REGIMENT, publicEvents: true }]);
    settings.findOne.mockResolvedValue(null);

    eventTxRepo = {
      create: jest.fn((data: Partial<RegimentEvent>) => ({
        id: 'event-new',
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      })),
      save: jest.fn((e: RegimentEvent) => Promise.resolve(e)),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    platformTxRepo = { delete: jest.fn(), insert: jest.fn() };
    tagTxRepo = { delete: jest.fn(), insert: jest.fn() };
    notifyTxRepo = { delete: jest.fn(), insert: jest.fn() };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === RegimentEvent) return eventTxRepo;
        if (entity === EventPlatform) return platformTxRepo;
        if (entity === EventTag) return tagTxRepo;
        if (entity === EventNotifyOffset) return notifyTxRepo;
        throw new Error('unexpected repository');
      }),
    };
    dataSource.transaction.mockImplementation((cb: (m: typeof manager) => unknown) => cb(manager));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getRepositoryToken(RegimentEvent), useValue: events },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(EventAttendee), useValue: attendees },
        { provide: getRepositoryToken(EventPlatform), useValue: platforms },
        { provide: getRepositoryToken(EventTag), useValue: tags },
        { provide: getRepositoryToken(EventNotifyOffset), useValue: notifyOffsets },
        { provide: getRepositoryToken(Member), useValue: members },
        { provide: getRepositoryToken(RegimentSettings), useValue: settings },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditService, useValue: audit },
        { provide: DiscordSyncService, useValue: discordSync },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(EventsService);
  });

  describe('create', () => {
    const baseDto = (): CreateEventDto => ({
      title: 'Muster',
      startsAt: '2026-08-01T18:00:00.000Z',
    });

    it('defaults timezone and notify offsets from the regiment settings', async () => {
      settings.findOne.mockResolvedValue({
        regimentId: REGIMENT,
        eventDefaultTimezone: 'Europe/Berlin',
        eventDefaultNotifyBefore: [60, 15],
      });

      const result = await service.create(user(), baseDto(), '1.2.3.4');

      const created = eventTxRepo.create.mock.calls[0][0] as Partial<RegimentEvent>;
      expect(created.timezone).toBe('Europe/Berlin');
      expect(created.status).toBe(EventStatus.Upcoming);
      expect(created.isDraft).toBe(false);
      expect(created.createdByMemberId).toBe(MEMBER);
      // The settings default flows into the notify-offset child rows.
      expect(notifyTxRepo.insert).toHaveBeenCalledWith([
        { eventId: 'event-new', minutes: 60 },
        { eventId: 'event-new', minutes: 15 },
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'event.create', regimentId: REGIMENT }),
      );
      // Member view: id present, server fields present, password never projected.
      expect(result.id).toBe('event-new');
      expect(result.isDraft).toBe(false);
      expect(result.myRsvp).toBeNull();
      expect(result).not.toHaveProperty('serverPassword');
    });

    it('honors an explicit timezone over the settings default', async () => {
      settings.findOne.mockResolvedValue({
        regimentId: REGIMENT,
        eventDefaultTimezone: 'Europe/Berlin',
        eventDefaultNotifyBefore: null,
      });

      await service.create(user(), { ...baseDto(), timezone: 'America/Toronto' }, null);

      const created = eventTxRepo.create.mock.calls[0][0] as Partial<RegimentEvent>;
      expect(created.timezone).toBe('America/Toronto');
    });

    it('publishes directly and enqueues exactly one Discord announce (T-0072)', async () => {
      await service.create(user(), baseDto(), null);

      const created = eventTxRepo.create.mock.calls[0][0] as Partial<RegimentEvent>;
      expect(created.isDraft).toBe(false);
      expect(discordSync.enqueueEventAnnounce).toHaveBeenCalledTimes(1);
      expect(discordSync.enqueueEventAnnounce).toHaveBeenCalledWith(
        REGIMENT,
        expect.stringContaining('New event: Muster'),
      );
    });

    it('stores a cadence as an active recurring template (T-0074)', async () => {
      await service.create(user(), { ...baseDto(), recurrenceCadence: 'weekly' as never }, null);

      const created = eventTxRepo.create.mock.calls[0][0] as Partial<RegimentEvent>;
      expect(created.recurrenceCadence).toBe('weekly');
      expect(created.recurrenceActive).toBe(true);
      expect(created.isRecurring).toBe(true);
      expect(created.recurrenceTemplateId).toBeNull();
    });
  });

  describe('listPublic', () => {
    it('throws Forbidden when publicEvents is disabled', async () => {
      settings.find.mockResolvedValue([{ regimentId: REGIMENT, publicEvents: false }]);

      await expect(service.listPublic({ page: 1, limit: 20, skip: 0 })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(events.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('throws NotFound when the regiment is not configured', async () => {
      settings.find.mockResolvedValue([]);

      await expect(service.listPublic({ page: 1, limit: 20, skip: 0 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('redacts the server binding in the public projection', async () => {
      eventsQb.getManyAndCount.mockResolvedValue([[buildEvent()], 1]);

      const result = await service.listPublic({ page: 1, limit: 20, skip: 0 });

      expect(result.meta.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('event-1');
      // Server binding is redacted from the public view (never the real value).
      expect(result.data[0].serverName).toBeUndefined();
      expect(result.data[0].serverRegion).toBeUndefined();
      expect(result.data[0]).not.toHaveProperty('serverPassword');
      expect(result.data[0].rsvpCounts).toEqual({
        interested: 0,
        tentative: 0,
        declined: 0,
        neutral: 0,
      });
    });
  });

  describe('listForMember (T-0073)', () => {
    it('includes the server binding + myRsvp for an enrolled member', async () => {
      eventsQb.getManyAndCount.mockResolvedValue([[buildEvent()], 1]);
      rsvps.find.mockResolvedValue([
        {
          eventId: 'event-1',
          memberId: MEMBER,
          status: RsvpStatus.Interested,
          reminderOffsetMinutes: 30,
        },
      ]);

      const result = await service.listForMember(user(), { page: 1, limit: 20, skip: 0 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].serverName).toBe('LORDS-1');
      expect(result.data[0].serverRegion).toBe('EU');
      expect(result.data[0].myRsvp).toEqual({
        status: RsvpStatus.Interested,
        reminderOffsetMinutes: 30,
      });
      // The password is never projected, even in the member view.
      expect(result.data[0]).not.toHaveProperty('serverPassword');
    });

    it('redacts the server binding for a non-enrolled caller (no memberId)', async () => {
      eventsQb.getManyAndCount.mockResolvedValue([[buildEvent()], 1]);

      const result = await service.listForMember(user({ memberId: null }), {
        page: 1,
        limit: 20,
        skip: 0,
      });

      expect(result.data[0].serverName).toBeUndefined();
      expect(result.data[0].serverRegion).toBeUndefined();
      expect(result.data[0].myRsvp).toBeUndefined();
      expect(result.data[0]).not.toHaveProperty('serverPassword');
    });
  });

  describe('getForMember (T-0073)', () => {
    it('404s a hidden or missing event', async () => {
      events.findOne.mockResolvedValue(null);
      await expect(service.getForMember(user(), 'event-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the member projection for an enrolled member', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      const result = await service.getForMember(user(), 'event-1');
      expect(result.serverName).toBe('LORDS-1');
      expect(result).not.toHaveProperty('serverPassword');
    });
  });

  describe('update recurrence (T-0074)', () => {
    it('permanently stops a recurring template via recurrenceActive=false', async () => {
      events.findOne.mockResolvedValue(
        buildEvent({
          isRecurring: true,
          recurrenceActive: true,
          recurrenceCadence: 'weekly' as never,
        }),
      );

      const result = await service.update(user(), 'event-1', { recurrenceActive: false }, null);

      expect(result.recurrenceActive).toBe(false);
      // The cadence is retained; only generation stops.
      expect(result.recurrenceCadence).toBe('weekly');
    });
  });

  describe('revealPassword', () => {
    it('refuses when the caller has no RSVP', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      rsvps.findOne.mockResolvedValue(null);

      await expect(service.revealPassword(user(), 'event-1', null)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses when the caller RSVP is declined', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      rsvps.findOne.mockResolvedValue({ status: RsvpStatus.Declined });

      await expect(service.revealPassword(user(), 'event-1', null)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('returns 404 when no password is set on the event', async () => {
      events.findOne.mockResolvedValue(buildEvent({ serverPassword: null }));
      rsvps.findOne.mockResolvedValue({ status: RsvpStatus.Interested });

      await expect(service.revealPassword(user(), 'event-1', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the decrypted password to an RSVP’d caller and audits the reveal', async () => {
      events.findOne.mockResolvedValue(
        buildEvent({ serverPassword: 'hunter2', serverName: 'LORDS-1', serverRegion: 'EU' }),
      );
      rsvps.findOne.mockResolvedValue({ status: RsvpStatus.Interested });

      const result = await service.revealPassword(user(), 'event-1', '9.9.9.9');

      expect(result).toEqual({
        serverName: 'LORDS-1',
        serverRegion: 'EU',
        serverPassword: 'hunter2',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'event.password.reveal',
          target: expect.objectContaining({ type: 'event', id: 'event-1' }),
        }),
      );
    });
  });

  describe('rsvp', () => {
    it('forbids RSVP when the caller has no member id', async () => {
      await expect(
        service.rsvp(user({ memberId: null }), 'event-1', { status: RsvpStatus.Interested }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('inserts a new RSVP and returns the member view', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      rsvps.findOne.mockResolvedValue(null);

      const result = await service.rsvp(user(), 'event-1', {
        status: RsvpStatus.Interested,
        reminderOffsetMinutes: 30,
      });

      const created = rsvps.create.mock.calls[0][0];
      expect(created).toMatchObject({
        eventId: 'event-1',
        memberId: MEMBER,
        status: RsvpStatus.Interested,
        reminderOffsetMinutes: 30,
      });
      expect(created.respondedAt).toBeInstanceOf(Date);
      expect(rsvps.save).toHaveBeenCalled();
      expect(result.id).toBe('event-1');
    });

    it('updates an existing RSVP in place', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      const existing = {
        eventId: 'event-1',
        memberId: MEMBER,
        status: RsvpStatus.Tentative,
        reminderOffsetMinutes: null,
        respondedAt: null,
      };
      rsvps.findOne.mockResolvedValue(existing);

      await service.rsvp(user(), 'event-1', { status: RsvpStatus.Declined });

      expect(rsvps.create).not.toHaveBeenCalled();
      const saved = rsvps.save.mock.calls[0][0];
      expect(saved.status).toBe(RsvpStatus.Declined);
      expect(saved.respondedAt).toBeInstanceOf(Date);
    });
  });

  describe('complete', () => {
    it('sets previous status, stamps start/end and records the outcome', async () => {
      events.findOne.mockResolvedValue(buildEvent());

      await service.complete(user(), 'event-1', { outcome: 'Victory', inLineCount: 42 }, null);

      const saved = events.save.mock.calls[0][0] as RegimentEvent;
      expect(saved.status).toBe(EventStatus.Previous);
      expect(saved.startedAt).toBeInstanceOf(Date);
      expect(saved.endsAt).toBeInstanceOf(Date);
      expect(saved.outcome).toBe('Victory');
      expect(saved.inLineCount).toBe(42);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'event.completed' }),
      );
    });
  });

  describe('addAttendees', () => {
    it('rejects member ids that do not belong to the regiment', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      members.find.mockResolvedValue([{ id: 'member-1', name: 'Alpha' }]);

      await expect(
        service.addAttendees(user(), 'event-1', { memberIds: ['member-1', 'stranger'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(attendees.insert).not.toHaveBeenCalled();
    });

    it('idempotently inserts only members not already checked in', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      members.find.mockResolvedValue([
        { id: 'member-1', name: 'Alpha' },
        { id: 'member-2', name: 'Bravo' },
      ]);
      // member-1 is already an attendee; only member-2 should be inserted.
      attendees.find
        .mockResolvedValueOnce([{ eventId: 'event-1', memberId: 'member-1', checkedInAt: NOW }])
        .mockResolvedValueOnce([
          { eventId: 'event-1', memberId: 'member-1', checkedInAt: NOW },
          { eventId: 'event-1', memberId: 'member-2', checkedInAt: NOW },
        ]);

      const result = await service.addAttendees(user(), 'event-1', {
        memberIds: ['member-1', 'member-2'],
      });

      expect(attendees.insert).toHaveBeenCalledWith([
        { eventId: 'event-1', memberId: 'member-2', checkedInAt: expect.any(Date) },
      ]);
      expect(result).toHaveLength(2);
      expect(result.map((a) => a.name)).toEqual(['Alpha', 'Bravo']);
    });
  });

  describe('remove', () => {
    it('soft-removes the event and audits the deletion', async () => {
      const event = buildEvent();
      events.findOne.mockResolvedValue(event);

      await service.remove(user(), 'event-1', null);

      expect(events.softRemove).toHaveBeenCalledWith(event);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'event.delete' }),
      );
    });

    it('throws NotFound for a missing / wrong-regiment event', async () => {
      events.findOne.mockResolvedValue(null);
      await expect(service.remove(user(), 'missing', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('removeSeries (T-0079)', () => {
    it('soft-deletes the template and every occurrence in one transaction and audits it', async () => {
      const template = buildEvent({
        id: 'tmpl-1',
        isRecurring: true,
        recurrenceCadence: RecurrenceCadence.Weekly,
        recurrenceActive: true,
        recurrenceTemplateId: null,
      });
      events.findOne.mockResolvedValue(template);

      await service.removeSeries(user(), 'tmpl-1', null);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // template row …
      expect(eventTxRepo.softDelete).toHaveBeenCalledWith({ id: 'tmpl-1', regimentId: REGIMENT });
      // … and all occupancies keyed by the template id.
      expect(eventTxRepo.softDelete).toHaveBeenCalledWith({
        recurrenceTemplateId: 'tmpl-1',
        regimentId: REGIMENT,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'event.delete-series',
          target: expect.objectContaining({ id: 'tmpl-1' }),
        }),
      );
    });

    it('resolves an occurrence id to its template and deletes the whole series', async () => {
      const occurrence = buildEvent({
        id: 'occ-9',
        recurrenceCadence: null,
        recurrenceTemplateId: 'tmpl-1',
      });
      events.findOne.mockResolvedValue(occurrence);

      await service.removeSeries(user(), 'occ-9', null);

      expect(eventTxRepo.softDelete).toHaveBeenCalledWith({ id: 'tmpl-1', regimentId: REGIMENT });
      expect(eventTxRepo.softDelete).toHaveBeenCalledWith({
        recurrenceTemplateId: 'tmpl-1',
        regimentId: REGIMENT,
      });
    });

    it('rejects a one-off (non-recurring) event with 400 and deletes nothing', async () => {
      const oneOff = buildEvent({ recurrenceCadence: null, recurrenceTemplateId: null });
      events.findOne.mockResolvedValue(oneOff);

      await expect(service.removeSeries(user(), 'event-1', null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws NotFound for a missing / wrong-regiment id', async () => {
      events.findOne.mockResolvedValue(null);
      await expect(service.removeSeries(user(), 'missing', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
