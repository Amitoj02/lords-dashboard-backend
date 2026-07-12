import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscordSyncJobType } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { DiscordSyncService } from './discord-sync.service';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';

const REGIMENT = 'regiment-1';
const USER_ID = '900900900900900900';

const settings = (overrides: Partial<DiscordBotSettings> = {}): DiscordBotSettings => ({
  regimentId: REGIMENT,
  botEnabled: true,
  announcementChannelId: '111',
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
  };
  const settingsRepo = { findOne: jest.fn(), create: jest.fn((x) => x), save: jest.fn((x) => x) };
  const membersRepo = { find: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
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
      settingsRepo.findOne.mockResolvedValue(settings({ botEnabled: false }));
      expect(await service.enqueueRoleSync(REGIMENT, 'm1', USER_ID)).toBeNull();
      expect(await service.enqueueAnnounce(REGIMENT, 'hey')).toBeNull();
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

    it('routes an event announce to the event channel, falling back to the general one', async () => {
      settingsRepo.findOne.mockResolvedValue(
        settings({ eventAnnouncementChannelId: 'evt-1', announcementChannelId: 'gen-1' }),
      );
      await service.enqueueEventAnnounce(REGIMENT, 'New event');
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ channelId: 'evt-1' }) }),
      );

      jest.clearAllMocks();
      settingsRepo.findOne.mockResolvedValue(
        settings({ eventAnnouncementChannelId: null, announcementChannelId: 'gen-1' }),
      );
      await service.enqueueEventAnnounce(REGIMENT, 'New event');
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ channelId: 'gen-1' }) }),
      );
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
