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
  joinRoleId: '222',
  joinRoleName: 'Guest',
  syncRolesOnChange: true,
  kickOnBan: false,
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

  describe('enqueueMemberKick (SENSITIVE)', () => {
    it('does NOT enqueue a kick when kickOnBan is off (the default)', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ kickOnBan: false }));
      expect(await service.enqueueMemberKick(REGIMENT, USER_ID, 'spam')).toBeNull();
      expect(jobsRepo.save).not.toHaveBeenCalled();
    });

    it('enqueues a member.kick only when kickOnBan is explicitly enabled', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ kickOnBan: true }));
      const job = await service.enqueueMemberKick(REGIMENT, USER_ID, 'spam');
      expect(job).not.toBeNull();
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: DiscordSyncJobType.MemberKick }),
      );
    });
  });

  describe('best-effort contract', () => {
    it('never throws even when the settings lookup fails', async () => {
      settingsRepo.findOne.mockRejectedValue(new Error('db down'));
      await expect(service.enqueueMemberKick(REGIMENT, USER_ID, null)).resolves.toBeNull();
      await expect(service.enqueueRoleSync(REGIMENT, 'm1', USER_ID)).resolves.toBeNull();
    });
  });
});
