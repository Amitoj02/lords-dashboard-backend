import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthzService } from '../authz/authz.service';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { StorageService } from '../storage/storage.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import {
  Capability,
  EventStatus,
  MemberRole,
  RecurrenceCadence,
  RsvpStatus,
} from '../common/enums';
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
    'innerJoinAndSelect',
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
  qb.getMany = jest.fn().mockResolvedValue([]);
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
  // Capability gate for archived-event visibility (T-0097/T-0098). Defaults to
  // denying ManageEvents; individual tests opt in with mockResolvedValue(true).
  const authz = { can: jest.fn() };
  const discordSync = { enqueueEventAnnounce: jest.fn().mockResolvedValue(null) };
  const storage = {
    resolveKeyToPublicUrl: jest.fn((_u: unknown, key: string) => `https://cdn.example/${key}`),
  };

  // Transaction manager repositories (rebuilt each test).
  let eventTxRepo: { create: jest.Mock; save: jest.Mock; softDelete: jest.Mock; update: jest.Mock };
  let platformTxRepo: { delete: jest.Mock; insert: jest.Mock };
  let tagTxRepo: { delete: jest.Mock; insert: jest.Mock };
  let notifyTxRepo: { find: jest.Mock; delete: jest.Mock; insert: jest.Mock };
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

    // Deny the ManageEvents capability by default; archived-visibility tests opt in.
    authz.can.mockResolvedValue(false);

    eventTxRepo = {
      create: jest.fn((data: Partial<RegimentEvent>) => ({
        id: 'event-new',
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      })),
      save: jest.fn((e: RegimentEvent) => Promise.resolve(e)),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    platformTxRepo = { delete: jest.fn(), insert: jest.fn() };
    tagTxRepo = { delete: jest.fn(), insert: jest.fn() };
    // `find` backs the T-0174 sentAt carry-over: replaceChildren reads the
    // existing offsets so a re-submitted lead time keeps its dispatch record.
    notifyTxRepo = { find: jest.fn().mockResolvedValue([]), delete: jest.fn(), insert: jest.fn() };

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
        { provide: AuthzService, useValue: authz },
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
      // A brand-new event's offsets have no prior dispatch record (T-0174).
      expect(notifyTxRepo.insert).toHaveBeenCalledWith([
        { eventId: 'event-new', minutes: 60, sentAt: null },
        { eventId: 'event-new', minutes: 15, sentAt: null },
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
      // The announcement is composed by DiscordSyncService now (T-0174); the
      // service hands over a projection of the event, never rendered text — and
      // that projection structurally cannot carry the server password.
      expect(discordSync.enqueueEventAnnounce).toHaveBeenCalledWith(
        REGIMENT,
        expect.objectContaining({ title: 'Muster', rsvpCount: 0, eventType: 'One-off' }),
      );
      const summary = discordSync.enqueueEventAnnounce.mock.calls[0][1] as Record<string, unknown>;
      expect(summary).not.toHaveProperty('serverPassword');
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

  describe('timestamp resolution (T-0156)', () => {
    /** A wall-clock payload exactly as the authoring form posts it (no offset). */
    const naiveDto = (): CreateEventDto => ({ title: 'Muster', startsAt: '2026-07-20T21:57:00' });

    /** The `startsAt` handed to the repository on create. */
    const createdStart = (): string =>
      (eventTxRepo.create.mock.calls[0][0] as Partial<RegimentEvent>).startsAt!.toISOString();

    it('anchors a naive start to the event timezone, not the process timezone', async () => {
      await service.create(user(), { ...naiveDto(), timezone: 'America/New_York' }, null);

      // 21:57 in New York, not 21:57 in whatever zone the container happens to run.
      expect(createdStart()).toBe('2026-07-21T01:57:00.000Z');
    });

    it('resolves the zone offset per date, so EST and EDT differ by an hour', async () => {
      await service.create(
        user(),
        { title: 'Muster', startsAt: '2026-01-20T21:57:00', timezone: 'America/New_York' },
        null,
      );

      // A hard-coded -04:00 would store 01:57Z here too.
      expect(createdStart()).toBe('2026-01-21T02:57:00.000Z');
    });

    it('anchors to the regiment default timezone when the payload omits one', async () => {
      settings.findOne.mockResolvedValue({
        regimentId: REGIMENT,
        eventDefaultTimezone: 'America/New_York',
        eventDefaultNotifyBefore: null,
      });

      await service.create(user(), naiveDto(), null);

      expect(createdStart()).toBe('2026-07-21T01:57:00.000Z');
    });

    it('keeps an offset-qualified start verbatim, ignoring the timezone field', async () => {
      await service.create(
        user(),
        { ...naiveDto(), startsAt: '2026-07-20T21:57:00Z', timezone: 'America/New_York' },
        null,
      );

      // API clients must still be able to post a true instant.
      expect(createdStart()).toBe('2026-07-20T21:57:00.000Z');
    });

    it('stores the same instant whichever timezone the container runs in', async () => {
      const original = process.env.TZ;
      const stored: string[] = [];
      try {
        for (const tz of ['UTC', 'Europe/Berlin']) {
          jest.clearAllMocks();
          process.env.TZ = tz;
          await service.create(user(), { ...naiveDto(), timezone: 'America/New_York' }, null);
          stored.push(createdStart());
        }
      } finally {
        process.env.TZ = original;
      }

      expect(stored).toEqual(['2026-07-21T01:57:00.000Z', '2026-07-21T01:57:00.000Z']);
    });

    it('re-resolves a PATCH of only endsAt against the event’s STORED timezone', async () => {
      events.findOne.mockResolvedValue(buildEvent({ timezone: 'America/New_York' }));

      const result = await service.update(
        user(),
        'event-1',
        { endsAt: '2026-07-20T23:00:00' },
        null,
      );

      expect(result.endsAt).toBe('2026-07-21T03:00:00.000Z');
      // The untouched start keeps its stored instant.
      expect(result.startsAt).toBe('2026-08-01T18:00:00.000Z');
    });

    it('resolves against the timezone sent in the SAME PATCH, not the stored one', async () => {
      events.findOne.mockResolvedValue(buildEvent({ timezone: 'America/New_York' }));

      const result = await service.update(
        user(),
        'event-1',
        { startsAt: '2026-07-20T21:57:00', timezone: 'Europe/Berlin' },
        null,
      );

      expect(result.startsAt).toBe('2026-07-20T19:57:00.000Z');
      expect(result.timezone).toBe('Europe/Berlin');
    });

    it('does not move an already-stored instant when only the timezone changes', async () => {
      events.findOne.mockResolvedValue(buildEvent({ timezone: 'UTC' }));

      const result = await service.update(
        user(),
        'event-1',
        { timezone: 'America/New_York' },
        null,
      );

      // Re-labelling the zone is not a reschedule — the stored instant stands.
      expect(result.startsAt).toBe('2026-08-01T18:00:00.000Z');
      expect(result.timezone).toBe('America/New_York');
    });
  });

  describe('server binding (T-0151)', () => {
    it('collapses empty server fields to null on create', async () => {
      const result = await service.create(
        user(),
        {
          title: 'Muster',
          startsAt: '2026-08-01T18:00:00.000Z',
          serverName: '',
          serverRegion: '',
          serverPassword: '',
        },
        null,
      );

      const created = eventTxRepo.create.mock.calls[0][0] as Partial<RegimentEvent>;
      expect(created.serverName).toBeNull();
      expect(created.serverRegion).toBeNull();
      expect(created.serverPassword).toBeNull();
      // The encryption transformer only nulls '' on the way to the DB, so without
      // the collapse the just-saved entity would report a password it doesn't have.
      expect(result.hasServerPassword).toBe(false);
      expect(result.hasServerName).toBe(false);
      expect(result.serverName).toBeNull();
    });

    it('clears a stored binding when a PATCH sends empty strings', async () => {
      events.findOne.mockResolvedValue(buildEvent());

      const result = await service.update(
        user(),
        'event-1',
        { serverName: '', serverPassword: '' },
        null,
      );

      const saved = eventTxRepo.save.mock.calls[0][0] as RegimentEvent;
      expect(saved.serverName).toBeNull();
      expect(saved.serverPassword).toBeNull();
      expect(result.hasServerPassword).toBe(false);
      // Region was not in the payload — clearing one field never clears another.
      expect(saved.serverRegion).toBe('EU');
    });

    it('leaves the binding untouched when the PATCH omits it', async () => {
      events.findOne.mockResolvedValue(buildEvent());

      const result = await service.update(user(), 'event-1', { title: 'Renamed' }, null);

      const saved = eventTxRepo.save.mock.calls[0][0] as RegimentEvent;
      expect(saved.serverName).toBe('LORDS-1');
      expect(saved.serverPassword).toBe('hunter2');
      expect(result.hasServerPassword).toBe(true);
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

    it('still exposes the server presence flags publicly (T-0151)', async () => {
      eventsQb.getManyAndCount.mockResolvedValue([
        [buildEvent(), buildEvent({ id: 'event-2', serverName: null, serverPassword: null })],
        2,
      ]);

      const result = await service.listPublic({ page: 1, limit: 20, skip: 0 });

      // Without these the public calendar cannot distinguish a password-protected
      // event from a plain one — the values themselves stay redacted.
      expect(result.data[0].hasServerName).toBe(true);
      expect(result.data[0].hasServerPassword).toBe(true);
      expect(result.data[1].hasServerName).toBe(false);
      expect(result.data[1].hasServerPassword).toBe(false);
      expect(result.data[0].serverName).toBeUndefined();
    });

    it('treats an empty stored server binding as unset, not as a bound server', async () => {
      // Rows written before the write-side collapse can hold ''; a truthy flag
      // would make the SPA render a "server details" badge for nothing.
      eventsQb.getManyAndCount.mockResolvedValue([
        [buildEvent({ serverName: '', serverPassword: '' })],
        1,
      ]);

      const result = await service.listPublic({ page: 1, limit: 20, skip: 0 });

      expect(result.data[0].hasServerName).toBe(false);
      expect(result.data[0].hasServerPassword).toBe(false);
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
      // The password value is never projected, but the presence flag is (T-0106).
      expect(result.data[0]).not.toHaveProperty('serverPassword');
      expect(result.data[0].hasServerPassword).toBe(true);
    });

    it('reports hasServerPassword=false in the member view when no password is set (T-0106)', async () => {
      eventsQb.getManyAndCount.mockResolvedValue([[buildEvent({ serverPassword: null })], 1]);

      const result = await service.listForMember(user(), { page: 1, limit: 20, skip: 0 });

      expect(result.data[0].serverName).toBe('LORDS-1');
      expect(result.data[0].hasServerPassword).toBe(false);
      expect(result.data[0]).not.toHaveProperty('serverPassword');
    });

    it('projects an empty stored server name as null, never as an empty string (T-0151)', async () => {
      eventsQb.getManyAndCount.mockResolvedValue([[buildEvent({ serverName: '' })], 1]);

      const result = await service.listForMember(user(), { page: 1, limit: 20, skip: 0 });

      // One null check is the whole contract the SPA gets to rely on.
      expect(result.data[0].serverName).toBeNull();
      expect(result.data[0].hasServerName).toBe(false);
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
      // The presence flags survive redaction (T-0151) — they carry no secret and
      // the SPA branches on them.
      expect(result.data[0].hasServerName).toBe(true);
      expect(result.data[0].hasServerPassword).toBe(true);
    });

    it('applies the isArchived=false filter for a normal caller (T-0098)', async () => {
      await service.listForMember(user(), { page: 1, limit: 20, skip: 0 });

      expect(eventsQb.andWhere).toHaveBeenCalledWith('event.isArchived = :isArchived', {
        isArchived: false,
      });
    });

    it('still excludes archived when archived=true but the caller lacks ManageEvents (T-0098)', async () => {
      authz.can.mockResolvedValue(false);

      await service.listForMember(user(), { page: 1, limit: 20, skip: 0, archived: true });

      expect(eventsQb.andWhere).toHaveBeenCalledWith('event.isArchived = :isArchived', {
        isArchived: false,
      });
    });

    it('includes archived when archived=true AND the caller holds ManageEvents (T-0098)', async () => {
      authz.can.mockResolvedValue(true);

      await service.listForMember(user(), { page: 1, limit: 20, skip: 0, archived: true });

      expect(authz.can).toHaveBeenCalledWith(REGIMENT, MemberRole.Admin, Capability.ManageEvents);
      expect(eventsQb.andWhere).not.toHaveBeenCalledWith('event.isArchived = :isArchived', {
        isArchived: false,
      });
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
      expect(result.hasServerPassword).toBe(true);
      expect(result).not.toHaveProperty('serverPassword');
    });

    it('404s an archived event for a caller without ManageEvents (T-0097)', async () => {
      events.findOne.mockResolvedValue(buildEvent({ isArchived: true }));
      authz.can.mockResolvedValue(false);

      await expect(service.getForMember(user(), 'event-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(authz.can).toHaveBeenCalledWith(REGIMENT, MemberRole.Admin, Capability.ManageEvents);
    });

    it('returns an archived event to a ManageEvents holder (T-0097)', async () => {
      events.findOne.mockResolvedValue(buildEvent({ isArchived: true }));
      authz.can.mockResolvedValue(true);

      const result = await service.getForMember(user(), 'event-1');

      expect(result.id).toBe('event-1');
      expect(result.isArchived).toBe(true);
    });
  });

  describe('per-member reads (T-0100)', () => {
    it('listAttendedByMember returns the public projection, most recent first', async () => {
      const event = buildEvent();
      attendeesQb.getMany.mockResolvedValue([{ eventId: 'event-1', event }]);

      const result = await service.listAttendedByMember(user(), MEMBER);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('event-1');
      // History uses the server-redacted (public) projection.
      expect(result[0].serverName).toBeUndefined();
      expect(result[0]).not.toHaveProperty('serverPassword');
    });

    it('listRsvpsByMember reflects the member’s own RSVP on each row', async () => {
      const event = buildEvent();
      rsvpsQb.getMany.mockResolvedValue([
        {
          eventId: 'event-1',
          event,
          status: RsvpStatus.Interested,
          reminderOffsetMinutes: 15,
        },
      ]);

      const result = await service.listRsvpsByMember(user(), MEMBER);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('event-1');
      expect(result[0].myRsvp).toEqual({
        status: RsvpStatus.Interested,
        reminderOffsetMinutes: 15,
      });
      // Public projection — no server binding leaked.
      expect(result[0].serverName).toBeUndefined();
    });
  });

  describe('unarchive', () => {
    it('clears isArchived and audits event.unarchive', async () => {
      const event = buildEvent({ isArchived: true });
      events.findOne.mockResolvedValue(event);

      const result = await service.unarchive(user(), 'event-1', '1.2.3.4');

      const saved = events.save.mock.calls[0][0] as RegimentEvent;
      expect(saved.isArchived).toBe(false);
      expect(result.isArchived).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'event.unarchive' }),
      );
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

  describe('notify offsets (T-0174)', () => {
    it('carries sentAt across a wipe-and-rewrite so a fired reminder is not re-sent', async () => {
      // replaceChildren deletes and re-inserts, so an edit that re-submits the
      // SAME lead times after one already fired would resurrect it as unresolved
      // and the sweep would send a duplicate reminder for the same event.
      const alreadySent = new Date('2026-07-22T10:00:00.000Z');
      events.findOne.mockResolvedValue(buildEvent());
      notifyTxRepo.find.mockResolvedValue([
        { eventId: 'event-1', minutes: 60, sentAt: alreadySent },
      ]);

      await service.update(user(), 'event-1', { notifyOffsets: [60, 15] }, null);

      expect(notifyTxRepo.insert).toHaveBeenCalledWith([
        { eventId: 'event-1', minutes: 60, sentAt: alreadySent },
        // A newly added lead time has no prior dispatch and stays unresolved.
        { eventId: 'event-1', minutes: 15, sentAt: null },
      ]);
    });
  });

  describe('revealPassword', () => {
    it('refuses when the caller has no RSVP', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      rsvps.findOne.mockResolvedValue(null);

      await expect(service.revealPassword(user(), 'event-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses when the caller RSVP is declined', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      rsvps.findOne.mockResolvedValue({ status: RsvpStatus.Declined });

      await expect(service.revealPassword(user(), 'event-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('returns 404 when no password is set on the event', async () => {
      events.findOne.mockResolvedValue(buildEvent({ serverPassword: null }));
      rsvps.findOne.mockResolvedValue({ status: RsvpStatus.Interested });

      await expect(service.revealPassword(user(), 'event-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the decrypted password to an RSVP’d caller without auditing the reveal (T-0126)', async () => {
      events.findOne.mockResolvedValue(
        buildEvent({ serverPassword: 'hunter2', serverName: 'LORDS-1', serverRegion: 'EU' }),
      );
      rsvps.findOne.mockResolvedValue({ status: RsvpStatus.Interested });

      const result = await service.revealPassword(user(), 'event-1');

      expect(result).toEqual({
        serverName: 'LORDS-1',
        serverRegion: 'EU',
        serverPassword: 'hunter2',
      });
      // Reveals are no longer audited (T-0126) — no new event.password.reveal row.
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('listRsvpRoster (T-0127)', () => {
    it('returns each RSVP’er’s memberId/name/avatarUrl/status, sorted by name', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      rsvps.find.mockResolvedValue([
        {
          eventId: 'event-1',
          memberId: 'member-2',
          status: RsvpStatus.Tentative,
          member: { id: 'member-2', inGameName: 'Bravo', avatarUrl: 'https://cdn/b.png' },
        },
        {
          eventId: 'event-1',
          memberId: 'member-1',
          status: RsvpStatus.Interested,
          member: { id: 'member-1', inGameName: 'Alpha', avatarUrl: 'https://cdn/a.png' },
        },
      ]);

      const result = await service.listRsvpRoster(user(), 'event-1');

      // Queried with the nested discordIdentity relation for the avatar fallback.
      expect(rsvps.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'event-1' },
          relations: { member: { discordIdentity: true } },
        }),
      );
      // Sorted by name — Alpha before Bravo despite insertion order.
      expect(result).toEqual([
        {
          memberId: 'member-1',
          name: 'Alpha',
          avatarUrl: 'https://cdn/a.png',
          status: RsvpStatus.Interested,
        },
        {
          memberId: 'member-2',
          name: 'Bravo',
          avatarUrl: 'https://cdn/b.png',
          status: RsvpStatus.Tentative,
        },
      ]);
    });

    it('falls back to the linked Discord avatar, then null', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      rsvps.find.mockResolvedValue([
        {
          eventId: 'event-1',
          memberId: 'member-1',
          status: RsvpStatus.Interested,
          member: {
            id: 'member-1',
            inGameName: 'Alpha',
            avatarUrl: null,
            discordIdentity: { avatarUrl: 'https://discord/a.png' },
          },
        },
        {
          eventId: 'event-1',
          memberId: 'member-2',
          status: RsvpStatus.Tentative,
          member: { id: 'member-2', inGameName: 'Bravo', avatarUrl: null, discordIdentity: null },
        },
      ]);

      const result = await service.listRsvpRoster(user(), 'event-1');

      // Custom avatar absent → Discord avatar used.
      expect(result[0].avatarUrl).toBe('https://discord/a.png');
      // Neither custom nor Discord avatar → null.
      expect(result[1].avatarUrl).toBeNull();
    });

    it('surfaces only members that RSVP’d (rows returned by the rsvps repo)', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      // Only one member ever RSVP'd; non-RSVP'ers have no row and are absent.
      rsvps.find.mockResolvedValue([
        {
          eventId: 'event-1',
          memberId: 'member-1',
          status: RsvpStatus.Interested,
          member: { id: 'member-1', inGameName: 'Alpha', avatarUrl: null },
        },
      ]);

      const result = await service.listRsvpRoster(user(), 'event-1');

      expect(result).toHaveLength(1);
      expect(result.map((r) => r.memberId)).toEqual(['member-1']);
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
      members.find.mockResolvedValue([{ id: 'member-1', inGameName: 'Alpha' }]);

      await expect(
        service.addAttendees(user(), 'event-1', { memberIds: ['member-1', 'stranger'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(attendees.insert).not.toHaveBeenCalled();
    });

    it('idempotently inserts only members not already checked in', async () => {
      events.findOne.mockResolvedValue(buildEvent());
      members.find.mockResolvedValue([
        { id: 'member-1', inGameName: 'Alpha' },
        { id: 'member-2', inGameName: 'Bravo' },
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

  describe('reanchor (T-0163)', () => {
    /** The wall clock a pre-T-0156 row encodes: its stored instant read as UTC. */
    const WALL = '2026-07-20T21:57:00';
    const STORED = new Date('2026-07-20T21:57:00.000Z');

    /** An event damaged by the pre-T-0156 write path: right label, wrong instant. */
    const damaged = (overrides: Partial<RegimentEvent> = {}): RegimentEvent =>
      buildEvent({ timezone: 'America/New_York', startsAt: STORED, ...overrides });

    /** The (criteria, patch) pairs handed to the repository, in write order. */
    const writes = () =>
      eventTxRepo.update.mock.calls as [{ id: string }, { startsAt: Date; endsAt: Date | null }][];

    it('moves the instant onto the stored wall clock and leaves the timezone alone', async () => {
      events.findOne.mockResolvedValue(damaged());

      const result = await service.reanchor(user(), 'event-1', { expectStartsAtLocal: WALL }, null);

      // 21:57 was written as 21:57Z; in New York that wall clock is 01:57Z next day.
      expect(writes()[0][0]).toEqual({ id: 'event-1', regimentId: REGIMENT });
      expect(writes()[0][1]).toEqual({
        startsAt: new Date('2026-07-21T01:57:00.000Z'),
        endsAt: null,
      });
      // The label was always right — only the instant was wrong.
      expect(result.timezone).toBe('America/New_York');
      expect(result.startsAt).toBe('2026-07-21T01:57:00.000Z');
    });

    it('audits event.reanchor with the before/after snapshot', async () => {
      events.findOne.mockResolvedValue(damaged());

      await service.reanchor(user(), 'event-1', { expectStartsAtLocal: WALL }, '1.2.3.4');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'event.reanchor',
          regimentId: REGIMENT,
          before: expect.objectContaining({
            startsAt: '2026-07-20T21:57:00.000Z',
            timezone: 'America/New_York',
          }),
          after: expect.objectContaining({
            startsAt: '2026-07-21T01:57:00.000Z',
            timezone: 'America/New_York',
          }),
        }),
      );
    });

    it('rejects a wall clock that does not match the stored one, writing nothing', async () => {
      // The guard that makes a repeat run fail loudly: after the repair above the
      // row reads 2026-07-21T01:57, so the original expectation no longer matches
      // and the second call cannot double-shift it.
      events.findOne.mockResolvedValue(damaged({ startsAt: new Date('2026-07-21T01:57:00.000Z') }));

      await expect(
        service.reanchor(user(), 'event-1', { expectStartsAtLocal: WALL }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rejects a UTC event — there is no instant to shift', async () => {
      events.findOne.mockResolvedValue(damaged({ timezone: 'UTC' }));

      await expect(
        service.reanchor(user(), 'event-1', { expectStartsAtLocal: WALL }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects cascade on an event that is not a recurring template', async () => {
      events.findOne.mockResolvedValue(damaged());

      await expect(
        service.reanchor(user(), 'event-1', { expectStartsAtLocal: WALL, cascade: true }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('409s when an occurrence would land on a SOFT-DELETED sibling, writing nothing', async () => {
      // MySQL unique indexes ignore deleted_at, so a cancelled occurrence still
      // owns its slot — saving over it would raise a raw 500 instead of a 409.
      const occurrence = damaged({ id: 'occ-1', recurrenceTemplateId: 'tmpl-1' });
      const cancelled = damaged({
        id: 'occ-2',
        recurrenceTemplateId: 'tmpl-1',
        startsAt: new Date('2026-07-21T01:57:00.000Z'),
        deletedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      events.findOne.mockResolvedValue(occurrence);
      events.find.mockResolvedValue([occurrence, cancelled]);

      await expect(
        service.reanchor(user(), 'occ-1', { expectStartsAtLocal: WALL }, null),
      ).rejects.toBeInstanceOf(ConflictException);
      // The pre-flight read must include soft-deleted rows, and nothing is written.
      expect(events.find).toHaveBeenCalledWith(
        expect.objectContaining({
          withDeleted: true,
          where: { recurrenceTemplateId: 'tmpl-1', regimentId: REGIMENT },
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('translates a duplicate-key loss to the recurrence sweep into a 409, not a 500', async () => {
      events.findOne.mockResolvedValue(damaged({ id: 'occ-1', recurrenceTemplateId: 'tmpl-1' }));
      dataSource.transaction.mockRejectedValue(
        Object.assign(new Error('ER_DUP_ENTRY'), { code: 'ER_DUP_ENTRY' }),
      );

      await expect(
        service.reanchor(user(), 'occ-1', { expectStartsAtLocal: WALL }, null),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    describe('cascade ordering', () => {
      /** A template plus three weekly occurrences, all on the same wall clock. */
      const series = (timezone: string) => {
        const template = buildEvent({
          id: 'tmpl-1',
          timezone,
          startsAt: new Date('2026-07-13T21:57:00.000Z'),
          isRecurring: true,
          recurrenceActive: true,
          recurrenceCadence: RecurrenceCadence.Weekly,
          recurrenceTemplateId: null,
        });
        const occurrences = ['2026-07-20', '2026-07-27', '2026-08-03'].map((day, i) =>
          buildEvent({
            id: `occ-${i + 1}`,
            timezone,
            startsAt: new Date(`${day}T21:57:00.000Z`),
            recurrenceTemplateId: 'tmpl-1',
          }),
        );
        events.findOne.mockResolvedValue(template);
        events.find.mockResolvedValue(occurrences);
      };

      it('writes latest-first when the shift moves occurrences LATER', async () => {
        // New York is west of UTC, so every row moves forward four hours onto the
        // slot its later neighbour still holds — the last occurrence must vacate
        // first. InnoDB unique indexes are not deferrable, so ordering, not the
        // transaction, is what prevents the collision.
        series('America/New_York');

        await service.reanchor(
          user(),
          'tmpl-1',
          { expectStartsAtLocal: '2026-07-13T21:57:00', cascade: true },
          null,
        );

        expect(writes().map(([criteria]) => criteria.id)).toEqual([
          'occ-3',
          'occ-2',
          'occ-1',
          'tmpl-1',
        ]);
      });

      it('writes earliest-first when the shift moves occurrences EARLIER', async () => {
        // Berlin is east of UTC: the same series moves two hours back, so the
        // earliest row has to vacate first instead.
        series('Europe/Berlin');

        await service.reanchor(
          user(),
          'tmpl-1',
          { expectStartsAtLocal: '2026-07-13T21:57:00', cascade: true },
          null,
        );

        expect(writes().map(([criteria]) => criteria.id)).toEqual([
          'tmpl-1',
          'occ-1',
          'occ-2',
          'occ-3',
        ]);
        // Every row keeps its wall clock: 21:57 Berlin is 19:57Z.
        expect(writes().map(([, patch]) => patch.startsAt.toISOString())).toEqual([
          '2026-07-13T19:57:00.000Z',
          '2026-07-20T19:57:00.000Z',
          '2026-07-27T19:57:00.000Z',
          '2026-08-03T19:57:00.000Z',
        ]);
      });
    });

    it('preserves the wall-clock duration across a DST boundary', async () => {
      // startsAt and endsAt are re-derived independently, so this 24-calendar-hour
      // event over the 2026-03-08 spring-forward becomes 23 real hours instead of
      // keeping a fixed millisecond delta and ending an hour late.
      events.findOne.mockResolvedValue(
        damaged({
          startsAt: new Date('2026-03-07T12:00:00.000Z'),
          endsAt: new Date('2026-03-08T12:00:00.000Z'),
        }),
      );

      await service.reanchor(
        user(),
        'event-1',
        { expectStartsAtLocal: '2026-03-07T12:00:00' },
        null,
      );

      const [, patch] = writes()[0];
      expect(patch.startsAt).toEqual(new Date('2026-03-07T17:00:00.000Z')); // 12:00 EST
      expect(patch.endsAt).toEqual(new Date('2026-03-08T16:00:00.000Z')); // 12:00 EDT
      expect(patch.endsAt!.getTime() - patch.startsAt.getTime()).toBe(23 * 3_600_000);
    });

    it('throws NotFound for a missing / wrong-regiment event', async () => {
      events.findOne.mockResolvedValue(null);
      await expect(
        service.reanchor(user(), 'missing', { expectStartsAtLocal: WALL }, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
