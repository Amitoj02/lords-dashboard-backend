import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditLogEntry } from '../audit/entities/audit-log-entry.entity';
import { DiscordSyncJobStatus, DiscordSyncJobType } from '../common/enums';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
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
  const ranksRepo = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
  const medalsRepo = { find: jest.fn().mockResolvedValue([]) };
  const memberMedalsRepo = { find: jest.fn().mockResolvedValue([]) };
  const settingsRepo = { findOne: jest.fn() };
  const auditEntriesRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const gateway = {
    assignRole: jest.fn(),
    removeRole: jest.fn(),
    fetchMember: jest.fn(),
    listChannels: jest.fn(),
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
        { provide: getRepositoryToken(Medal), useValue: medalsRepo },
        { provide: getRepositoryToken(MemberMedal), useValue: memberMedalsRepo },
        { provide: getRepositoryToken(DiscordBotSettings), useValue: settingsRepo },
        { provide: getRepositoryToken(AuditLogEntry), useValue: auditEntriesRepo },
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

  describe('permanent Discord errors are not retried', () => {
    /** A DiscordAPIError-shaped rejection: discord.js exposes a numeric `code`. */
    const discordError = (code: number, message: string): Error =>
      Object.assign(new Error(message), { code });

    // Retrying these can never succeed — the role is gone, the bot sits below the
    // target role, or the channel is invisible. Burning all 5 attempts wastes the
    // invalid-request budget that Discord bans an IP over (10k per 10 min), and
    // that ban would take down OAuth sign-in as well as the bot.
    it.each([
      [50013, 'Missing Permissions — bot role below target'],
      [50001, 'Missing Access — cannot see the channel'],
      [10011, 'Unknown Role — mapped role deleted'],
      [10007, 'Unknown Member — left the guild'],
      [50028, 'Invalid Role — managed/booster role'],
    ])('fails terminally on the FIRST attempt for code %i', async (code, message) => {
      const j = job({ attempts: 0, maxAttempts: 5 });
      jobsRepo.find.mockResolvedValue([j]);
      gateway.assignRole.mockRejectedValue(discordError(code, message));

      await worker.drain();

      expect(j.status).toBe(DiscordSyncJobStatus.Failed);
      expect(j.attempts).toBe(1);
      expect(operationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, resolvable: true }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'discord.sync.failed' }),
      );
    });

    it('still retries a transient failure that carries no Discord error code', async () => {
      const j = job({ attempts: 0, maxAttempts: 5 });
      jobsRepo.find.mockResolvedValue([j]);
      gateway.assignRole.mockRejectedValue(new Error('socket hang up'));

      await worker.drain();

      expect(j.status).toBe(DiscordSyncJobStatus.Pending);
      expect(j.attempts).toBe(1);
    });

    it('still retries a rate limit (429) — that is exactly what backoff is for', async () => {
      const j = job({ attempts: 0, maxAttempts: 5 });
      jobsRepo.find.mockResolvedValue([j]);
      gateway.assignRole.mockRejectedValue(discordError(429, 'Too Many Requests'));

      await worker.drain();

      expect(j.status).toBe(DiscordSyncJobStatus.Pending);
      expect(j.attempts).toBe(1);
    });
  });

  describe('sensitive ban-role re-check at execution time', () => {
    const banJob = () =>
      job({
        jobType: DiscordSyncJobType.MemberBanRole,
        payload: { discordUserId: 'u9', reason: 'spam' },
      });

    it('does NOT touch Discord when applyBanRoleOnBan was turned off after enqueue', async () => {
      const j = banJob();
      jobsRepo.find.mockResolvedValue([j]);
      settingsRepo.findOne.mockResolvedValue({
        botEnabled: true,
        applyBanRoleOnBan: false,
        banRoleId: 'ban-1',
      });

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalled();
      expect(j.status).toBe(DiscordSyncJobStatus.Succeeded); // resolved as a no-op
    });

    it('does NOT touch Discord when the bot was disabled after enqueue', async () => {
      jobsRepo.find.mockResolvedValue([banJob()]);
      settingsRepo.findOne.mockResolvedValue({
        botEnabled: false,
        applyBanRoleOnBan: true,
        banRoleId: 'ban-1',
      });

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalled();
    });

    it('does NOT touch Discord when the Ban role was cleared after enqueue', async () => {
      jobsRepo.find.mockResolvedValue([banJob()]);
      settingsRepo.findOne.mockResolvedValue({
        botEnabled: true,
        applyBanRoleOnBan: true,
        banRoleId: null,
      });

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalled();
    });

    it('strips managed roles and applies the Ban role when all gates pass', async () => {
      jobsRepo.find.mockResolvedValue([banJob()]);
      settingsRepo.findOne.mockResolvedValue({
        botEnabled: true,
        applyBanRoleOnBan: true,
        banRoleId: 'ban-1',
        joinRoleId: 'guest-1',
      });
      ranksRepo.find.mockResolvedValue([{ discordRoleId: 'rank-1' }, { discordRoleId: null }]);
      gateway.fetchMember.mockResolvedValue({
        id: 'u9',
        roles: ['rank-1', 'guest-1', 'other-role'],
        joinedAt: null,
      });
      gateway.removeRole.mockResolvedValue(undefined);
      gateway.assignRole.mockResolvedValue(undefined);

      await worker.drain();

      // Managed roles (rank-1, guest-1) stripped; unmanaged 'other-role' kept.
      expect(gateway.removeRole).toHaveBeenCalledWith('u9', 'rank-1');
      expect(gateway.removeRole).toHaveBeenCalledWith('u9', 'guest-1');
      expect(gateway.removeRole).not.toHaveBeenCalledWith('u9', 'other-role');
      expect(gateway.assignRole).toHaveBeenCalledWith('u9', 'ban-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'discord.member.ban_role' }),
      );
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

  describe('role reconcile (RoleSync)', () => {
    const roleSyncJob = () =>
      job({
        jobType: DiscordSyncJobType.RoleSync,
        payload: { memberId: 'm1', discordUserId: 'u1' },
      });

    it('assigns the rank role AND every held-medal role', async () => {
      jobsRepo.find.mockResolvedValue([roleSyncJob()]);
      membersRepo.findOne.mockResolvedValue({
        id: 'm1',
        regimentId: 'regiment-1',
        rankId: 'rank-1',
        bannedAt: null,
      });
      ranksRepo.findOne.mockResolvedValue({ id: 'rank-1', discordRoleId: 'rank-role-1' });
      memberMedalsRepo.find.mockResolvedValue([{ medal: { discordRoleId: 'medal-role-1' } }]);
      settingsRepo.findOne.mockResolvedValue({ joinRoleId: 'join-1' });
      gateway.fetchMember.mockResolvedValue({ roles: [] });

      await worker.drain();

      expect(gateway.assignRole).toHaveBeenCalledWith('u1', 'rank-role-1');
      expect(gateway.assignRole).toHaveBeenCalledWith('u1', 'medal-role-1');
    });

    it('never re-grants roles to a BANNED member (would undo the ban strip)', async () => {
      jobsRepo.find.mockResolvedValue([roleSyncJob()]);
      membersRepo.findOne.mockResolvedValue({
        id: 'm1',
        regimentId: 'regiment-1',
        rankId: 'rank-1',
        bannedAt: new Date(),
      });

      const processed = await worker.drain();

      expect(processed).toBe(1);
      expect(gateway.assignRole).not.toHaveBeenCalled();
      expect(gateway.removeRole).not.toHaveBeenCalled();
    });

    it('does NOT strip the assign-only join/Guest role during reconcile', async () => {
      jobsRepo.find.mockResolvedValue([roleSyncJob()]);
      membersRepo.findOne.mockResolvedValue({
        id: 'm1',
        regimentId: 'regiment-1',
        rankId: 'rank-1',
        bannedAt: null,
      });
      ranksRepo.findOne.mockResolvedValue({ id: 'rank-1', discordRoleId: 'rank-role-1' });
      ranksRepo.find.mockResolvedValue([{ discordRoleId: 'rank-role-1' }]);
      memberMedalsRepo.find.mockResolvedValue([]);
      settingsRepo.findOne.mockResolvedValue({ joinRoleId: 'join-1' });
      // Member currently holds the join role + rank role; join must be preserved.
      gateway.fetchMember.mockResolvedValue({ roles: ['join-1', 'rank-role-1'] });

      await worker.drain();

      expect(gateway.removeRole).not.toHaveBeenCalledWith('u1', 'join-1');
    });
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
      // An announce is non-idempotent (re-sending duplicates a message), so it
      // must NOT be auto-retried — it is surfaced as resolvable instead.
      const announce = job({
        id: 'j-announce',
        status: DiscordSyncJobStatus.Processing,
        jobType: DiscordSyncJobType.Announce,
      });
      jobsRepo.find.mockResolvedValue([roleSync, announce]);

      await reap();

      expect(roleSync.status).toBe(DiscordSyncJobStatus.Pending);
      expect(announce.status).toBe(DiscordSyncJobStatus.Failed);
      expect(operationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, resolvable: true }),
      );
    });
  });
});
