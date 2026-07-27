import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { DiscordSyncJobStatus, DiscordSyncJobType } from '../common/enums';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import { APPLICANT_RANK_NAME } from '../ranks/protected-ranks';
import { Regiment } from '../regiments/entities/regiment.entity';
import { RoleRelinkExpandPayload, RoleRelinkSubject } from './discord-job-payloads';
import {
  ApplicationDecisionOutcome,
  AuditSummary,
  EnlistmentSummary,
  EventSummary,
  GallerySummary,
  RegimentBrand,
  buildAuditEmbed,
  buildDecisionEmbed,
  buildEnlistmentEmbed,
  buildEventEmbed,
  buildGalleryDeclineEmbed,
  buildGalleryEmbed,
  buildWelcomeEmbed,
  defaultDecisionMessage,
} from './embeds/notification-embeds';
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

// The notification INPUT shapes moved to `embeds/notification-embeds.ts` with
// the composers that render them (T-0173..T-0175) — one module now owns both
// "what a notification says" and "what it needs to say it". Re-exported here so
// every existing `from '../discord/discord-sync.service'` import keeps working.
export type {
  ApplicationDecisionOutcome,
  AuditSummary,
  EnlistmentSummary,
  EventSummary,
  GallerySummary,
  RegimentBrand,
} from './embeds/notification-embeds';

/** Default welcome text when the regiment has not configured one. */
const DEFAULT_WELCOME = 'Welcome to the regiment!';

// The re-link payload shape lives with the other job payload types (T-0172).
export type { RoleRelinkSubject } from './discord-job-payloads';
export type { RoleRelinkExpandPayload as RoleRelinkPayload } from './discord-job-payloads';

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
  /**
   * The acting member, excluded from the fan-out so linking a rank/medal can never
   * grant the actor a role (LDA-H1). Null when the actor is not a roster member.
   */
  excludeMemberId?: string | null;
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
    // The Applicant role is resolved through the rank it is linked to, so the
    // admin configures it where every other role link lives (T-0192).
    @InjectRepository(Rank)
    private readonly ranks: Repository<Rank>,
    // The regiment's name/crest/banner/accent tone brand every embed (T-0173).
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
  ) {}

  /** Load (materialising defaults) the regiment's bot settings. */
  async getSettings(regimentId: string): Promise<DiscordBotSettings> {
    const existing = await this.settings.findOne({ where: { regimentId } });
    if (existing) return existing;
    return this.settings.save(this.settings.create({ regimentId }));
  }

  /**
   * The regiment's identity as the composers need it. Every enqueue that
   * produces an embed resolves this ONCE and hands it to a pure composer, which
   * is what keeps the composers database-free and unit-testable.
   *
   * Degrades rather than throws: a missing regiment row yields a neutral brand,
   * because a notification with a generic name is strictly better than a
   * notification that never goes out.
   */
  private async resolveBrand(regimentId: string): Promise<RegimentBrand> {
    const regiment = await this.regiments.findOne({ where: { id: regimentId } });
    return {
      name: regiment?.name ?? 'the regiment',
      accentTone: regiment?.accentTone ?? null,
      bannerUrl: regiment?.bannerUrl ?? null,
      crestUrl: regiment?.crestUrl ?? null,
    };
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
   * Enqueue an EVENT announcement (T-0044/T-0174): routes to the dedicated
   * event-announcements channel. No-ops when that channel is unset (the general
   * ad-hoc announcement path + its fallback channel were retired in T-0103).
   *
   * ⚠️ The caller passes an {@link EventSummary}, which has NO field for the
   * event's server password — so no code path can put one in a channel embed.
   */
  async enqueueEventAnnounce(
    regimentId: string,
    event: EventSummary,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      const target = s.eventAnnouncementChannelId;
      if (!target) return null;
      const brand = await this.resolveBrand(regimentId);
      return this.insertJob(regimentId, DiscordSyncJobType.Announce, {
        channelId: target,
        content: '',
        embed: buildEventEmbed(event, brand),
      });
    });
  }

  /**
   * Enqueue an event REMINDER (T-0174) — the same event, a distinct message.
   * Fired by the reminder scheduler from an `event_notify_offsets` row rather
   * than by an authoring action, which is why it is a separate producer and a
   * separate job type.
   */
  async enqueueEventReminder(
    regimentId: string,
    event: EventSummary,
    minutesBefore: number,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      const target = s.eventAnnouncementChannelId;
      if (!target) return null;
      const brand = await this.resolveBrand(regimentId);
      return this.insertJob(regimentId, DiscordSyncJobType.EventReminder, {
        channelId: target,
        content: '',
        embed: buildEventEmbed(event, brand, { minutesBefore }),
      });
    });
  }

  /**
   * Enqueue an enlistment-application post to the enlistments channel
   * (T-0042/T-0173). No-ops when the bot is off or no enlistments channel is
   * configured.
   */
  async enqueueApplicationSubmitted(
    regimentId: string,
    summary: EnlistmentSummary,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      if (!s.enlistmentChannelId) return null;
      const brand = await this.resolveBrand(regimentId);
      return this.insertJob(regimentId, DiscordSyncJobType.ApplicationSubmitted, {
        channelId: s.enlistmentChannelId,
        content: '',
        embed: buildEnlistmentEmbed(summary, brand),
      });
    });
  }

  /**
   * Enqueue an audit-log entry mirror to the audit-log channel (T-0043/T-0175).
   * No-ops when the bot is off or no audit-log channel is configured. The source
   * audit entry id is threaded through the payload so the worker can write the
   * mirror outcome (synced/failed) back onto that row. Returns whether a job was
   * inserted, so the caller can set the entry's initial sync status.
   */
  async enqueueAuditLog(
    regimentId: string,
    entry: AuditSummary,
    auditEntryId?: string | null,
  ): Promise<boolean> {
    const job = await this.guarded(regimentId, async (s) => {
      if (!s.auditLogChannelId) return null;
      // No brand lookup here on purpose: the audit mirror is the highest-volume
      // producer in the app (one entry per audited mutation), and its embed is
      // severity-coloured rather than regiment-coloured — so it would be a query
      // per audit row for nothing.
      return this.insertJob(regimentId, DiscordSyncJobType.AuditLog, {
        channelId: s.auditLogChannelId,
        content: '',
        embed: buildAuditEmbed(entry),
        auditEntryId: auditEntryId ?? null,
      });
    });
    return !!job;
  }

  /**
   * Enqueue the welcome message for a newly-joined member (T-0175).
   *
   * BLANK MEANS DEFAULT (T-0184). This read `s.welcomeMessage ?? DEFAULT_WELCOME`,
   * which is only nullish-safe: an admin who cleared the settings editor saved
   * `''`, and `'' ?? x` is `''`, so the regiment greeted every new recruit with
   * an embed that had no body at all. `updateSettings` now normalises blank to
   * NULL on the way in, but rows written before that fix — and any written
   * around it — are handled here too, so the read is correct on its own.
   */
  async enqueueWelcome(regimentId: string, discordUserId: string): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      const brand = await this.resolveBrand(regimentId);
      const message = s.welcomeMessage?.trim() || DEFAULT_WELCOME;
      return this.insertJob(regimentId, DiscordSyncJobType.Welcome, {
        discordUserId,
        // Null keeps the DM fallback intact: the worker still routes to a DM
        // whenever no welcome channel is configured.
        channelId: s.welcomeChannelId,
        // The greeting is the EMBED, never the message content — that is what
        // keeps admin-authored text unable to ping anyone (T-0185).
        content: '',
        embed: buildWelcomeEmbed({ brand, message, discordUserId }),
      });
    });
  }

  /**
   * Enqueue a decision DM (approve/decline/hold) to an applicant (T-0173).
   * Best-effort: no-ops when the bot is disabled.
   *
   * The MESSAGE is composed here now, not by the caller: `customMessage` is the
   * officer's own words when they wrote any, and otherwise the per-outcome house
   * default — which is exactly the behaviour ApplicationsService had, moved to
   * where every other notification is written.
   *
   * ⚠️ `customMessage` is the ONLY applicant-visible text this producer accepts
   * (T-0182). The officer's staff-only moderator note used to arrive here as a
   * `reviewerNote` and be rendered to the applicant as a labelled embed field;
   * the parameter is gone rather than merely unused, so the leak cannot be
   * reinstated by a caller.
   */
  async enqueueApplicationDecision(
    regimentId: string,
    payload: {
      discordUserId: string;
      outcome: ApplicationDecisionOutcome;
      /** The officer's custom DM text, when they wrote one. */
      customMessage?: string | null;
    },
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async () => {
      if (!payload.discordUserId) return null;
      const brand = await this.resolveBrand(regimentId);
      const message =
        payload.customMessage?.trim() || defaultDecisionMessage(payload.outcome, brand.name);
      return this.insertJob(regimentId, DiscordSyncJobType.ApplicationDecision, {
        discordUserId: payload.discordUserId,
        content: '',
        embed: buildDecisionEmbed({ outcome: payload.outcome, brand, message }),
      });
    });
  }

  /**
   * Enqueue the gallery moderation-outcome DM (T-0090/T-0173). Shares the
   * `application.decision` job type with the enlistment DM — both are "a
   * moderation outcome, delivered privately", and the worker's DM arm is
   * identical — but composition is its own concern, so it gets its own producer.
   */
  async enqueueGalleryDecision(
    regimentId: string,
    payload: { discordUserId: string; title: string; reason?: string | null },
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async () => {
      if (!payload.discordUserId) return null;
      const brand = await this.resolveBrand(regimentId);
      return this.insertJob(regimentId, DiscordSyncJobType.ApplicationDecision, {
        discordUserId: payload.discordUserId,
        content: '',
        embed: buildGalleryDeclineEmbed({
          brand,
          title: payload.title,
          reason: payload.reason ?? null,
        }),
      });
    });
  }

  /**
   * Add or remove the Discord role linked to the `Applicant` rank (T-0192).
   *
   * The role is resolved through the RANK row rather than a settings column, so
   * the admin configures it in the same Ranks & Medals screen as every other
   * role link and there is no second place for it to be half-configured. The
   * `Applicant` rank is frozen against rename/delete precisely because this
   * lookup is by name.
   *
   * ⚠️ NOBODY IS EVER PLACED ON THAT RANK. An applicant has no member row — the
   * rank exists only to carry the link. That asymmetry is why this is a bare
   * `role.assign`/`role.remove` and not a reconcile: there is no roster state to
   * reconcile against.
   *
   * Silently no-ops when the rank is missing or unlinked, which is the state a
   * regiment that has not configured an Applicant role is in — and the state
   * production is in today. It is a notification, not a gate: nothing about the
   * application itself depends on it.
   */
  async enqueueApplicantRole(
    regimentId: string,
    discordUserId: string | null,
    action: 'add' | 'remove',
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async () => {
      if (!discordUserId) return null;
      const rank = await this.ranks.findOne({
        where: { regimentId, name: APPLICANT_RANK_NAME },
      });
      if (!rank?.discordRoleId) return null;
      return this.insertJob(
        regimentId,
        action === 'add' ? DiscordSyncJobType.RoleAssign : DiscordSyncJobType.RoleRemove,
        { discordUserId, roleId: rank.discordRoleId },
      );
    });
  }

  /**
   * Post a gallery submission to the staff review channel (T-0195). No-ops when
   * the bot is off or no review channel is configured.
   */
  async enqueueGallerySubmitted(
    regimentId: string,
    item: GallerySummary,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      if (!s.gallerySubmissionChannelId) return null;
      const brand = await this.resolveBrand(regimentId);
      return this.insertJob(regimentId, DiscordSyncJobType.GallerySubmitted, {
        channelId: s.gallerySubmissionChannelId,
        content: '',
        embed: buildGalleryEmbed(item, brand, 'pending'),
        // The reviewer needs to WATCH the thing they are being asked to pass.
        // An embed cannot play a video and does not unfurl a link, so the same
        // bare-URL second message the showcase post uses is if anything more
        // necessary here — this channel is where the decision is actually made.
        mediaUrl: item.playableUrl ?? null,
      });
    });
  }

  /**
   * Showcase an APPROVED gallery item in the public gallery channel (T-0195).
   * No-ops when the bot is off or no showcase channel is configured.
   */
  async enqueueGalleryApproved(
    regimentId: string,
    item: GallerySummary,
  ): Promise<DiscordSyncJob | null> {
    return this.guarded(regimentId, async (s) => {
      if (!s.galleryApprovedChannelId) return null;
      const brand = await this.resolveBrand(regimentId);
      return this.insertJob(regimentId, DiscordSyncJobType.GalleryApproved, {
        channelId: s.galleryApprovedChannelId,
        content: '',
        embed: buildGalleryEmbed(item, brand, 'approved'),
        // Discord renders a player from a bare media URL in the message CONTENT,
        // never from an embed — so a playable video needs a second message. The
        // worker sends it after the embed; see GalleryPostPayload.
        mediaUrl: item.playableUrl ?? null,
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
      const payload: RoleRelinkExpandPayload = {
        subject: input.subject,
        subjectId: input.subjectId,
        subjectLabel: input.subjectLabel,
        outgoingRoleId: input.previousRoleId,
        incomingRoleId: input.nextRoleId,
        cursor: null,
        excludeMemberId: input.excludeMemberId ?? null,
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
    const p = job.payload as RoleRelinkExpandPayload | null;
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
      const next: RoleRelinkExpandPayload = { ...p, cursor: page[page.length - 1].memberId };
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
    excludeMemberId?: string | null;
  }): SelectQueryBuilder<Member> {
    const qb = this.members
      .createQueryBuilder('member')
      .innerJoin(DiscordIdentity, 'identity', 'identity.id = member.discordIdentityId')
      .where('member.regimentId = :regimentId', { regimentId: input.regimentId });
    // Never fan out to the actor themselves (LDA-H1): a rank/medal editor must not
    // be able to grant themselves a role by linking a rank/medal they hold.
    if (input.excludeMemberId) {
      qb.andWhere('member.id != :excludeMemberId', { excludeMemberId: input.excludeMemberId });
    }
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
    input: { subject: RoleRelinkSubject; subjectId: string; excludeMemberId?: string | null },
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
      const p = seed?.payload as RoleRelinkExpandPayload | undefined;
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
