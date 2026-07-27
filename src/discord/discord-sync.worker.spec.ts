import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditLogEntry } from '../audit/entities/audit-log-entry.entity';
import {
  DiscordSyncJobStatus,
  DiscordSyncJobType,
  DiscordSyncStatus,
  MemberRole,
} from '../common/enums';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { DiscordSyncService } from './discord-sync.service';
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
  batchId: null,
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

/** The job types drain() caps per tick so a bulk fan-out cannot hog a tick. */
const BULK = new Set<string>([
  DiscordSyncJobType.RoleRelinkExpand,
  DiscordSyncJobType.RoleRelinkApply,
]);

describe('DiscordSyncWorker', () => {
  let worker: DiscordSyncWorker;

  const jobsRepo = { find: jest.fn(), save: jest.fn((x) => Promise.resolve(x)) };

  /**
   * drain() asks for the bulk slice and the rest of the tick SEPARATELY, so the
   * fake store answers by which side of the fairness split it is being asked
   * for. Replaying one array for both queries would process every job twice.
   */
  const queue = (jobs: DiscordSyncJob[]): void => {
    jobsRepo.find.mockImplementation((options?: { where?: { jobType?: { type?: string } } }) => {
      const operator = options?.where?.jobType;
      // `In([...])` is the bulk half; `Not(In([...]))` (or no filter) is the rest.
      const wantsBulk = operator?.type === 'in';
      return Promise.resolve(jobs.filter((j) => BULK.has(j.jobType) === wantsBulk));
    });
  };
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
  const sync = { expandRelinkPage: jest.fn().mockResolvedValue(0) };

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
        { provide: DiscordSyncService, useValue: sync },
      ],
    }).compile();
    worker = module.get(DiscordSyncWorker);
  });

  it('applies a due job through the gateway and records a successful operation', async () => {
    const j = job();
    queue([j]);
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
    queue([j]);
    gateway.assignRole.mockRejectedValue(new Error('rate limited'));

    await worker.drain();

    expect(j.status).toBe(DiscordSyncJobStatus.Pending);
    expect(j.attempts).toBe(1);
    expect(j.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails terminally after the last attempt: resolvable operation + audit row', async () => {
    const j = job({ attempts: 0, maxAttempts: 1 });
    queue([j]);
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
      queue([j]);
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
      queue([j]);
      gateway.assignRole.mockRejectedValue(new Error('socket hang up'));

      await worker.drain();

      expect(j.status).toBe(DiscordSyncJobStatus.Pending);
      expect(j.attempts).toBe(1);
    });

    it('still retries a rate limit (429) — that is exactly what backoff is for', async () => {
      const j = job({ attempts: 0, maxAttempts: 5 });
      queue([j]);
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
      queue([j]);
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
      queue([banJob()]);
      settingsRepo.findOne.mockResolvedValue({
        botEnabled: false,
        applyBanRoleOnBan: true,
        banRoleId: 'ban-1',
      });

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalled();
    });

    it('does NOT touch Discord when the Ban role was cleared after enqueue', async () => {
      queue([banJob()]);
      settingsRepo.findOne.mockResolvedValue({
        botEnabled: true,
        applyBanRoleOnBan: true,
        banRoleId: null,
      });

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalled();
    });

    it('strips managed roles and applies the Ban role when all gates pass', async () => {
      queue([banJob()]);
      settingsRepo.findOne.mockResolvedValue({
        botEnabled: true,
        applyBanRoleOnBan: true,
        banRoleId: 'ban-1',
        membershipRoleId: 'member-1',
      });
      ranksRepo.find.mockResolvedValue([{ discordRoleId: 'rank-1' }, { discordRoleId: null }]);
      gateway.fetchMember.mockResolvedValue({
        id: 'u9',
        roles: ['rank-1', 'member-1', 'other-role'],
        joinedAt: null,
      });
      gateway.removeRole.mockResolvedValue(undefined);
      gateway.assignRole.mockResolvedValue(undefined);

      await worker.drain();

      // Managed roles (rank-1, member-1) stripped; unmanaged 'other-role' kept.
      expect(gateway.removeRole).toHaveBeenCalledWith('u9', 'rank-1');
      expect(gateway.removeRole).toHaveBeenCalledWith('u9', 'member-1');
      expect(gateway.removeRole).not.toHaveBeenCalledWith('u9', 'other-role');
      expect(gateway.assignRole).toHaveBeenCalledWith('u9', 'ban-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'discord.member.ban_role' }),
      );
    });
  });

  it('does not re-open a job (or re-run its side effect) when post-success bookkeeping fails', async () => {
    const j = job();
    queue([j]);
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
      queue([roleSyncJob()]);
      membersRepo.findOne.mockResolvedValue({
        id: 'm1',
        regimentId: 'regiment-1',
        rankId: 'rank-1',
        bannedAt: null,
      });
      ranksRepo.findOne.mockResolvedValue({ id: 'rank-1', discordRoleId: 'rank-role-1' });
      memberMedalsRepo.find.mockResolvedValue([{ medal: { discordRoleId: 'medal-role-1' } }]);
      settingsRepo.findOne.mockResolvedValue({ membershipRoleId: 'member-1' });
      gateway.fetchMember.mockResolvedValue({ roles: [] });

      await worker.drain();

      expect(gateway.assignRole).toHaveBeenCalledWith('u1', 'rank-role-1');
      expect(gateway.assignRole).toHaveBeenCalledWith('u1', 'medal-role-1');
    });

    it('never re-grants roles to a BANNED member (would undo the ban strip)', async () => {
      queue([roleSyncJob()]);
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

    /**
     * T-0191. The Membership role replaced the old join role and INVERTED its
     * rule. The join role was assign-only and explicitly excluded from every
     * strip, because the guild-join flow owned it. The Membership role is owned
     * by roster state, so the reconcile both grants and revokes it — that is the
     * only thing that makes it mean "enrolled", which is the whole point of a
     * regiment hanging its channel permissions off one role.
     */
    const enrolled = (role: MemberRole, currentRoles: string[]) => {
      membersRepo.findOne.mockResolvedValue({
        id: 'm1',
        regimentId: 'regiment-1',
        rankId: 'rank-1',
        role,
        bannedAt: null,
      });
      ranksRepo.findOne.mockResolvedValue({ id: 'rank-1', discordRoleId: 'rank-role-1' });
      ranksRepo.find.mockResolvedValue([{ discordRoleId: 'rank-role-1' }]);
      medalsRepo.find.mockResolvedValue([]);
      memberMedalsRepo.find.mockResolvedValue([]);
      settingsRepo.findOne.mockResolvedValue({ membershipRoleId: 'member-1' });
      gateway.fetchMember.mockResolvedValue({ roles: currentRoles });
    };

    it('grants the Membership role to an enrolled member', async () => {
      queue([roleSyncJob()]);
      enrolled(MemberRole.Member, ['rank-role-1']);

      await worker.drain();

      expect(gateway.assignRole).toHaveBeenCalledWith('u1', 'member-1');
    });

    it('keeps the Membership role on a member who already has it', async () => {
      queue([roleSyncJob()]);
      enrolled(MemberRole.Member, ['rank-role-1', 'member-1']);

      await worker.drain();

      expect(gateway.removeRole).not.toHaveBeenCalledWith('u1', 'member-1');
      expect(gateway.assignRole).not.toHaveBeenCalledWith('u1', 'member-1');
    });

    it('STRIPS the Membership role from a Mercenary — they are not of the regiment', async () => {
      // The distinction the role exists to draw. A mercenary carrying it (from
      // the old join-time grant, or from having been a member once) loses it on
      // their next reconcile.
      queue([roleSyncJob()]);
      enrolled(MemberRole.Mercenary, ['rank-role-1', 'member-1']);

      await worker.drain();

      expect(gateway.removeRole).toHaveBeenCalledWith('u1', 'member-1');
      expect(gateway.assignRole).not.toHaveBeenCalledWith('u1', 'member-1');
    });

    it('never grants the Membership role to a Mercenary who lacks it', async () => {
      queue([roleSyncJob()]);
      enrolled(MemberRole.Mercenary, ['rank-role-1']);

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalledWith('u1', 'member-1');
    });

    it('strips the Membership role from a Mercenary even when roles cannot be listed', async () => {
      // The blind-sweep arm. Without the Membership role in that sweep, a
      // mercenary kept it forever on any regiment whose gateway cannot read
      // current roles.
      queue([roleSyncJob()]);
      enrolled(MemberRole.Mercenary, []);
      gateway.fetchMember.mockResolvedValue(null);

      await worker.drain();

      expect(gateway.removeRole).toHaveBeenCalledWith('u1', 'member-1');
    });

    it('strips a superseded RANK role even when the gateway cannot list current roles', async () => {
      // Without this the fallback only swept medal roles, so every promotion
      // left the old rank role in place whenever fetchMember returned null.
      queue([roleSyncJob()]);
      membersRepo.findOne.mockResolvedValue({
        id: 'm1',
        regimentId: 'regiment-1',
        rankId: 'rank-2',
        bannedAt: null,
      });
      ranksRepo.findOne.mockResolvedValue({ id: 'rank-2', discordRoleId: 'rank-role-2' });
      ranksRepo.find.mockResolvedValue([
        { discordRoleId: 'rank-role-1' },
        { discordRoleId: 'rank-role-2' },
      ]);
      memberMedalsRepo.find.mockResolvedValue([]);
      settingsRepo.findOne.mockResolvedValue({ membershipRoleId: 'member-1' });
      gateway.fetchMember.mockResolvedValue(null);

      await worker.drain();

      expect(gateway.assignRole).toHaveBeenCalledWith('u1', 'rank-role-2');
      expect(gateway.removeRole).toHaveBeenCalledWith('u1', 'rank-role-1');
      expect(gateway.removeRole).not.toHaveBeenCalledWith('u1', 'rank-role-2');
    });
  });

  describe('bulk role re-link (RoleRelinkApply)', () => {
    const applyJob = (overrides: Record<string, unknown> = {}) =>
      job({
        jobType: DiscordSyncJobType.RoleRelinkApply,
        batchId: 'batch-1',
        payload: {
          memberId: 'm1',
          discordUserId: 'u1',
          outgoingRoleId: 'old-role',
          ...overrides,
        },
      });

    const holder = (roles: string[] | null) => {
      membersRepo.findOne.mockResolvedValue({
        id: 'm1',
        regimentId: 'regiment-1',
        rankId: 'rank-1',
        // An enrolled member, so the Membership role is DESIRED and a re-link
        // must not sweep it up along with the outgoing rank role.
        role: MemberRole.Member,
        bannedAt: null,
      });
      ranksRepo.findOne.mockResolvedValue({ id: 'rank-1', discordRoleId: 'new-role' });
      ranksRepo.find.mockResolvedValue([{ discordRoleId: 'new-role' }]);
      memberMedalsRepo.find.mockResolvedValue([]);
      settingsRepo.findOne.mockResolvedValue({
        botEnabled: true,
        syncRolesOnChange: true,
        membershipRoleId: 'member-1',
      });
      gateway.fetchMember.mockResolvedValue(roles === null ? null : { roles });
      // clearAllMocks() keeps implementations, so a rejection set by a previous
      // case would leak into this one.
      gateway.assignRole.mockResolvedValue(undefined);
      gateway.removeRole.mockResolvedValue(undefined);
    };

    it('leaves the member WITH the new role and WITHOUT the previous one', async () => {
      queue([applyJob()]);
      holder(['old-role']);

      await worker.drain();

      expect(gateway.assignRole).toHaveBeenCalledWith('u1', 'new-role');
      expect(gateway.removeRole).toHaveBeenCalledWith('u1', 'old-role');
    });

    it('strips ONLY the outgoing role — unrelated manual roles survive', async () => {
      // The previous role is no longer in the rank/medal mapping, so it is not
      // in the managed set; carrying it on the payload is what makes it
      // strippable, and it must not widen the strip to anything else.
      queue([applyJob()]);
      holder(['old-role', 'some-manual-role', 'member-1']);

      await worker.drain();

      expect(gateway.removeRole).toHaveBeenCalledWith('u1', 'old-role');
      expect(gateway.removeRole).not.toHaveBeenCalledWith('u1', 'some-manual-role');
      expect(gateway.removeRole).not.toHaveBeenCalledWith('u1', 'member-1');
    });

    it('is idempotent: an already-correct member produces ZERO Discord calls', async () => {
      queue([applyJob()]);
      // Already correct now means the rank role AND the Membership role.
      holder(['new-role', 'member-1']);

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalled();
      expect(gateway.removeRole).not.toHaveBeenCalled();
    });

    it('skips a BANNED member entirely (the ban strip owns their roles)', async () => {
      queue([applyJob()]);
      holder(['old-role']);
      membersRepo.findOne.mockResolvedValue({
        id: 'm1',
        regimentId: 'regiment-1',
        rankId: 'rank-1',
        bannedAt: new Date(),
      });

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalled();
      expect(gateway.removeRole).not.toHaveBeenCalled();
    });

    it('does NOT touch Discord when role syncing was turned off after enqueue', async () => {
      // The gates are re-checked at DRAIN time, not only at enqueue: a fan-out
      // spans minutes and the operator must be able to stop it by switching off.
      queue([applyJob()]);
      holder(['old-role']);
      settingsRepo.findOne.mockResolvedValue({ botEnabled: true, syncRolesOnChange: false });

      await worker.drain();

      expect(gateway.assignRole).not.toHaveBeenCalled();
      expect(gateway.removeRole).not.toHaveBeenCalled();
    });

    it('strips the outgoing role WITHOUT a blind sweep when the gateway cannot list roles', async () => {
      queue([applyJob()]);
      holder(null);

      await worker.drain();

      expect(gateway.removeRole).toHaveBeenCalledWith('u1', 'old-role');
      expect(gateway.removeRole).toHaveBeenCalledTimes(1);
    });

    it('treats Unknown Role (10011) on the strip as permanent — no retries', async () => {
      const j = applyJob();
      queue([j]);
      holder(['old-role']);
      gateway.removeRole.mockRejectedValue(
        Object.assign(new Error('Unknown Role'), { code: 10011 }),
      );

      await worker.drain();

      expect(j.status).toBe(DiscordSyncJobStatus.Failed);
      expect(j.attempts).toBe(1);
    });

    it('keeps the per-member flood out of the operations ledger and the audit trail', async () => {
      // 600 members would otherwise mean 600 ledger rows (burying the bot-status
      // screen) and, on a role-hierarchy failure, 600 mirrored channel messages.
      queue([applyJob()]);
      holder(['old-role']);

      await worker.drain();

      expect(operationsRepo.create).not.toHaveBeenCalled();

      jest.clearAllMocks();
      const failing = applyJob();
      failing.maxAttempts = 1;
      queue([failing]);
      holder(['old-role']);
      gateway.assignRole.mockRejectedValue(new Error('boom'));

      await worker.drain();

      // A failure still needs an admin, so it stays in the resolvable ledger —
      // only the per-member audit row (and its Discord mirror) is suppressed.
      expect(operationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, resolvable: true }),
      );
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('shared-queue fairness', () => {
    it('never lets a bulk fan-out consume the whole tick', async () => {
      // A 600-job re-link sits at the head of a createdAt-ordered queue for
      // minutes; announcements, decision DMs and welcomes behind it must not.
      const bulk = Array.from({ length: 40 }, (_, i) =>
        job({
          id: `bulk-${i}`,
          jobType: DiscordSyncJobType.RoleRelinkApply,
          batchId: 'batch-1',
          createdAt: new Date(Date.now() - 60_000),
          payload: { memberId: 'm1', discordUserId: 'u1', outgoingRoleId: null },
        }),
      );
      const announce = job({
        id: 'announce-1',
        jobType: DiscordSyncJobType.Announce,
        createdAt: new Date(),
        payload: { channelId: 'c1', content: 'hello' },
      });
      queue([...bulk, announce]);
      settingsRepo.findOne.mockResolvedValue({ botEnabled: true, syncRolesOnChange: true });
      membersRepo.findOne.mockResolvedValue(null);
      gateway.sendChannelMessage.mockResolvedValue(undefined);

      await worker.drain();

      // The announcement queued LAST still went out in this very tick.
      expect(gateway.sendChannelMessage).toHaveBeenCalledWith('c1', 'hello');
      expect(announce.status).toBe(DiscordSyncJobStatus.Succeeded);
    });
  });

  describe('embed transport (T-0172)', () => {
    const embed = { title: 'New event: Muster', color: 0x3b5bdb };

    beforeEach(() => {
      gateway.sendChannelMessage.mockResolvedValue({ messageId: 'm-1' });
      gateway.sendDirectMessage.mockResolvedValue({ messageId: 'm-2' });
    });

    it('delivers an embed job AS an embed', async () => {
      queue([
        job({
          jobType: DiscordSyncJobType.ApplicationSubmitted,
          payload: { channelId: 'c1', content: '', embed },
        }),
      ]);

      await worker.drain();

      expect(gateway.sendChannelMessage).toHaveBeenCalledWith('c1', '', [embed]);
    });

    it('delivers a LEGACY content-only job as plain text, byte for byte', async () => {
      // The hard backward-compatibility requirement: rows already sitting in the
      // outbox at deploy time carry only `content`. They must reach the gateway
      // with exactly the two arguments the pre-embed code passed — no empty
      // embeds array, no third argument at all.
      const legacy = job({
        jobType: DiscordSyncJobType.Announce,
        payload: { channelId: 'c1', content: '📅 **New event: Muster**\nStarts: …' },
      });
      queue([legacy]);

      await worker.drain();

      expect(gateway.sendChannelMessage).toHaveBeenCalledWith(
        'c1',
        '📅 **New event: Muster**\nStarts: …',
      );
      expect(gateway.sendChannelMessage.mock.calls[0]).toHaveLength(2);
      expect(legacy.status).toBe(DiscordSyncJobStatus.Succeeded);
    });

    it('delivers a legacy content-only DECISION DM as plain text too', async () => {
      queue([
        job({
          jobType: DiscordSyncJobType.ApplicationDecision,
          payload: { discordUserId: 'u1', content: 'Your application was approved.' },
        }),
      ]);

      await worker.drain();

      expect(gateway.sendDirectMessage).toHaveBeenCalledWith(
        'u1',
        'Your application was approved.',
      );
      expect(gateway.sendDirectMessage.mock.calls[0]).toHaveLength(2);
    });

    it('routes an event reminder down the channel-post arm', async () => {
      queue([
        job({
          jobType: DiscordSyncJobType.EventReminder,
          payload: { channelId: 'evt-1', content: '', embed },
        }),
      ]);

      await worker.drain();

      expect(gateway.sendChannelMessage).toHaveBeenCalledWith('evt-1', '', [embed]);
    });

    it('keeps the welcome DM fallback when no channel is configured', async () => {
      queue([
        job({
          jobType: DiscordSyncJobType.Welcome,
          payload: { discordUserId: 'u1', channelId: null, content: '', embed },
        }),
      ]);

      await worker.drain();

      expect(gateway.sendChannelMessage).not.toHaveBeenCalled();
      expect(gateway.sendDirectMessage).toHaveBeenCalledWith('u1', '', [embed]);
    });

    it('still writes the audit mirror outcome back with an embed payload', async () => {
      queue([
        job({
          jobType: DiscordSyncJobType.AuditLog,
          payload: { channelId: 'aud-1', content: '', embed, auditEntryId: 'audit-1' },
        }),
      ]);

      await worker.drain();

      expect(auditEntriesRepo.update).toHaveBeenCalledWith(
        { id: 'audit-1' },
        { discordSyncStatus: DiscordSyncStatus.Synced },
      );
    });

    it('retries a failed EMBED send and records it exactly like a text send', async () => {
      // The failure path must not be special-cased for embeds: same backoff,
      // same terminal ledger row, same audit entry.
      const j = job({
        jobType: DiscordSyncJobType.ApplicationSubmitted,
        payload: { channelId: 'c1', content: '', embed },
        attempts: 0,
        maxAttempts: 5,
      });
      queue([j]);
      gateway.sendChannelMessage.mockRejectedValue(new Error('socket hang up'));

      await worker.drain();

      expect(j.status).toBe(DiscordSyncJobStatus.Pending);
      expect(j.attempts).toBe(1);
      expect(j.scheduledAt.getTime()).toBeGreaterThan(Date.now());

      jest.clearAllMocks();
      const terminal = job({
        jobType: DiscordSyncJobType.ApplicationSubmitted,
        payload: { channelId: 'c1', content: '', embed },
        attempts: 0,
        maxAttempts: 1,
      });
      queue([terminal]);
      gateway.sendChannelMessage.mockRejectedValue(new Error('socket hang up'));

      await worker.drain();

      expect(terminal.status).toBe(DiscordSyncJobStatus.Failed);
      expect(operationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: DiscordSyncJobType.ApplicationSubmitted,
          success: false,
          resolvable: true,
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'discord.sync.failed' }),
      );
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
      queue([roleSync, announce]);

      await reap();

      expect(roleSync.status).toBe(DiscordSyncJobStatus.Pending);
      expect(announce.status).toBe(DiscordSyncJobStatus.Failed);
      expect(operationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, resolvable: true }),
      );
    });
  });
});
