import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  AuditActorType,
  BotConnectionStatus,
  DiscordSyncJobStatus,
  DiscordSyncJobType,
} from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { BotOperation } from './entities/bot-operation.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordConnection } from './entities/discord-connection.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';
import { DiscordGateway } from './gateway/discord-gateway';

/** Job types whose side effect is safe to re-run after an orphaned restart. */
const IDEMPOTENT_JOB_TYPES = new Set<string>([
  DiscordSyncJobType.RoleAssign,
  DiscordSyncJobType.RoleRemove,
  DiscordSyncJobType.RoleSync,
  // Strip-roles + apply-Ban-role converges to the same end state on re-run.
  DiscordSyncJobType.MemberBanRole,
]);

/** How many jobs to drain per tick (keeps well under Discord's rate limits). */
const BATCH_SIZE = 20;
const TICK_MS = 3_000;
/** Retry backoff by attempt number (ms): ~5s, 30s, 2m, 10m, 30m. */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/**
 * Drains the {@link DiscordSyncJob} outbox on an interval and applies each job
 * through the {@link DiscordGateway}. Successes/failures are recorded to
 * bot_operations; terminal failures become resolvable operations and an audit
 * row. The interval is unref'd and cleared on shutdown, and the whole drain is
 * guarded — the worker can never crash the API (regression risk T-0020#0). The
 * drain() method is public so tests can pump it deterministically.
 */
@Injectable()
export class DiscordSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordSyncWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    @InjectRepository(DiscordSyncJob)
    private readonly jobs: Repository<DiscordSyncJob>,
    @InjectRepository(DiscordConnection)
    private readonly connections: Repository<DiscordConnection>,
    @InjectRepository(BotOperation)
    private readonly operations: Repository<BotOperation>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(Rank)
    private readonly ranks: Repository<Rank>,
    @InjectRepository(DiscordBotSettings)
    private readonly settings: Repository<DiscordBotSettings>,
    private readonly gateway: DiscordGateway,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    // Recover any jobs left mid-flight by a previous process before draining.
    void this.reapOrphanedJobs();
    this.timer = setInterval(() => void this.drain(), TICK_MS);
    // Do not keep the event loop alive for the worker (clean test/CLI exit).
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Drain one batch of due jobs. Never throws. Returns the number processed. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const due = await this.jobs.find({
        where: { status: DiscordSyncJobStatus.Pending, scheduledAt: LessThanOrEqual(new Date()) },
        order: { createdAt: 'ASC' },
        take: BATCH_SIZE,
      });
      let processed = 0;
      for (const job of due) {
        await this.processJob(job);
        processed++;
      }
      return processed;
    } catch (error) {
      this.logger.error(`Sync drain failed: ${(error as Error).message}`);
      return 0;
    } finally {
      this.draining = false;
    }
  }

  private async processJob(job: DiscordSyncJob): Promise<void> {
    // Claim the job so a re-entrant drain cannot double-process it.
    job.status = DiscordSyncJobStatus.Processing;
    await this.jobs.save(job);

    // ONLY the side effect is wrapped in the retry try. A failure here means the
    // Discord action did not complete, so retrying is safe.
    try {
      await this.dispatch(job);
    } catch (error) {
      await this.handleFailure(job, error as Error);
      return;
    }

    // The side effect succeeded. Post-success bookkeeping must NEVER re-open the
    // job — otherwise a transient DB error here would re-run a non-idempotent
    // action (a second kick / a duplicate announcement).
    job.status = DiscordSyncJobStatus.Succeeded;
    job.processedAt = new Date();
    job.lastError = null;
    try {
      await this.jobs.save(job);
      await this.recordOperation(job, true, false);
    } catch (error) {
      this.logger.error(
        `Job ${job.id} succeeded but bookkeeping failed: ${(error as Error).message}`,
      );
    }
  }

  private async dispatch(job: DiscordSyncJob): Promise<void> {
    // Payload values are JSON primitives (all strings for our job types).
    const p = (job.payload ?? {}) as Record<string, string | undefined>;
    switch (job.jobType as DiscordSyncJobType) {
      case DiscordSyncJobType.RoleAssign:
        await this.gateway.assignRole(String(p.discordUserId), String(p.roleId));
        return;
      case DiscordSyncJobType.RoleRemove:
        await this.gateway.removeRole(String(p.discordUserId), String(p.roleId));
        return;
      case DiscordSyncJobType.RoleSync:
        await this.reconcileRoles(job.regimentId, String(p.memberId), String(p.discordUserId));
        return;
      case DiscordSyncJobType.MemberBanRole: {
        // ⚠️ SENSITIVE: re-check the gate at EXECUTION time. A ban-role job can
        // sit in the queue (or in retry backoff) after being enqueued; if the
        // owner turned off applyBanRoleOnBan, cleared the Ban role, or disabled
        // the bot in the meantime, do NOT touch Discord. This is the last line of
        // defence for the owner's "re-check every time" request.
        const settings = await this.settings.findOne({ where: { regimentId: job.regimentId } });
        if (!settings?.botEnabled || !settings?.applyBanRoleOnBan) {
          this.logger.warn(
            `Skipping queued ban-role for ${String(p.discordUserId)}: applyBanRoleOnBan/botEnabled disabled since enqueue`,
          );
          return;
        }
        if (!settings.banRoleId) {
          this.logger.warn(
            `Skipping queued ban-role for ${String(p.discordUserId)}: no Ban role configured`,
          );
          return;
        }
        await this.applyBanRole(job.regimentId, String(p.discordUserId), settings.banRoleId);
        await this.audit.record({
          regimentId: job.regimentId,
          action: 'discord.member.ban_role',
          actor: { type: AuditActorType.Bot, memberId: null, label: 'Quartermaster bot' },
          detail: `Stripped managed roles and applied the Ban role to ${String(p.discordUserId)}`,
        });
        return;
      }
      case DiscordSyncJobType.Announce:
      case DiscordSyncJobType.ApplicationSubmitted:
      case DiscordSyncJobType.AuditLog:
        // Announcements, enlistment posts and audit mirrors are all pre-composed
        // channel messages (content + channelId resolved at enqueue), so they
        // drain identically.
        await this.gateway.sendChannelMessage(String(p.channelId), String(p.content));
        return;
      case DiscordSyncJobType.Welcome:
        if (p.channelId) {
          await this.gateway.sendChannelMessage(String(p.channelId), String(p.content));
        } else {
          await this.gateway.sendDirectMessage(String(p.discordUserId), String(p.content));
        }
        return;
      default:
        throw new Error(`Unknown sync job type: ${job.jobType}`);
    }
  }

  /** Assign a member's linked rank role (a minimal, extensible reconciliation). */
  private async reconcileRoles(
    regimentId: string,
    memberId: string,
    discordUserId: string,
  ): Promise<void> {
    const member = await this.members.findOne({
      where: { id: memberId, regimentId },
      relations: { rank: true },
    });
    if (!member) return;
    const rank = member.rankId
      ? await this.ranks.findOne({ where: { id: member.rankId, regimentId } })
      : null;
    if (rank?.discordRoleId) {
      await this.gateway.assignRole(discordUserId, rank.discordRoleId);
    }
  }

  /**
   * Ban-role side effect (T-0035): remove every bot-managed role the member
   * currently holds, then apply the configured Ban role. Idempotent — re-running
   * converges to the same end state (managed roles gone, Ban role present).
   */
  private async applyBanRole(
    regimentId: string,
    discordUserId: string,
    banRoleId: string,
  ): Promise<void> {
    const managed = await this.managedRoleIds(regimentId);
    const ref = await this.gateway.fetchMember(discordUserId);
    if (ref) {
      for (const roleId of ref.roles) {
        // Never strip the Ban role itself; only bot-managed roles.
        if (roleId !== banRoleId && managed.has(roleId)) {
          await this.gateway.removeRole(discordUserId, roleId);
        }
      }
    }
    await this.gateway.assignRole(discordUserId, banRoleId);
  }

  /** The set of Discord role snowflakes the bot manages (rank roles + join role). */
  private async managedRoleIds(regimentId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    const ranks = await this.ranks.find({ where: { regimentId } });
    for (const rank of ranks) {
      if (rank.discordRoleId) ids.add(rank.discordRoleId);
    }
    const settings = await this.settings.findOne({ where: { regimentId } });
    if (settings?.joinRoleId) ids.add(settings.joinRoleId);
    return ids;
  }

  private async handleFailure(job: DiscordSyncJob, error: Error): Promise<void> {
    job.attempts += 1;
    job.lastError = error.message.slice(0, 500);
    if (job.attempts < job.maxAttempts) {
      const backoff = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
      job.status = DiscordSyncJobStatus.Pending;
      job.scheduledAt = new Date(Date.now() + backoff);
      await this.jobs.save(job);
      this.logger.warn(
        `Job ${job.id} failed (attempt ${job.attempts}), retrying: ${error.message}`,
      );
      return;
    }
    // Terminal failure: surface it as a resolvable operation + audit row.
    job.status = DiscordSyncJobStatus.Failed;
    job.processedAt = new Date();
    await this.jobs.save(job);
    await this.recordOperation(job, false, true);
    await this.audit.record({
      regimentId: job.regimentId,
      action: 'discord.sync.failed',
      actor: { type: AuditActorType.Bot, memberId: null, label: 'Quartermaster bot' },
      detail: `${job.jobType} failed after ${job.attempts} attempts: ${error.message}`.slice(
        0,
        500,
      ),
    });
    this.logger.error(`Job ${job.id} failed terminally: ${error.message}`);
  }

  /**
   * On startup, recover jobs a previous process left in `processing` (it died
   * mid-flight). Single-instance, so ANY `processing` row on boot is orphaned.
   * Idempotent job types are safely re-queued; non-idempotent ones (kick/
   * announce/welcome) are NOT auto-retried — we cannot know whether the side
   * effect already fired — and are surfaced as resolvable operations instead.
   */
  private async reapOrphanedJobs(): Promise<void> {
    try {
      const orphaned = await this.jobs.find({
        where: { status: DiscordSyncJobStatus.Processing },
      });
      if (orphaned.length === 0) return;
      for (const job of orphaned) {
        if (IDEMPOTENT_JOB_TYPES.has(job.jobType)) {
          job.status = DiscordSyncJobStatus.Pending;
          job.scheduledAt = new Date();
          await this.jobs.save(job);
        } else {
          job.status = DiscordSyncJobStatus.Failed;
          job.processedAt = new Date();
          job.lastError =
            'Orphaned in-flight (process restarted); not auto-retried (non-idempotent)';
          await this.jobs.save(job);
          await this.recordOperation(job, false, true);
        }
      }
      this.logger.warn(`Reaped ${orphaned.length} orphaned in-flight sync job(s) on startup`);
    } catch (error) {
      this.logger.error(`Orphaned-job reaper failed: ${(error as Error).message}`);
    }
  }

  private async recordOperation(
    job: DiscordSyncJob,
    success: boolean,
    resolvable: boolean,
  ): Promise<void> {
    const connection = await this.ensureConnection(job.regimentId);
    await this.operations.save(
      this.operations.create({
        discordConnectionId: connection.id,
        occurredAt: new Date(),
        operation: job.jobType,
        success,
        resolvable,
      }),
    );
    connection.lastHeartbeatAt = new Date();
    await this.connections.save(connection);
  }

  /** Get-or-create the regiment's DiscordConnection row (heartbeat target). */
  private async ensureConnection(regimentId: string): Promise<DiscordConnection> {
    const existing = await this.connections.findOne({ where: { regimentId } });
    if (existing) return existing;
    return this.connections.save(
      this.connections.create({ regimentId, connectionStatus: BotConnectionStatus.Connected }),
    );
  }
}
