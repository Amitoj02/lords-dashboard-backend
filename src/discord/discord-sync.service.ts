import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { DiscordSyncJobType } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';

/**
 * Enqueue side of the Discord outbox. App mutations call these helpers instead of
 * touching Discord inline; the {@link DiscordSyncWorker} drains the jobs. EVERY
 * method is best-effort and NEVER throws to its caller — enqueuing a role sync
 * must not be able to fail a rank change, and enqueuing a kick must not be able
 * to fail a ban. Jobs are only written when the bot is enabled (and, per job
 * type, the specific switch is on), so a dormant bot silently no-ops.
 */
@Injectable()
export class DiscordSyncService {
  private readonly logger = new Logger(DiscordSyncService.name);

  constructor(
    @InjectRepository(DiscordSyncJob)
    private readonly jobs: Repository<DiscordSyncJob>,
    @InjectRepository(DiscordBotSettings)
    private readonly settings: Repository<DiscordBotSettings>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
  ) {}

  /** Load (materialising defaults) the regiment's bot settings. */
  async getSettings(regimentId: string): Promise<DiscordBotSettings> {
    const existing = await this.settings.findOne({ where: { regimentId } });
    if (existing) return existing;
    return this.settings.save(this.settings.create({ regimentId }));
  }

  /** Enqueue a full role reconciliation for one member (rank/role/medal change). */
  async enqueueRoleSync(
    regimentId: string,
    memberId: string,
    discordUserId: string | null,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      if (!discordUserId || !s.syncRolesOnChange) return null;
      return this.insertJob(regimentId, DiscordSyncJobType.RoleSync, { memberId, discordUserId });
    });
  }

  /**
   * ⚠️ SENSITIVE (owner decision T-0027 Q4). Enqueue a guild kick for a banned
   * member — ONLY when the owner has explicitly turned on `kickOnBan`. Defaults
   * off, so an app-side ban does NOT touch Discord unless deliberately enabled.
   */
  async enqueueMemberKick(
    regimentId: string,
    discordUserId: string | null,
    reason: string | null,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      if (!discordUserId || !s.kickOnBan) return null;
      this.logger.warn(`Enqueuing Discord kick for ${discordUserId} (kickOnBan is ENABLED)`);
      return this.insertJob(regimentId, DiscordSyncJobType.MemberKick, { discordUserId, reason });
    });
  }

  /** Enqueue an announcement broadcast to a channel (defaults to the configured one). */
  async enqueueAnnounce(
    regimentId: string,
    content: string,
    channelId?: string | null,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      const target = channelId ?? s.announcementChannelId;
      if (!target) return null;
      return this.insertJob(regimentId, DiscordSyncJobType.Announce, {
        channelId: target,
        content,
      });
    });
  }

  /** Enqueue the welcome message for a newly-joined member. */
  async enqueueWelcome(regimentId: string, discordUserId: string): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      const content = s.welcomeMessage ?? 'Welcome to the regiment!';
      return this.insertJob(regimentId, DiscordSyncJobType.Welcome, {
        discordUserId,
        channelId: s.welcomeChannelId,
        content,
      });
    });
  }

  /** Enqueue the join-role (Guest) assignment for a newly-joined member. */
  async enqueueJoinRole(regimentId: string, discordUserId: string): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      if (!s.joinRoleId) return null;
      return this.insertJob(regimentId, DiscordSyncJobType.RoleAssign, {
        discordUserId,
        roleId: s.joinRoleId,
      });
    });
  }

  /** Enqueue a role sync for every member with a linked Discord identity. */
  async resyncAll(regimentId: string): Promise<number> {
    try {
      const s = await this.getSettings(regimentId);
      if (!s.botEnabled) return 0;
      const members = await this.members.find({
        where: { regimentId, discordIdentityId: Not(IsNull()) },
        relations: { discordIdentity: true },
      });
      let enqueued = 0;
      for (const member of members) {
        const discordUserId = member.discordIdentity?.discordUserId;
        if (!discordUserId) continue;
        const job = await this.insertJob(regimentId, DiscordSyncJobType.RoleSync, {
          memberId: member.id,
          discordUserId,
        });
        if (job) enqueued++;
      }
      return enqueued;
    } catch (error) {
      this.logger.error(`resyncAll failed: ${(error as Error).message}`);
      return 0;
    }
  }

  /**
   * Run `fn` with the settings, but only when the bot is enabled, and never let
   * it throw — the master switch + best-effort contract live here.
   */
  private async guarded(
    regimentId: string,
    fn: (settings: DiscordBotSettings) => Promise<DiscordSyncJob | null>,
  ): Promise<DiscordSyncJob | null> {
    try {
      const settings = await this.getSettings(regimentId);
      if (!settings.botEnabled) return null;
      return await fn(settings);
    } catch (error) {
      this.logger.error(`Failed to enqueue Discord sync job: ${(error as Error).message}`);
      return null;
    }
  }

  private async insertJob(
    regimentId: string,
    jobType: DiscordSyncJobType,
    payload: Record<string, unknown>,
  ): Promise<DiscordSyncJob> {
    return this.jobs.save(
      this.jobs.create({ regimentId, jobType, payload, scheduledAt: new Date() }),
    );
  }
}
