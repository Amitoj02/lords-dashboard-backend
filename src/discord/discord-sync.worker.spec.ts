import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { DiscordSyncJobStatus, DiscordSyncJobType } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { DiscordSyncWorker } from './discord-sync.worker';
import { BotOperation } from './entities/bot-operation.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordConnection } from './entities/discord-connection.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';
import { DiscordGateway } from './gateway/discord-gateway';

const job = (overrides: Partial<DiscordSyncJob> = {}): DiscordSyncJob => ({
  id: 'job-1',
  regimentId: 'regiment-1',
  jobType: DiscordSyncJobType.RoleAssign,
  status: DiscordSyncJobStatus.Pending,
  payload: { discordUserId: 'u1', roleId: 'r1' },
  attempts: 0,
  maxAttempts: 5,
  lastError: null,
  scheduledAt: new Date(Date.now() - 1000),
  processedAt: null,
  createdAt: new Date(),
  ...overrides,
});

describe('DiscordSyncWorker', () => {
  let worker: DiscordSyncWorker;

  const jobsRepo = { find: jest.fn(), save: jest.fn((x) => Promise.resolve(x)) };
  const connectionsRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'conn-1' }),
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve(x)),
  };
  const operationsRepo = { create: jest.fn((x) => x), save: jest.fn((x) => Promise.resolve(x)) };
  const membersRepo = { findOne: jest.fn() };
  const ranksRepo = { findOne: jest.fn() };
  const settingsRepo = { findOne: jest.fn() };
  const gateway = {
    assignRole: jest.fn(),
    removeRole: jest.fn(),
    kickMember: jest.fn(),
    sendChannelMessage: jest.fn(),
    sendDirectMessage: jest.fn(),
  };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    connectionsRepo.findOne.mockResolvedValue({ id: 'conn-1' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscordSyncWorker,
        { provide: getRepositoryToken(DiscordSyncJob), useValue: jobsRepo },
        { provide: getRepositoryToken(DiscordConnection), useValue: connectionsRepo },
        { provide: getRepositoryToken(BotOperation), useValue: operationsRepo },
        { provide: getRepositoryToken(Member), useValue: membersRepo },
        { provide: getRepositoryToken(Rank), useValue: ranksRepo },
        { provide: getRepositoryToken(DiscordBotSettings), useValue: settingsRepo },
        { provide: DiscordGateway, useValue: gateway },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    worker = module.get(DiscordSyncWorker);
  });

  it('applies a due job through the gateway and records a successful operation', async () => {
    const j = job();
    jobsRepo.find.mockResolvedValue([j]);
    gateway.assignRole.mockResolvedValue(undefined);

    const processed = await worker.drain();

    expect(processed).toBe(1);
    expect(gateway.assignRole).toHaveBeenCalledWith('u1', 'r1');
    expect(j.status).toBe(DiscordSyncJobStatus.Succeeded);
    expect(operationsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, resolvable: false }),
    );
  });

  it('reschedules a failed job with backoff while attempts remain', async () => {
    const j = job({ attempts: 0, maxAttempts: 5 });
    jobsRepo.find.mockResolvedValue([j]);
    gateway.assignRole.mockRejectedValue(new Error('rate limited'));

    await worker.drain();

    expect(j.status).toBe(DiscordSyncJobStatus.Pending);
    expect(j.attempts).toBe(1);
    expect(j.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails terminally after the last attempt: resolvable operation + audit row', async () => {
    const j = job({ attempts: 0, maxAttempts: 1 });
    jobsRepo.find.mockResolvedValue([j]);
    gateway.assignRole.mockRejectedValue(new Error('forbidden'));

    await worker.drain();

    expect(j.status).toBe(DiscordSyncJobStatus.Failed);
    expect(operationsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, resolvable: true }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'discord.sync.failed' }),
    );
  });

  it('never throws out of drain when the store misbehaves', async () => {
    jobsRepo.find.mockRejectedValue(new Error('db down'));
    await expect(worker.drain()).resolves.toBe(0);
  });

  describe('sensitive kick re-check at execution time', () => {
    const kickJob = () =>
      job({
        jobType: DiscordSyncJobType.MemberKick,
        payload: { discordUserId: 'u9', reason: 'spam' },
      });

    it('does NOT kick when kickOnBan was turned off after the job was enqueued', async () => {
      const j = kickJob();
      jobsRepo.find.mockResolvedValue([j]);
      settingsRepo.findOne.mockResolvedValue({ botEnabled: true, kickOnBan: false });

      await worker.drain();

      expect(gateway.kickMember).not.toHaveBeenCalled();
      expect(j.status).toBe(DiscordSyncJobStatus.Succeeded); // resolved as a no-op
    });

    it('does NOT kick when the bot was disabled after the job was enqueued', async () => {
      const j = kickJob();
      jobsRepo.find.mockResolvedValue([j]);
      settingsRepo.findOne.mockResolvedValue({ botEnabled: false, kickOnBan: true });

      await worker.drain();

      expect(gateway.kickMember).not.toHaveBeenCalled();
    });

    it('kicks only when both switches are still on at execution time', async () => {
      const j = kickJob();
      jobsRepo.find.mockResolvedValue([j]);
      settingsRepo.findOne.mockResolvedValue({ botEnabled: true, kickOnBan: true });
      gateway.kickMember.mockResolvedValue(undefined);

      await worker.drain();

      expect(gateway.kickMember).toHaveBeenCalledWith('u9', 'spam');
    });
  });

  it('does not re-open a job (or re-run its side effect) when post-success bookkeeping fails', async () => {
    const j = job();
    jobsRepo.find.mockResolvedValue([j]);
    gateway.assignRole.mockResolvedValue(undefined);
    // The side effect succeeds, but recording the operation fails.
    operationsRepo.save.mockRejectedValueOnce(new Error('bookkeeping db error'));

    await worker.drain();

    // The job stays Succeeded (NOT reset to Pending), so it will not be retried.
    expect(j.status).toBe(DiscordSyncJobStatus.Succeeded);
    expect(gateway.assignRole).toHaveBeenCalledTimes(1);
  });

  describe('orphaned-job reaper', () => {
    const reap = () =>
      (worker as unknown as { reapOrphanedJobs(): Promise<void> }).reapOrphanedJobs();

    it('re-queues idempotent orphans and fails non-idempotent ones as resolvable', async () => {
      const roleSync = job({
        id: 'j-role',
        status: DiscordSyncJobStatus.Processing,
        jobType: DiscordSyncJobType.RoleSync,
      });
      const kick = job({
        id: 'j-kick',
        status: DiscordSyncJobStatus.Processing,
        jobType: DiscordSyncJobType.MemberKick,
      });
      jobsRepo.find.mockResolvedValue([roleSync, kick]);

      await reap();

      expect(roleSync.status).toBe(DiscordSyncJobStatus.Pending);
      expect(kick.status).toBe(DiscordSyncJobStatus.Failed);
      expect(operationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, resolvable: true }),
      );
    });
  });
});
