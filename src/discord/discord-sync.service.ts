import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { DiscordSyncJobStatus, DiscordSyncJobType } from '../common/enums';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Member } from '../members/entities/member.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';

/**
 * How many affected members ONE {@link DiscordSyncJobType.RoleRelinkExpand}
 * drain turns into per-member jobs before re-enqueuing itself with the next
 * cursor. Bounded so a 600-member regiment never materialises 600 member ids
 * (or 600 rows) in a single step: memory stays flat, the run resumes from the
 * cursor after a restart, and the operator gets a cancel point between pages.
 */
const RELINK_PAGE_SIZE = 50;

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

/** Which catalogue row a bulk Discord-role re-link fans out from. */
export type RoleRelinkSubject = 'rank' | 'medal';

/** What the caller knows when a rank/medal's Discord role mapping changed. */
export interface RoleRelinkInput {
  regimentId: string;
  subject: RoleRelinkSubject;
  subjectId: string;
  /** Human label for the batch summary (rank name / medal title). */
  subjectLabel: string;
  /** The role the subject was mapped to before the change (null = was unlinked). */
  previousRoleId: string | null;
  /** The role it is mapped to now (null = unlinked). */
  nextRoleId: string | null;
}

/**
 * The persisted payload every job of a re-link batch carries. The cursor job
 * keeps the whole descriptor (it re-enqueues itself); the per-member jobs need
 * only `memberId`/`discordUserId`/`outgoingRoleId`.
 */
export interface RoleRelinkPayload extends Record<string, unknown> {
  subject: RoleRelinkSubject;
  subjectId: string;
  subjectLabel: string;
  /** The previously-linked role to strip (T-0159). Null when there was none. */
  outgoingRoleId: string | null;
  incomingRoleId: string | null;
  /** Last member id of the previous page; null on the first page. */
  cursor: string | null;
}

/** What {@link DiscordSyncService.enqueueRoleRelink} hands back to its caller. */
export interface RoleRelinkBatch {
  batchId: string;
  /** Holders that will actually get a job (members with a linked identity). */
  affected: number;
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

  /**
   * Enqueue an EVENT announcement/reminder (T-0044): routes to the dedicated
   * event-announcements channel. No-ops when that channel is unset (the general
   * ad-hoc announcement path + its fallback channel were retired in T-0103).
   */
  async enqueueEventAnnounce(regimentId: string, content: string): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      const target = s.eventAnnouncementChannelId;
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

  /**
   * Start a bulk re-link fan-out (T-0158) after a rank/medal's Discord role
   * mapping changed — including a link, a re-point and an unlink. Enqueues
   * exactly ONE cursor job and returns; Discord is never touched inline.
   *
   * Any still-pending run for the SAME rank/medal is superseded first: its
   * per-member jobs carry an `outgoingRoleId` that stopped being the previous
   * role the moment the mapping moved again, so draining both would fight.
   *
   * Returns the batch id + the number of holders that will actually get a job,
   * so the caller can write ONE audit row for the whole action; null when
   * nothing was queued (bot off, role syncing off, no change, no holders).
   */
  async enqueueRoleRelink(input: RoleRelinkInput): Promise<RoleRelinkBatch | null> {
    return this.guarded(input.regimentId, async (s) => {
      if (!s.syncRolesOnChange) return null;
      // Re-saving the same mapping must not queue 600 no-op jobs.
      if (input.previousRoleId === input.nextRoleId) return null;

      const affected = await this.relinkHolders(input).getCount();
      if (affected === 0) return null;

      await this.supersedeRelinkBatches(input);

      const batchId = randomUUID();
      const payload: RoleRelinkPayload = {
        subject: input.subject,
        subjectId: input.subjectId,
        subjectLabel: input.subjectLabel,
        outgoingRoleId: input.previousRoleId,
        incomingRoleId: input.nextRoleId,
        cursor: null,
      };
      await this.insertJob(input.regimentId, DiscordSyncJobType.RoleRelinkExpand, payload, batchId);
      return { batchId, affected };
    });
  }

  /**
   * Expand ONE page of a re-link batch into per-member jobs and re-enqueue the
   * cursor for the next page. Called by the worker while draining the cursor
   * job.
   *
   * Deliberately NOT best-effort: a throw here is a page that did not expand,
   * and the worker's retry/backoff is the right answer (re-expanding a page is
   * harmless — the per-member job is idempotent).
   */
  async expandRelinkPage(job: DiscordSyncJob): Promise<number> {
    const p = job.payload as RoleRelinkPayload | null;
    if (!p || !job.batchId) return 0;

    // ⚠️ The gates are re-checked HERE, not only at enqueue: a fan-out spans
    // minutes, and turning the bot (or role syncing) off mid-run must stop the
    // expansion at the next page boundary rather than after all 600 members.
    const settings = await this.getSettings(job.regimentId);
    if (!settings.botEnabled || !settings.syncRolesOnChange) {
      this.logger.warn(
        `Stopping re-link batch ${job.batchId}: botEnabled/syncRolesOnChange disabled since enqueue`,
      );
      return 0;
    }

    // A cancel flips every PENDING row of the batch to Cancelled, but this
    // cursor was already claimed as `processing` and so escapes that update.
    // Re-read the batch before queueing another page, or cancel would race the
    // expansion and the run would keep growing after the operator stopped it.
    const cancelled = await this.jobs.count({
      where: {
        regimentId: job.regimentId,
        batchId: job.batchId,
        status: DiscordSyncJobStatus.Cancelled,
      },
    });
    if (cancelled > 0) return 0;

    const page = await this.relinkHolderPage(p, job.regimentId, p.cursor);
    for (const row of page) {
      await this.insertJob(
        job.regimentId,
        DiscordSyncJobType.RoleRelinkApply,
        {
          memberId: row.memberId,
          discordUserId: row.discordUserId,
          outgoingRoleId: p.outgoingRoleId,
        },
        job.batchId,
      );
    }
    // A short page is the last one; anything else means there may be more.
    if (page.length === RELINK_PAGE_SIZE) {
      const next: RoleRelinkPayload = { ...p, cursor: page[page.length - 1].memberId };
      await this.insertJob(job.regimentId, DiscordSyncJobType.RoleRelinkExpand, next, job.batchId);
    }
    return page.length;
  }

  /**
   * The members a re-link must touch: current holders of the rank/medal, INNER
   * JOINed to their Discord identity so anyone who never linked one is dropped
   * in SQL and never consumes a job slot. Soft-deleted members are excluded by
   * TypeORM's default.
   */
  private relinkHolders(input: {
    regimentId: string;
    subject: RoleRelinkSubject;
    subjectId: string;
  }): SelectQueryBuilder<Member> {
    const qb = this.members
      .createQueryBuilder('member')
      .innerJoin(DiscordIdentity, 'identity', 'identity.id = member.discordIdentityId')
      .where('member.regimentId = :regimentId', { regimentId: input.regimentId });
    if (input.subject === 'rank') {
      qb.andWhere('member.rankId = :subjectId', { subjectId: input.subjectId });
    } else {
      // A medal can be awarded to the same member more than once, so this join
      // can duplicate rows; both consumers de-duplicate (getCount() counts
      // DISTINCT ids, the page query selects DISTINCT).
      qb.innerJoin(
        MemberMedal,
        'award',
        'award.memberId = member.id AND award.medalId = :subjectId',
        { subjectId: input.subjectId },
      );
    }
    return qb;
  }

  /** One keyset page of affected holders, ordered by member id (the cursor). */
  private relinkHolderPage(
    input: { subject: RoleRelinkSubject; subjectId: string },
    regimentId: string,
    cursor: string | null,
  ): Promise<{ memberId: string; discordUserId: string }[]> {
    const qb = this.relinkHolders({ ...input, regimentId })
      .distinct(true)
      .select('member.id', 'memberId')
      .addSelect('identity.discordUserId', 'discordUserId')
      .orderBy('member.id', 'ASC')
      .limit(RELINK_PAGE_SIZE);
    if (cursor) qb.andWhere('member.id > :cursor', { cursor });
    return qb.getRawMany<{ memberId: string; discordUserId: string }>();
  }

  /**
   * Cancel any still-pending run for the SAME rank/medal. Scoped to the subject
   * on purpose: a concurrent run for a DIFFERENT catalogue row is independent,
   * and cancelling it would silently leave that row's holders on their old role.
   */
  private async supersedeRelinkBatches(input: RoleRelinkInput): Promise<void> {
    const active = await this.jobs
      .createQueryBuilder('job')
      .select('DISTINCT job.batchId', 'batchId')
      .where('job.regimentId = :regimentId', { regimentId: input.regimentId })
      .andWhere('job.status = :status', { status: DiscordSyncJobStatus.Pending })
      .andWhere('job.batchId IS NOT NULL')
      .getRawMany<{ batchId: string }>();

    for (const { batchId } of active) {
      // Every batch is seeded by a cursor job, and only that job carries the
      // subject — the per-member jobs deliberately do not, so the batch's
      // identity is read from the seed.
      const seed = await this.jobs.findOne({
        where: {
          regimentId: input.regimentId,
          batchId,
          jobType: DiscordSyncJobType.RoleRelinkExpand,
        },
        order: { createdAt: 'ASC' },
      });
      const p = seed?.payload as RoleRelinkPayload | undefined;
      if (p?.subject !== input.subject || p?.subjectId !== input.subjectId) continue;
      await this.jobs.update(
        { regimentId: input.regimentId, batchId, status: DiscordSyncJobStatus.Pending },
        {
          status: DiscordSyncJobStatus.Cancelled,
          processedAt: new Date(),
          lastError: 'Superseded by a newer re-link of the same rank/medal',
        },
      );
      this.logger.warn(
        `Superseded re-link batch ${batchId} for ${input.subject} ${input.subjectId}`,
      );
    }
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
  private async guarded<T>(
    regimentId: string,
    fn: (settings: DiscordBotSettings) => Promise<T | null>,
  ): Promise<T | null> {
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
    batchId: string | null = null,
  ): Promise<DiscordSyncJob> {
    return this.jobs.save(
      this.jobs.create({ regimentId, jobType, payload, batchId, scheduledAt: new Date() }),
    );
  }
}
