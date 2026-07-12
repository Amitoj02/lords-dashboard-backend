import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { DiscordSyncJobType } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';

/** The reshaped enlistment fields rendered into the #new-enlistments post. */
export interface EnlistmentSummary {
  applicantName: string;
  inGameName: string;
  currentRegiment: string;
  howFound: string;
  preferredClasses: string;
  skillsToImprove: string;
  representativeNote: string | null;
}

/** The audit fields rendered into the #audit-logs mirror. */
export interface AuditSummary {
  action: string;
  actorLabel: string | null;
  detail: string | null;
  severity: string;
}

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
   * ⚠️ SENSITIVE (owner decision T-0027 Q4 → reshaped by T-0035). Enqueue a
   * strip-managed-roles + apply-Ban-role job for a banned member — ONLY when the
   * owner has explicitly turned on `applyBanRoleOnBan` AND a Ban role is
   * configured (T-0034). Defaults off, so an app-side ban does NOT touch Discord
   * unless deliberately enabled. The worker re-checks both at drain time.
   */
  async enqueueMemberBanRole(
    regimentId: string,
    discordUserId: string | null,
    reason: string | null,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      if (!discordUserId || !s.applyBanRoleOnBan || !s.banRoleId) return null;
      this.logger.warn(
        `Enqueuing Discord ban-role for ${discordUserId} (applyBanRoleOnBan is ENABLED)`,
      );
      return this.insertJob(regimentId, DiscordSyncJobType.MemberBanRole, {
        discordUserId,
        reason,
      });
    });
  }

  /** Enqueue an ad-hoc announcement broadcast (defaults to the announcement channel). */
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
        content: content.slice(0, 2000),
      });
    });
  }

  /**
   * Enqueue an EVENT announcement/reminder (T-0044): routes to the dedicated
   * event-announcements channel, falling back to the general announcement
   * channel so a partially-configured bot still posts somewhere.
   */
  async enqueueEventAnnounce(regimentId: string, content: string): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      const target = s.eventAnnouncementChannelId ?? s.announcementChannelId;
      if (!target) return null;
      // Cap at Discord's 2000-char limit so a long event description can't
      // create a permanently-failing outbox job.
      return this.insertJob(regimentId, DiscordSyncJobType.Announce, {
        channelId: target,
        content: content.slice(0, 2000),
      });
    });
  }

  /**
   * Enqueue an enlistment-application post to the enlistments channel (T-0042).
   * No-ops when the bot is off or no enlistments channel is configured. The embed
   * text is composed here from the reshaped application fields.
   */
  async enqueueApplicationSubmitted(
    regimentId: string,
    summary: EnlistmentSummary,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      if (!s.enlistmentChannelId) return null;
      return this.insertJob(regimentId, DiscordSyncJobType.ApplicationSubmitted, {
        channelId: s.enlistmentChannelId,
        content: this.buildEnlistmentMessage(summary),
      });
    });
  }

  /**
   * Enqueue an audit-log entry mirror to the audit-log channel (T-0043). No-ops
   * when the bot is off or no audit-log channel is configured. The source audit
   * entry id is threaded through the payload so the worker can write the mirror
   * outcome (synced/failed) back onto that row. Returns whether a job was
   * inserted, so the caller can set the entry's initial sync status.
   */
  async enqueueAuditLog(
    regimentId: string,
    entry: AuditSummary,
    auditEntryId?: string | null,
  ): Promise<boolean> {
    const job = await this.guarded(regimentId, async (s) => {
      if (!s.auditLogChannelId) return null;
      return this.insertJob(regimentId, DiscordSyncJobType.AuditLog, {
        channelId: s.auditLogChannelId,
        content: this.buildAuditMessage(entry),
        auditEntryId: auditEntryId ?? null,
      });
    });
    return !!job;
  }

  /** Compose the enlistment-application message (Discord markdown, capped 2000). */
  private buildEnlistmentMessage(s: EnlistmentSummary): string {
    const lines = [
      '📋 **New enlistment application**',
      `**Applicant:** ${s.applicantName}`,
      `**In-game name:** ${s.inGameName}`,
      `**Current regiment:** ${s.currentRegiment}`,
      `**How they found us:** ${s.howFound}`,
      `**Preferred classes:** ${s.preferredClasses}`,
      `**Wants to improve:** ${s.skillsToImprove}`,
    ];
    if (s.representativeNote) lines.push(`**Representative note:** ${s.representativeNote}`);
    return lines.join('\n').slice(0, 2000);
  }

  /** Compose the audit-entry mirror message (Discord markdown, capped 2000). */
  private buildAuditMessage(e: AuditSummary): string {
    const actor = e.actorLabel ?? 'system';
    const detail = e.detail ? ` — ${e.detail}` : '';
    return `📝 \`[${e.severity}]\` **${e.action}** by ${actor}${detail}`.slice(0, 2000);
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

  /**
   * Enqueue a decision DM (approve/decline/hold) to an applicant. Best-effort:
   * no-ops when the bot is disabled. The content + target user id are resolved
   * by the caller; the worker delivers it as a direct message.
   */
  async enqueueApplicationDecision(
    regimentId: string,
    payload: { discordUserId: string; content: string },
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async () => {
      if (!payload.discordUserId) return null;
      return this.insertJob(regimentId, DiscordSyncJobType.ApplicationDecision, {
        discordUserId: payload.discordUserId,
        content: payload.content.slice(0, 2000),
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
