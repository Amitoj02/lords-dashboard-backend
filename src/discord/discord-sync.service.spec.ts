import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscordSyncJobStatus, DiscordSyncJobType } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { EventAnnouncePayload } from './discord-job-payloads';
import { DiscordSyncService, EventSummary, RoleRelinkPayload } from './discord-sync.service';
import { EventAnnouncementService } from './event-announcement.service';
import { DiscordEmbed } from './gateway/discord-gateway';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';

const REGIMENT = 'regiment-1';
const USER_ID = '900900900900900900';
const EVENT_ID = 'evt000000001';

const settings = (overrides: Partial<DiscordBotSettings> = {}): DiscordBotSettings => ({
  regimentId: REGIMENT,
  botEnabled: true,
  welcomeChannelId: null,
  welcomeMessage: 'hi',
  enlistmentChannelId: null,
  enlistmentChannelName: null,
  auditLogChannelId: null,
  auditLogChannelName: null,
  eventAnnouncementChannelId: null,
  eventAnnouncementChannelName: null,
  gallerySubmissionChannelId: null,
  gallerySubmissionChannelName: null,
  galleryApprovedChannelId: null,
  galleryApprovedChannelName: null,
  membershipRoleId: '222',
  membershipRoleName: 'Member',
  banRoleId: null,
  banRoleName: null,
  syncRolesOnChange: true,
  applyBanRoleOnBan: false,
  guildGateEnabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('DiscordSyncService', () => {
  let service: DiscordSyncService;

  const jobsRepo = {
    create: jest.fn((x: Partial<DiscordSyncJob>) => x),
    save: jest.fn((x: Partial<DiscordSyncJob>) => Promise.resolve({ ...x, id: 'job-1' })),
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn(),
  };
  const settingsRepo = { findOne: jest.fn(), create: jest.fn((x) => x), save: jest.fn((x) => x) };
  const membersRepo = { find: jest.fn(), createQueryBuilder: jest.fn() };
  const regimentsRepo = { findOne: jest.fn() };
  /** The Applicant rank, whose linked role IS the Applicant role (T-0192). */
  const ranksRepo = { findOne: jest.fn() };

  /** The embed a producer composed, read straight off the saved job payload. */
  const savedEmbed = (call = 0): DiscordEmbed =>
    (jobsRepo.create.mock.calls[call][0] as { payload: { embed: DiscordEmbed } }).payload.embed;

  const event = (overrides: Partial<EventSummary> = {}): EventSummary => ({
    title: 'Line Battle',
    description: 'Bring your muskets.',
    startsAt: '2026-08-01T19:00:00.000Z',
    endsAt: '2026-08-01T21:00:00.000Z',
    timezone: 'America/Toronto',
    bannerUrl: 'https://cdn.example.com/banner.png',
    eventType: 'One-off',
    roster: { attending: ['<@1>', 'Nolt'], tentative: ['<@2>'], declined: [] },
    ...overrides,
  });

  /** The event ROW the producer reads back before composing (T-0205). */
  const eventRow = (overrides: Partial<RegimentEvent> = {}) =>
    ({
      id: EVENT_ID,
      regimentId: REGIMENT,
      title: 'Line Battle',
      announceRoleId: null,
      ...overrides,
    }) as RegimentEvent;

  /**
   * The announcement reader, stubbed. The producer no longer takes a projection
   * — it takes an id and asks this service what the event looks like RIGHT NOW,
   * which is what lets a re-render see RSVPs made after the job was queued.
   */
  const announcements = {
    loadEvent: jest.fn(),
    summaryFor: jest.fn(),
    findDelivery: jest.fn(),
    pingTargets: jest.fn(),
    recordDelivery: jest.fn(),
    recordThread: jest.fn(),
    markClosed: jest.fn(),
  };

  /** The re-link holder query: a chainable builder over a fixed holder list. */
  let holdersQb: Record<string, jest.Mock>;

  beforeEach(async () => {
    jest.clearAllMocks();
    regimentsRepo.findOne.mockResolvedValue({
      id: REGIMENT,
      name: 'The Lords',
      accentTone: 'crimson',
      bannerUrl: 'https://cdn.example.com/regiment-banner.png',
      crestUrl: 'https://cdn.example.com/crest.png',
    });
    holdersQb = {
      innerJoin: jest.fn(() => holdersQb),
      where: jest.fn(() => holdersQb),
      andWhere: jest.fn(() => holdersQb),
      distinct: jest.fn(() => holdersQb),
      select: jest.fn(() => holdersQb),
      addSelect: jest.fn(() => holdersQb),
      orderBy: jest.fn(() => holdersQb),
      limit: jest.fn(() => holdersQb),
      getCount: jest.fn().mockResolvedValue(0),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    membersRepo.createQueryBuilder.mockReturnValue(holdersQb);
    jobsRepo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
      getRawMany: jest.fn().mockResolvedValue([]),
    });
    announcements.loadEvent.mockResolvedValue(eventRow());
    announcements.summaryFor.mockResolvedValue(event());
    announcements.findDelivery.mockResolvedValue(null);
    announcements.pingTargets.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscordSyncService,
        { provide: getRepositoryToken(DiscordSyncJob), useValue: jobsRepo },
        { provide: getRepositoryToken(DiscordBotSettings), useValue: settingsRepo },
        { provide: getRepositoryToken(Member), useValue: membersRepo },
        { provide: getRepositoryToken(Rank), useValue: ranksRepo },
        { provide: getRepositoryToken(Regiment), useValue: regimentsRepo },
        { provide: EventAnnouncementService, useValue: announcements },
      ],
    }).compile();
    service = module.get(DiscordSyncService);
  });

  describe('master switch (botEnabled)', () => {
    it('enqueues NOTHING when the bot is disabled', async () => {
      settingsRepo.findOne.mockResolvedValue(
        settings({ botEnabled: false, eventAnnouncementChannelId: 'evt-1' }),
      );
      expect(await service.enqueueRoleSync(REGIMENT, 'm1', USER_ID)).toBeNull();
      expect(await service.enqueueEventAnnounce(REGIMENT, EVENT_ID)).toBeNull();
      expect(jobsRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('enqueueRoleSync', () => {
    it('enqueues a role.sync when enabled + syncRolesOnChange + linked', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      const job = await service.enqueueRoleSync(REGIMENT, 'm1', USER_ID);
      expect(job).not.toBeNull();
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: DiscordSyncJobType.RoleSync, regimentId: REGIMENT }),
      );
    });

    it('no-ops when the member has no linked Discord identity', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      expect(await service.enqueueRoleSync(REGIMENT, 'm1', null)).toBeNull();
      expect(jobsRepo.save).not.toHaveBeenCalled();
    });

    it('no-ops when syncRolesOnChange is off', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ syncRolesOnChange: false }));
      expect(await service.enqueueRoleSync(REGIMENT, 'm1', USER_ID)).toBeNull();
    });
  });

  describe('enqueueMemberBanRole (SENSITIVE)', () => {
    it('does NOT enqueue when applyBanRoleOnBan is off (the default)', async () => {
      settingsRepo.findOne.mockResolvedValue(
        settings({ applyBanRoleOnBan: false, banRoleId: '999' }),
      );
      expect(await service.enqueueMemberBanRole(REGIMENT, USER_ID, 'spam')).toBeNull();
      expect(jobsRepo.save).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when enabled but no Ban role is configured', async () => {
      settingsRepo.findOne.mockResolvedValue(
        settings({ applyBanRoleOnBan: true, banRoleId: null }),
      );
      expect(await service.enqueueMemberBanRole(REGIMENT, USER_ID, 'spam')).toBeNull();
      expect(jobsRepo.save).not.toHaveBeenCalled();
    });

    it('enqueues a member.ban_role only when enabled AND a Ban role is set', async () => {
      settingsRepo.findOne.mockResolvedValue(
        settings({ applyBanRoleOnBan: true, banRoleId: '999' }),
      );
      const job = await service.enqueueMemberBanRole(REGIMENT, USER_ID, 'spam');
      expect(job).not.toBeNull();
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: DiscordSyncJobType.MemberBanRole }),
      );
    });
  });

  /**
   * T-0192. The Applicant role is resolved through the RANK it is linked to
   * rather than a settings column, so an admin configures it in the same Ranks
   * & Medals screen as every other role link and there is no second place for
   * it to be half-configured.
   */
  describe('enqueueApplicantRole', () => {
    const linked = () => ranksRepo.findOne.mockResolvedValue({ discordRoleId: 'applicant-role' });

    it('adds the role linked to the Applicant RANK', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      linked();

      await service.enqueueApplicantRole(REGIMENT, USER_ID, 'add');

      expect(ranksRepo.findOne).toHaveBeenCalledWith({
        where: { regimentId: REGIMENT, name: 'Applicant' },
      });
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: DiscordSyncJobType.RoleAssign,
          payload: { discordUserId: USER_ID, roleId: 'applicant-role' },
        }),
      );
    });

    it('removes it on a decision', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      linked();

      await service.enqueueApplicantRole(REGIMENT, USER_ID, 'remove');

      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: DiscordSyncJobType.RoleRemove }),
      );
    });

    it('no-ops when the Applicant rank has no linked role — the state production is in', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      ranksRepo.findOne.mockResolvedValue({ discordRoleId: null });

      expect(await service.enqueueApplicantRole(REGIMENT, USER_ID, 'add')).toBeNull();
      expect(jobsRepo.save).not.toHaveBeenCalled();
    });

    it('no-ops when the Applicant rank is missing from the ladder entirely', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      ranksRepo.findOne.mockResolvedValue(null);

      expect(await service.enqueueApplicantRole(REGIMENT, USER_ID, 'add')).toBeNull();
    });

    it('no-ops for an applicant with no linked Discord account', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      linked();

      expect(await service.enqueueApplicantRole(REGIMENT, null, 'add')).toBeNull();
      // Never even looks the rank up — nothing to assign it to.
      expect(ranksRepo.findOne).not.toHaveBeenCalled();
    });
  });

  /** T-0195 — the two gallery channels. */
  describe('gallery channel routing', () => {
    const item = {
      id: 'gal000000001',
      title: 'The charge at dawn',
      caption: null,
      type: 'image',
      authorName: 'Jane',
      imageUrl: 'https://cdn.example.com/a.png',
      shareUrl: 'https://lords.example/gallery/gal000000001',
      fileCount: 1,
      submittedAt: '2026-07-01T10:00:00.000Z',
    };

    it('routes a submission to the REVIEW channel (no-op without one)', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ gallerySubmissionChannelId: null }));
      expect(await service.enqueueGallerySubmitted(REGIMENT, item)).toBeNull();

      settingsRepo.findOne.mockResolvedValue(settings({ gallerySubmissionChannelId: 'review-1' }));
      await service.enqueueGallerySubmitted(REGIMENT, item);

      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: DiscordSyncJobType.GallerySubmitted }),
      );
      expect(savedEmbed().title).toContain('awaiting review');
    });

    it('carries the playable url into the REVIEW channel too', async () => {
      // The reviewer has to be able to watch the clip they are passing; an
      // embed neither plays a video nor unfurls a link.
      settingsRepo.findOne.mockResolvedValue(settings({ gallerySubmissionChannelId: 'review-1' }));

      await service.enqueueGallerySubmitted(REGIMENT, {
        ...item,
        type: 'link',
        playableUrl: 'https://youtu.be/abc',
      });

      const payload = (jobsRepo.create.mock.calls[0][0] as { payload: { mediaUrl: string } })
        .payload;
      expect(payload.mediaUrl).toBe('https://youtu.be/abc');
    });

    it('routes an approval to the SHOWCASE channel and carries the playable url', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ galleryApprovedChannelId: 'show-1' }));

      await service.enqueueGalleryApproved(REGIMENT, {
        ...item,
        type: 'video',
        playableUrl: 'https://cdn.example.com/clip.mp4',
        approvedByName: 'Officer Reid',
      });

      const payload = (
        jobsRepo.create.mock.calls[0][0] as { payload: { channelId: string; mediaUrl: string } }
      ).payload;
      expect(payload.channelId).toBe('show-1');
      // Discord builds a player from a bare URL in the CONTENT, never from an
      // embed — so the worker needs it carried separately.
      expect(payload.mediaUrl).toBe('https://cdn.example.com/clip.mp4');
      expect(savedEmbed().fields?.map((f) => f.name)).toContain('Approved by');
    });

    it('does not name an approver on a PENDING post', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ gallerySubmissionChannelId: 'review-1' }));

      await service.enqueueGallerySubmitted(REGIMENT, { ...item, approvedByName: 'Officer Reid' });

      expect(savedEmbed().fields?.map((f) => f.name)).not.toContain('Approved by');
    });
  });

  describe('per-purpose channel routing', () => {
    it('routes an enlistment post to the enlistments channel (no-op without one)', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ enlistmentChannelId: null }));
      const summary = {
        applicantName: 'Jane',
        inGameName: 'JaneG',
        currentRegiment: 'None',
        howFound: 'Discord',
        preferredClasses: 'Line',
        skillsToImprove: 'Melee',
        representativeNote: null,
      };
      expect(await service.enqueueApplicationSubmitted(REGIMENT, summary)).toBeNull();

      settingsRepo.findOne.mockResolvedValue(settings({ enlistmentChannelId: 'enl-1' }));
      await service.enqueueApplicationSubmitted(REGIMENT, summary);
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: DiscordSyncJobType.ApplicationSubmitted,
          payload: expect.objectContaining({ channelId: 'enl-1' }),
        }),
      );
    });

    it('routes an audit mirror to the audit-log channel', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ auditLogChannelId: 'aud-1' }));
      await service.enqueueAuditLog(REGIMENT, {
        action: 'member.ban',
        actorLabel: 'Owner',
        detail: 'spam',
        severity: 'warn',
      });
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: DiscordSyncJobType.AuditLog,
          payload: expect.objectContaining({ channelId: 'aud-1' }),
        }),
      );
    });

    it('routes an event announce to the event channel, and no-ops when it is unset', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: 'evt-1' }));
      await service.enqueueEventAnnounce(REGIMENT, EVENT_ID);
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ channelId: 'evt-1' }) }),
      );

      jest.clearAllMocks();
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: null }));
      expect(await service.enqueueEventAnnounce(REGIMENT, EVENT_ID)).toBeNull();
      expect(jobsRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('announcement re-render + close (T-0205)', () => {
    /** The coalescing probe: how many matching PENDING refresh jobs exist. */
    const pendingRefreshes = (count: number) => {
      jobsRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(count),
        getRawMany: jest.fn().mockResolvedValue([]),
      });
    };

    it('carries ONLY the event id, so the roster is read at drain time', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      announcements.findDelivery.mockResolvedValue({ eventId: EVENT_ID, closedAt: null });
      pendingRefreshes(0);

      await service.enqueueEventAnnouncementRefresh(REGIMENT, EVENT_ID);

      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: DiscordSyncJobType.EventAnnouncementRefresh,
          payload: { eventId: EVENT_ID },
        }),
      );
    });

    it('COALESCES: a second refresh while one is still pending is dropped', async () => {
      // Twenty people answering an announcement in a minute would otherwise queue
      // twenty message edits into Discord's per-channel rate limit. One pending
      // job already reflects every press before it drains, because it recomposes
      // from the database rather than from a frozen payload.
      settingsRepo.findOne.mockResolvedValue(settings());
      announcements.findDelivery.mockResolvedValue({ eventId: EVENT_ID, closedAt: null });
      pendingRefreshes(1);

      expect(await service.enqueueEventAnnouncementRefresh(REGIMENT, EVENT_ID)).toBeNull();
      expect(jobsRepo.create).not.toHaveBeenCalled();
    });

    it('queues NOTHING for an event that was never announced (T-0207)', async () => {
      // A cascaded re-anchor asks for a refresh per occurrence, and most have no
      // announcement at all. Discovering that with a job each would be churn.
      settingsRepo.findOne.mockResolvedValue(settings());
      announcements.findDelivery.mockResolvedValue(null);
      pendingRefreshes(0);

      expect(await service.enqueueEventAnnouncementRefresh(REGIMENT, EVENT_ID)).toBeNull();
      expect(jobsRepo.create).not.toHaveBeenCalled();
    });

    it('refuses to re-render a CLOSED announcement, so an edit cannot revive its buttons (T-0207)', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      announcements.findDelivery.mockResolvedValue({ eventId: EVENT_ID, closedAt: new Date() });
      pendingRefreshes(0);

      expect(await service.enqueueEventAnnouncementRefresh(REGIMENT, EVENT_ID)).toBeNull();
      expect(jobsRepo.create).not.toHaveBeenCalled();
    });

    it('closes an announcement once, and never one that was never posted', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());

      announcements.findDelivery.mockResolvedValue(null);
      expect(await service.enqueueEventAnnouncementClose(REGIMENT, EVENT_ID)).toBeNull();

      announcements.findDelivery.mockResolvedValue({ eventId: EVENT_ID, closedAt: new Date() });
      expect(await service.enqueueEventAnnouncementClose(REGIMENT, EVENT_ID)).toBeNull();
      expect(jobsRepo.create).not.toHaveBeenCalled();

      announcements.findDelivery.mockResolvedValue({ eventId: EVENT_ID, closedAt: null });
      expect(await service.enqueueEventAnnouncementClose(REGIMENT, EVENT_ID)).not.toBeNull();
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: DiscordSyncJobType.EventAnnouncementClose }),
      );
    });

    it('does not re-open a thread for an event that already has one', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: 'evt-1' }));
      announcements.findDelivery.mockResolvedValue({ eventId: EVENT_ID, threadId: 'thread-1' });

      await service.enqueueEventReminder(REGIMENT, EVENT_ID, 15);

      // Falls through to the plain channel reminder rather than queuing a second
      // thread — Discord refuses one, and the retry would fail permanently.
      expect((jobsRepo.create.mock.calls[0][0] as { jobType: DiscordSyncJobType }).jobType).toBe(
        DiscordSyncJobType.EventReminder,
      );
    });
  });

  describe('bulk role re-link (T-0158)', () => {
    const relink = (overrides: Record<string, unknown> = {}) =>
      service.enqueueRoleRelink({
        regimentId: REGIMENT,
        subject: 'rank',
        subjectId: 'rank-1',
        subjectLabel: 'Sergeant',
        previousRoleId: 'old-role',
        nextRoleId: 'new-role',
        ...overrides,
      });

    it('enqueues exactly ONE cursor job, never one job per member', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      holdersQb.getCount.mockResolvedValue(600);

      const batch = await relink();

      expect(batch).toEqual({ batchId: expect.any(String), affected: 600 });
      expect(jobsRepo.create).toHaveBeenCalledTimes(1);
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: DiscordSyncJobType.RoleRelinkExpand,
          batchId: batch?.batchId,
        }),
      );
    });

    it('carries the outgoing role on the payload — it is unknowable at drain time', async () => {
      // reconcileRoles recomputes the desired set from the CURRENT rank/medal
      // rows, where the previous role no longer appears; if it is not on the
      // payload, nothing can ever strip it.
      settingsRepo.findOne.mockResolvedValue(settings());
      holdersQb.getCount.mockResolvedValue(3);

      await relink();

      const payload = (jobsRepo.create.mock.calls[0][0] as { payload: RoleRelinkPayload }).payload;
      expect(payload.outgoingRoleId).toBe('old-role');
      expect(payload.incomingRoleId).toBe('new-role');
      expect(payload.cursor).toBeNull();
    });

    it('no-ops when syncRolesOnChange is off, when the bot is off, and on an unchanged role', async () => {
      holdersQb.getCount.mockResolvedValue(10);

      settingsRepo.findOne.mockResolvedValue(settings({ syncRolesOnChange: false }));
      expect(await relink()).toBeNull();

      settingsRepo.findOne.mockResolvedValue(settings({ botEnabled: false }));
      expect(await relink()).toBeNull();

      settingsRepo.findOne.mockResolvedValue(settings());
      expect(await relink({ previousRoleId: 'same', nextRoleId: 'same' })).toBeNull();

      expect(jobsRepo.save).not.toHaveBeenCalled();
    });

    it('fans out an UNLINK too — holders must lose the role that was removed', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      holdersQb.getCount.mockResolvedValue(4);

      const batch = await relink({ nextRoleId: null });

      expect(batch).not.toBeNull();
      const payload = (jobsRepo.create.mock.calls[0][0] as { payload: RoleRelinkPayload }).payload;
      expect(payload.outgoingRoleId).toBe('old-role');
      expect(payload.incomingRoleId).toBeNull();
    });

    it('cancels a still-draining run for the SAME rank, but not one for another rank', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());
      holdersQb.getCount.mockResolvedValue(5);
      jobsRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ batchId: 'batch-same' }, { batchId: 'batch-other' }]),
      });
      jobsRepo.findOne.mockImplementation((options: { where: { batchId: string } }) =>
        Promise.resolve({
          payload:
            options.where.batchId === 'batch-same'
              ? { subject: 'rank', subjectId: 'rank-1' }
              : { subject: 'rank', subjectId: 'rank-9' },
        }),
      );

      await relink();

      expect(jobsRepo.update).toHaveBeenCalledTimes(1);
      expect(jobsRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: 'batch-same' }),
        expect.objectContaining({ status: DiscordSyncJobStatus.Cancelled }),
      );
    });

    describe('page expansion', () => {
      const cursorJob = (payload: Partial<RoleRelinkPayload> = {}): DiscordSyncJob =>
        ({
          id: 'expand-1',
          regimentId: REGIMENT,
          batchId: 'batch-1',
          jobType: DiscordSyncJobType.RoleRelinkExpand,
          payload: {
            subject: 'rank',
            subjectId: 'rank-1',
            subjectLabel: 'Sergeant',
            outgoingRoleId: 'old-role',
            incomingRoleId: 'new-role',
            cursor: null,
            ...payload,
          },
        }) as unknown as DiscordSyncJob;

      const holders = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
          memberId: `m${String(i).padStart(3, '0')}`,
          discordUserId: `u${i}`,
        }));

      it('re-enqueues itself with the next cursor while a full page comes back', async () => {
        settingsRepo.findOne.mockResolvedValue(settings());
        holdersQb.getRawMany.mockResolvedValue(holders(50));

        const expanded = await service.expandRelinkPage(cursorJob());

        expect(expanded).toBe(50);
        const types = jobsRepo.create.mock.calls.map(
          (c) => (c[0] as { jobType: DiscordSyncJobType }).jobType,
        );
        expect(types.filter((t) => t === DiscordSyncJobType.RoleRelinkApply)).toHaveLength(50);
        // Exactly one successor, carrying the last member id as the cursor.
        const successor = jobsRepo.create.mock.calls
          .map((c) => c[0] as { jobType: DiscordSyncJobType; payload: RoleRelinkPayload })
          .find((j) => j.jobType === DiscordSyncJobType.RoleRelinkExpand);
        expect(successor?.payload.cursor).toBe('m049');
      });

      it('stops re-enqueuing on a short page (the run is fully fanned out)', async () => {
        settingsRepo.findOne.mockResolvedValue(settings());
        holdersQb.getRawMany.mockResolvedValue(holders(7));

        await service.expandRelinkPage(cursorJob());

        const types = jobsRepo.create.mock.calls.map(
          (c) => (c[0] as { jobType: DiscordSyncJobType }).jobType,
        );
        expect(types).not.toContain(DiscordSyncJobType.RoleRelinkExpand);
      });

      it('stops expanding when the bot was disabled AFTER the batch was queued', async () => {
        // The gate is re-checked here, not only at enqueue — a fan-out spans
        // minutes and switching the bot off has to take effect within one page.
        settingsRepo.findOne.mockResolvedValue(settings({ botEnabled: false }));
        holdersQb.getRawMany.mockResolvedValue(holders(50));

        expect(await service.expandRelinkPage(cursorJob())).toBe(0);
        expect(jobsRepo.create).not.toHaveBeenCalled();
      });

      it('stops expanding once the batch has been cancelled', async () => {
        // The cursor job is already `processing` when a cancel lands, so it
        // escapes the bulk status update; without this re-read the run would
        // keep growing after the operator stopped it.
        settingsRepo.findOne.mockResolvedValue(settings());
        holdersQb.getRawMany.mockResolvedValue(holders(50));
        jobsRepo.count.mockResolvedValue(1);

        expect(await service.expandRelinkPage(cursorJob())).toBe(0);
        expect(jobsRepo.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('embed composition (T-0172 / T-0173 / T-0174 / T-0175)', () => {
    const summary = (overrides: Record<string, unknown> = {}) => ({
      applicantName: 'Jane',
      inGameName: 'JaneG',
      currentRegiment: 'None',
      howFound: 'Discord',
      preferredClasses: 'Line',
      skillsToImprove: 'Melee',
      representativeNote: null,
      ...overrides,
    });

    it('posts an enlistment as an EMBED, not as markdown text', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ enlistmentChannelId: 'enl-1' }));

      await service.enqueueApplicationSubmitted(
        REGIMENT,
        summary({ avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png' }),
      );

      const payload = (jobsRepo.create.mock.calls[0][0] as { payload: Record<string, unknown> })
        .payload;
      expect(payload.content).toBe('');
      const embed = savedEmbed();
      expect(embed.title).toContain('New enlistment application');
      expect(embed.thumbnailUrl).toBe('https://cdn.discordapp.com/avatars/1/a.png');
      // The regiment's accent tone (crimson) colours the post.
      expect(embed.color).toBe(0x8b2c2c);
      const names = (embed.fields ?? []).map((f) => f.name);
      expect(names).toEqual([
        'In-game name',
        'Current regiment',
        'How they found us',
        'Preferred classes',
        'Wants to improve',
      ]);
    });

    it('OMITS an empty optional answer rather than rendering a blank field', async () => {
      // Discord rejects a field with an empty value (50035), so a blank optional
      // answer would fail the whole post — omission is correctness, not polish.
      settingsRepo.findOne.mockResolvedValue(settings({ enlistmentChannelId: 'enl-1' }));

      await service.enqueueApplicationSubmitted(REGIMENT, summary({ representativeNote: '   ' }));

      expect((savedEmbed().fields ?? []).map((f) => f.name)).not.toContain('Representative note');
    });

    it('degrades to NO thumbnail when the applicant has no avatar', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ enlistmentChannelId: 'enl-1' }));

      await service.enqueueApplicationSubmitted(REGIMENT, summary({ avatarUrl: null }));

      expect(savedEmbed().thumbnailUrl).toBeUndefined();
    });

    it('composes the decision DM here, keeping the officer’s custom message', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());

      await service.enqueueApplicationDecision(REGIMENT, {
        discordUserId: USER_ID,
        outcome: 'decline',
        customMessage: 'We need more line experience.',
      });

      const embed = savedEmbed();
      expect(embed.title).toContain('The Lords');
      expect(embed.description).toBe('We need more line experience.');
    });

    it('carries NO field beyond the officer’s message — the note stays with staff (T-0182)', async () => {
      // The decision DM used to render a "Note from the reviewing officer" field
      // fed from the staff-only moderator note. There is now no field at all, so
      // there is nowhere for a staff-only value to be rendered.
      settingsRepo.findOne.mockResolvedValue(settings());

      await service.enqueueApplicationDecision(REGIMENT, {
        discordUserId: USER_ID,
        outcome: 'decline',
        customMessage: 'We need more line experience.',
      });

      expect(savedEmbed().fields).toBeUndefined();
    });

    it('falls back to the per-outcome default when the officer wrote nothing', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());

      await service.enqueueApplicationDecision(REGIMENT, {
        discordUserId: USER_ID,
        outcome: 'approve',
        customMessage: '   ',
      });

      expect(savedEmbed().description).toContain('The Lords');
      expect(savedEmbed().description).toContain('approved');
    });

    it('colour-codes the gallery decline like an application decline', async () => {
      settingsRepo.findOne.mockResolvedValue(settings());

      await service.enqueueGalleryDecision(REGIMENT, {
        discordUserId: USER_ID,
        title: 'Siege of Nowhere',
        reason: 'Off-topic',
      });

      const embed = savedEmbed();
      expect(embed.title).toContain('declined');
      expect(embed.description).toContain('Siege of Nowhere');
      expect(embed.fields?.[0]).toEqual(expect.objectContaining({ value: 'Off-topic' }));
    });

    it('announces an event with a relative timestamp, the banner and the RSVP sections', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: 'evt-1' }));

      await service.enqueueEventAnnounce(REGIMENT, EVENT_ID);

      const embed = savedEmbed();
      expect(embed.title).toBe('📅 New event: Line Battle');
      expect(embed.imageUrl).toBe('https://cdn.example.com/banner.png');
      expect(embed.footer?.text).toBe('The Lords');
      const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
      expect(fields.Starts).toMatch(/^<t:\d+:R>/);
      // The wall clock is rendered in the EVENT's zone, never the process zone.
      expect(fields.Starts).toContain('15:00');
      expect(fields.Duration).toBe('2h');
      expect(fields['✅ Attending — 2']).toBe('<@1>, Nolt');
      expect(fields['❔ Tentative — 1']).toBe('<@2>');
      // Rendered even when empty: a section that vanished would make the embed's
      // shape jump on the first press.
      expect(fields['❌ Declined — 0']).toBe('—');
    });

    it('attaches the three RSVP buttons, live, to the announcement', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: 'evt-1' }));

      await service.enqueueEventAnnounce(REGIMENT, EVENT_ID);

      const payload = (
        jobsRepo.create.mock.calls[0][0] as unknown as { payload: EventAnnouncePayload }
      ).payload;
      expect(payload.components?.[0].buttons.map((b) => b.label)).toEqual([
        'Attending',
        'Tentative',
        'Declined',
      ]);
      // Live, always: changing your mind is the normal case, so a press must not
      // be the last word.
      expect(payload.components?.[0].buttons.every((b) => b.disabled === false)).toBe(true);
      expect(payload.components?.[0].buttons.map((b) => b.customId)).toEqual([
        `event-rsvp:interested:${EVENT_ID}`,
        `event-rsvp:tentative:${EVENT_ID}`,
        `event-rsvp:declined:${EVENT_ID}`,
      ]);
    });

    it('pings the announce role EXACTLY ONCE — on the announcement, never the reminder', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: 'evt-1' }));
      announcements.loadEvent.mockResolvedValue(eventRow({ announceRoleId: '777000000000000001' }));

      await service.enqueueEventAnnounce(REGIMENT, EVENT_ID);
      const announce = (
        jobsRepo.create.mock.calls[0][0] as unknown as { payload: EventAnnouncePayload }
      ).payload;
      // The mention text is in the CONTENT (an embed never pings) and the role is
      // named in the allow-list, which is the only thing that makes it notify.
      expect(announce.content).toBe('<@&777000000000000001>');
      expect(announce.mentions).toEqual({ roles: ['777000000000000001'] });

      // The lead-time notification is a THREAD ping (there is a live
      // announcement), and it must not re-ping the role.
      announcements.findDelivery.mockResolvedValue({ eventId: EVENT_ID, threadId: null });
      await service.enqueueEventReminder(REGIMENT, EVENT_ID, 60);
      const reminder = jobsRepo.create.mock.calls[1][0] as {
        jobType: DiscordSyncJobType;
        payload: Record<string, unknown>;
      };
      expect(reminder.jobType).toBe(DiscordSyncJobType.EventThreadPing);
      expect(JSON.stringify(reminder.payload)).not.toContain('777000000000000001');
    });

    it('posts a valid embed with no image when the event has no banner', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: 'evt-1' }));
      announcements.summaryFor.mockResolvedValue(event({ bannerUrl: null }));

      await service.enqueueEventAnnounce(REGIMENT, EVENT_ID);

      expect(savedEmbed().imageUrl).toBeUndefined();
      expect(savedEmbed().title).toBe('📅 New event: Line Battle');
    });

    it('NEVER leaks the event server password — there is nowhere to put one', async () => {
      // The password is gated behind an RSVP in the app; an announcement channel
      // is readable by the whole guild, so a leak here would silently retire that
      // gate. EventSummary structurally cannot carry it — this pins that even if
      // a caller tries to smuggle one through.
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: 'evt-1' }));
      announcements.summaryFor.mockResolvedValue({
        ...event({ description: 'Muster at the bridge.' }),
        serverPassword: 'hunter2',
        serverName: 'Lords Official',
      });

      await service.enqueueEventAnnounce(REGIMENT, EVENT_ID);

      const serialised = JSON.stringify(jobsRepo.create.mock.calls[0][0]);
      expect(serialised).not.toContain('hunter2');
      expect(serialised).not.toContain('serverPassword');
    });

    it('falls back to a plain reminder embed when the event was never announced', async () => {
      // No announcement means no message to hang a thread on. Degrading into a
      // channel-wide list of mentions would be the noise the thread exists to
      // contain, so it degrades to the reminder the channel always got instead.
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: 'evt-1' }));
      announcements.findDelivery.mockResolvedValue(null);

      await service.enqueueEventAnnounce(REGIMENT, EVENT_ID);
      await service.enqueueEventReminder(REGIMENT, EVENT_ID, 60);

      const announce = savedEmbed(0);
      const reminder = savedEmbed(1);
      expect(reminder.title).toContain('Reminder');
      expect(reminder.title).toContain('in 1 hour');
      expect(reminder.color).not.toBe(announce.color);
      expect((jobsRepo.create.mock.calls[1][0] as { jobType: DiscordSyncJobType }).jobType).toBe(
        DiscordSyncJobType.EventReminder,
      );
    });

    it('keeps the audit mirror COMPACT and severity-coloured', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ auditLogChannelId: 'aud-1' }));

      await service.enqueueAuditLog(
        REGIMENT,
        {
          action: 'member.ban',
          actorLabel: 'Owner',
          detail: 'spam',
          severity: 'warn',
          targetLabel: 'Pvt Smith',
          occurredAt: '2026-07-22T10:00:00.000Z',
        },
        'audit-1',
      );

      const embed = savedEmbed();
      expect(embed.title).toBe('member.ban');
      expect(embed.color).toBe(0xb8860b);
      expect(embed.fields).toHaveLength(3);
      expect(embed.thumbnailUrl).toBeUndefined();
      expect(embed.imageUrl).toBeUndefined();
      // The write-back id still rides along, untouched by the embed work.
      expect(
        (jobsRepo.create.mock.calls[0][0] as { payload: { auditEntryId: string } }).payload
          .auditEntryId,
      ).toBe('audit-1');
    });

    it('brands the welcome and keeps the DM fallback when no channel is set', async () => {
      settingsRepo.findOne.mockResolvedValue(
        settings({ welcomeChannelId: null, welcomeMessage: 'Fall in!' }),
      );

      await service.enqueueWelcome(REGIMENT, USER_ID);

      const payload = (
        jobsRepo.create.mock.calls[0][0] as { payload: { channelId: string | null } }
      ).payload;
      // Null channel is what routes the worker to the DM path — unchanged.
      expect(payload.channelId).toBeNull();
      const embed = savedEmbed();
      expect(embed.title).toBe('Welcome to The Lords');
      expect(embed.description).toBe('Fall in!');
      expect(embed.imageUrl).toBe('https://cdn.example.com/regiment-banner.png');
      // Nothing is appended to the admin's message — see buildWelcomeEmbed.
      expect(embed.fields ?? []).toEqual([]);
    });

    // ── T-0184: blank means "use the house default", on the READ side too ─────
    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['NULL', null],
    ])('greets with the house default when the stored message is %s', async (_label, stored) => {
      // `?? DEFAULT` was only nullish-safe, so a cleared editor box produced a
      // welcome embed with NO body. Rows written before the PATCH normalisation
      // are still out there, so the send path has to be correct on its own.
      settingsRepo.findOne.mockResolvedValue(settings({ welcomeMessage: stored }));

      await service.enqueueWelcome(REGIMENT, USER_ID);

      expect(savedEmbed().description).toBe('Welcome to the regiment!');
      expect(savedEmbed().description).not.toBe('');
    });

    it('uses a configured message verbatim', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ welcomeMessage: 'Fall in, lads.' }));

      await service.enqueueWelcome(REGIMENT, USER_ID);

      expect(savedEmbed().description).toBe('Fall in, lads.');
    });

    // ── T-0185: tokens expand, and admin text can never ping ─────────────────
    it('expands {user} and {regiment} against the joining member (T-0185)', async () => {
      settingsRepo.findOne.mockResolvedValue(
        settings({ welcomeMessage: 'Welcome {user} to {regiment}!' }),
      );

      await service.enqueueWelcome(REGIMENT, USER_ID);

      expect(savedEmbed().description).toBe(`Welcome <@${USER_ID}> to The Lords!`);
    });

    it('keeps admin-authored welcome text out of the message CONTENT (T-0185)', async () => {
      // THIS is the assertion that makes the injection risk unreachable. Discord
      // does not resolve @everyone/@here inside an embed, so the text is inert
      // exactly as long as it stays in `embed.description`. If a future change
      // moves it to `content` — where mentions ARE parsed and the gateway sets no
      // allowed_mentions — this fails.
      settingsRepo.findOne.mockResolvedValue(
        settings({ welcomeMessage: '@everyone @here rally for {user}' }),
      );

      await service.enqueueWelcome(REGIMENT, USER_ID);

      const payload = (jobsRepo.create.mock.calls[0][0] as { payload: { content: string } })
        .payload;
      expect(payload.content).toBe('');
      expect(savedEmbed().description).toContain('@everyone');
    });

    it('still composes a usable notification when the regiment row is missing', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ enlistmentChannelId: 'enl-1' }));
      regimentsRepo.findOne.mockResolvedValue(null);

      await service.enqueueApplicationSubmitted(REGIMENT, summary());

      expect(savedEmbed().description).toContain('the regiment');
    });
  });

  describe('best-effort contract', () => {
    it('never throws even when the settings lookup fails', async () => {
      settingsRepo.findOne.mockRejectedValue(new Error('db down'));
      await expect(service.enqueueMemberBanRole(REGIMENT, USER_ID, null)).resolves.toBeNull();
      await expect(service.enqueueRoleSync(REGIMENT, 'm1', USER_ID)).resolves.toBeNull();
    });
  });
});
