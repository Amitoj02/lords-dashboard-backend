import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import {
  DiscordSyncJobStatus,
  DiscordSyncJobType,
  MemberRole,
  RoleRelinkBatchState,
} from '../common/enums';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordOnboardingService } from './discord-onboarding.service';
import { DiscordRolePolicyService } from './discord-role-policy.service';
import { DiscordService } from './discord.service';
import { DiscordSyncService } from './discord-sync.service';
import { BotOperation } from './entities/bot-operation.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordConnection } from './entities/discord-connection.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';
import { DiscordGateway } from './gateway/discord-gateway';

const REGIMENT = 'regiment-1';
const BATCH = 'b0000000-0000-4000-8000-000000000000';

const user = (): AuthenticatedUser => ({
  identityId: 'identity-1',
  memberId: 'member-1',
  discordUserId: 'discord-1',
  role: MemberRole.Admin,
  regimentId: REGIMENT,
});

/** One (jobType, status) bucket as the grouped progress query returns it. */
const bucket = (
  jobType: DiscordSyncJobType,
  status: DiscordSyncJobStatus,
  count: number,
  extra: { exhausted?: number; attempted?: number } = {},
) => ({
  jobType,
  status,
  count: String(count),
  exhausted: String(extra.exhausted ?? 0),
  attempted: String(extra.attempted ?? 0),
});

const apply = (status: DiscordSyncJobStatus, count: number, extra = {}) =>
  bucket(DiscordSyncJobType.RoleRelinkApply, status, count, extra);
const expand = (status: DiscordSyncJobStatus, count: number) =>
  bucket(DiscordSyncJobType.RoleRelinkExpand, status, count);

describe('DiscordService — bulk re-link progress + cancel (T-0160)', () => {
  let service: DiscordService;

  const jobsRepo = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const connectionsRepo = { findOne: jest.fn(), save: jest.fn(), create: jest.fn() };
  const operationsRepo = { findAndCount: jest.fn(), findOne: jest.fn(), save: jest.fn() };
  const settingsRepo = { save: jest.fn() };
  const regimentsRepo = { findOne: jest.fn(), save: jest.fn() };
  const gateway = { getStatus: jest.fn(), listRoles: jest.fn(), listChannels: jest.fn() };
  const sync = { getSettings: jest.fn() };
  const onboarding = { onMemberJoin: jest.fn() };
  // LDA-H1: role-link validation. Default "linkable" so existing settings paths pass.
  const rolePolicy = { assertRoleLinkable: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn() };

  /** Point the grouped progress query at a fixed set of buckets. */
  const counts = (rows: ReturnType<typeof bucket>[]): void => {
    jobsRepo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    });
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    counts([]);
    jobsRepo.count.mockResolvedValue(1);
    jobsRepo.find.mockResolvedValue([]);
    jobsRepo.update.mockResolvedValue({ affected: 0 });
    // The seed cursor job: the only row that says what the batch is about.
    jobsRepo.findOne.mockResolvedValue({
      createdAt: new Date('2026-07-22T10:00:00.000Z'),
      processedAt: new Date('2026-07-22T10:05:00.000Z'),
      payload: {
        subject: 'rank',
        subjectId: 'rank-1',
        subjectLabel: 'Sergeant',
        outgoingRoleId: 'old-role',
        incomingRoleId: 'new-role',
        cursor: null,
      },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscordService,
        { provide: getRepositoryToken(DiscordConnection), useValue: connectionsRepo },
        { provide: getRepositoryToken(BotOperation), useValue: operationsRepo },
        { provide: getRepositoryToken(DiscordBotSettings), useValue: settingsRepo },
        { provide: getRepositoryToken(Regiment), useValue: regimentsRepo },
        { provide: getRepositoryToken(DiscordSyncJob), useValue: jobsRepo },
        { provide: DiscordGateway, useValue: gateway },
        { provide: DiscordSyncService, useValue: sync },
        { provide: DiscordOnboardingService, useValue: onboarding },
        { provide: DiscordRolePolicyService, useValue: rolePolicy },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(DiscordService);
  });

  it('derives live counts from the job rows, so an API restart does not lose the run', async () => {
    counts([
      expand(DiscordSyncJobStatus.Pending, 1),
      expand(DiscordSyncJobStatus.Succeeded, 3),
      apply(DiscordSyncJobStatus.Succeeded, 120),
      apply(DiscordSyncJobStatus.Pending, 30),
    ]);

    const progress = await service.getRelinkProgress(user(), BATCH);

    expect(progress.state).toBe(RoleRelinkBatchState.Running);
    expect(progress.expanding).toBe(true);
    expect(progress.total).toBe(150);
    expect(progress.applied).toBe(120);
    expect(progress.pending).toBe(30);
    expect(progress.finishedAt).toBeNull();
    // The descriptor comes from the seed job, not from anything held in memory.
    expect(progress.subjectLabel).toBe('Sergeant');
    expect(progress.outgoingRoleId).toBe('old-role');
  });

  it('404s for a batch id that is not this regiment’s', async () => {
    counts([]);
    await expect(service.getRelinkProgress(user(), BATCH)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reports a drained run as completed, with a finish time', async () => {
    counts([expand(DiscordSyncJobStatus.Succeeded, 2), apply(DiscordSyncJobStatus.Succeeded, 40)]);

    const progress = await service.getRelinkProgress(user(), BATCH);

    expect(progress.state).toBe(RoleRelinkBatchState.Completed);
    expect(progress.expanding).toBe(false);
    expect(progress.finishedAt).toBe('2026-07-22T10:05:00.000Z');
  });

  it('splits failures by Discord error CLASS so a hierarchy problem is diagnosable', async () => {
    // A job that failed with attempts still on the clock can only have hit a
    // PERMANENT error code — the worker short-circuits those on attempt 1.
    counts([
      expand(DiscordSyncJobStatus.Succeeded, 1),
      apply(DiscordSyncJobStatus.Succeeded, 10),
      apply(DiscordSyncJobStatus.Failed, 5, { exhausted: 2 }),
      apply(DiscordSyncJobStatus.Pending, 4, { attempted: 3 }),
    ]);
    jobsRepo.find.mockResolvedValue([
      { lastError: 'Missing Permissions' },
      { lastError: 'Missing Permissions' },
      { lastError: 'Unknown Role' },
    ]);

    const progress = await service.getRelinkProgress(user(), BATCH);

    expect(progress.failures.permanent).toBe(3);
    expect(progress.failures.exhausted).toBe(2);
    expect(progress.failures.retrying).toBe(3);
    // De-duplicated: five failures caused by one misconfiguration read as one.
    expect(progress.failures.samples).toEqual(['Missing Permissions', 'Unknown Role']);
  });

  describe('cancel', () => {
    it('stops only the QUEUED jobs and reports the run as partial, never rolled back', async () => {
      jobsRepo.update.mockResolvedValue({ affected: 30 });
      counts([
        expand(DiscordSyncJobStatus.Cancelled, 1),
        apply(DiscordSyncJobStatus.Succeeded, 120),
        apply(DiscordSyncJobStatus.Cancelled, 30),
      ]);

      const progress = await service.cancelRelink(user(), BATCH, '1.2.3.4');

      expect(jobsRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: BATCH, status: DiscordSyncJobStatus.Pending }),
        expect.objectContaining({ status: DiscordSyncJobStatus.Cancelled }),
      );
      expect(progress.state).toBe(RoleRelinkBatchState.Partial);
      expect(progress.applied).toBe(120);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'discord.role.relink.cancel',
          detail: expect.stringContaining('NOT rolled back'),
        }),
      );
    });

    it('cancelling the cursor is what stops further expansion', async () => {
      // The cursor job is one of the batch's pending rows, so the same update
      // that drops the queued members also ends the fan-out.
      jobsRepo.update.mockResolvedValue({ affected: 1 });
      counts([expand(DiscordSyncJobStatus.Cancelled, 1)]);

      const progress = await service.cancelRelink(user(), BATCH, null);

      expect(progress.expanding).toBe(false);
      expect(progress.state).toBe(RoleRelinkBatchState.Cancelled);
    });

    it('404s (and cancels nothing) for an unknown batch', async () => {
      jobsRepo.count.mockResolvedValue(0);

      await expect(service.cancelRelink(user(), BATCH, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(jobsRepo.update).not.toHaveBeenCalled();
    });
  });

  /**
   * T-0184 — the welcome message is the one optional string on this endpoint read
   * with `??` rather than for truthiness, so `''` and NULL are NOT interchangeable
   * for it: an empty string produced an empty greeting instead of the house
   * default. It normalises here; the sibling cases pin that the normalisation did
   * not spread to the columns that must keep their existing semantics.
   */
  describe('welcome-message normalisation (T-0184)', () => {
    const stored = (overrides: Partial<DiscordBotSettings> = {}) =>
      ({
        regimentId: REGIMENT,
        botEnabled: true,
        welcomeChannelId: 'channel-1',
        welcomeMessage: 'Existing greeting',
        enlistmentChannelName: 'new-enlistments',
        auditLogChannelName: 'audit-logs',
        joinRoleName: 'Guest',
        banRoleId: null,
        banRoleName: 'Cashiered',
        applyBanRoleOnBan: false,
        guildGateEnabled: false,
        ...overrides,
      }) as DiscordBotSettings;

    /** The settings row `updateSettings` handed to the repository. */
    const saved = (): DiscordBotSettings =>
      settingsRepo.save.mock.calls[0][0] as DiscordBotSettings;

    beforeEach(() => {
      sync.getSettings.mockImplementation(() => Promise.resolve(stored()));
      settingsRepo.save.mockImplementation((s: DiscordBotSettings) => Promise.resolve(s));
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['null (what the editor posts when nothing is configured)', null],
    ])('stores %s as NULL, so the send path falls back to the default', async (_l, input) => {
      await service.updateSettings(user(), { welcomeMessage: input }, null);

      expect(saved().welcomeMessage).toBeNull();
    });

    it('trims a message that has content', async () => {
      await service.updateSettings(user(), { welcomeMessage: '  Fall in!  ' }, null);

      expect(saved().welcomeMessage).toBe('Fall in!');
    });

    it('leaves the stored message untouched when the field is omitted', async () => {
      await service.updateSettings(user(), { botEnabled: true }, null);

      expect(saved().welcomeMessage).toBe('Existing greeting');
    });

    it('does not blank the other optional strings on the same endpoint', async () => {
      // The recorded regression risk: a normaliser applied one field too widely.
      // `joinRoleName` in particular is NOT NULL with a default, so a blanket
      // `|| null` across this block would break the schema, not just behaviour.
      await service.updateSettings(user(), { welcomeMessage: '' }, null);

      const row = saved();
      expect(row.welcomeChannelId).toBe('channel-1');
      expect(row.enlistmentChannelName).toBe('new-enlistments');
      expect(row.auditLogChannelName).toBe('audit-logs');
      expect(row.joinRoleName).toBe('Guest');
      expect(row.banRoleName).toBe('Cashiered');
    });
  });
});
