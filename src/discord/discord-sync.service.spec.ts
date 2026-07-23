import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscordSyncJobStatus, DiscordSyncJobType } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { DiscordSyncService, RoleRelinkPayload } from './discord-sync.service';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';

const REGIMENT = 'regiment-1';
const USER_ID = '900900900900900900';

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
  joinRoleId: '222',
  joinRoleName: 'Guest',
  banRoleId: null,
  banRoleName: null,
  syncRolesOnChange: true,
  applyBanRoleOnBan: false,
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

  /** The re-link holder query: a chainable builder over a fixed holder list. */
  let holdersQb: Record<string, jest.Mock>;

  beforeEach(async () => {
    jest.clearAllMocks();
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
      getRawMany: jest.fn().mockResolvedValue([]),
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscordSyncService,
        { provide: getRepositoryToken(DiscordSyncJob), useValue: jobsRepo },
        { provide: getRepositoryToken(DiscordBotSettings), useValue: settingsRepo },
        { provide: getRepositoryToken(Member), useValue: membersRepo },
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
      expect(await service.enqueueEventAnnounce(REGIMENT, 'hey')).toBeNull();
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
      await service.enqueueEventAnnounce(REGIMENT, 'New event');
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ channelId: 'evt-1' }) }),
      );

      jest.clearAllMocks();
      settingsRepo.findOne.mockResolvedValue(settings({ eventAnnouncementChannelId: null }));
      expect(await service.enqueueEventAnnounce(REGIMENT, 'New event')).toBeNull();
      expect(jobsRepo.create).not.toHaveBeenCalled();
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

  describe('best-effort contract', () => {
    it('never throws even when the settings lookup fails', async () => {
      settingsRepo.findOne.mockRejectedValue(new Error('db down'));
      await expect(service.enqueueMemberBanRole(REGIMENT, USER_ID, null)).resolves.toBeNull();
      await expect(service.enqueueRoleSync(REGIMENT, 'm1', USER_ID)).resolves.toBeNull();
    });
  });
});
