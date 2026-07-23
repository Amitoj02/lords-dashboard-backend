import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Not, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditLogEntry } from '../audit/entities/audit-log-entry.entity';
import {
  AuditActorType,
  BotConnectionStatus,
  DiscordSyncJobStatus,
  DiscordSyncJobType,
  DiscordSyncStatus,
} from '../common/enums';
import { Medal } from '../medals/entities/medal.entity';
import { MemberMedal } from '../medals/entities/member-medal.entity';
import { Member } from '../members/entities/member.entity';
import { Rank } from '../ranks/entities/rank.entity';
import {
  ChannelMessagePayload,
  DiscordJobPayloadMap,
  DirectMessagePayload,
} from './discord-job-payloads';
import { DiscordSyncService } from './discord-sync.service';
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
  // Re-expanding a page re-inserts jobs that converge to the same end state,
  // and applying a member's share of a re-link is a reconcile.
  DiscordSyncJobType.RoleRelinkExpand,
  DiscordSyncJobType.RoleRelinkApply,
]);

/** The bulk fan-out job types (a rank/medal re-link, T-0158). */
const BULK_JOB_TYPES = [DiscordSyncJobType.RoleRelinkExpand, DiscordSyncJobType.RoleRelinkApply];

/** How many jobs to drain per tick (keeps well under Discord's rate limits). */
const BATCH_SIZE = 20;
/**
 * Ceiling on how much of one tick a bulk fan-out may claim. The queue is drained
 * in `createdAt` order, so without a reserve a 600-member re-link would sit at
 * the head of it for minutes and every announcement, enlistment post, decision
 * DM and welcome queued behind it would wait that long. Those are time-sensitive
 * and a re-link is not, so the remaining slots are held for them (T-0158's own
 * regression risk).
 */
const BULK_SLOTS_PER_TICK = 12;
const TICK_MS = 3_000;
/** Retry backoff by attempt number (ms): ~5s, 30s, 2m, 10m, 30m. */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/**
 * Discord JSON error codes that will NEVER succeed on retry, so burning the
 * remaining attempts is pure waste — and worse than waste at scale.
 *
 * Discord bans an IP that emits 10,000 invalid requests (401/403/429) in 10
 * minutes, and that ban is IP-level: it would take down the bot AND Discord
 * OAuth sign-in simultaneously, since both leave from the same VPS. The drain is
 * already bounded (BATCH_SIZE 20 per 3s tick, escalating backoff), so the
 * realistic worst case — a mispositioned bot role 403ing a full 576-member
 * reconcile — lands around 2,900 invalid requests spread over 30+ minutes and
 * stays under the threshold. This keeps that headroom rather than spending it:
 * a permanent failure now fails on the FIRST attempt instead of the fifth,
 * cutting invalid-request volume by 5x and surfacing the real problem
 * (role hierarchy, missing channel overwrite) to an admin immediately.
 *
 * @see https://docs.discord.com/developers/topics/opcodes-and-status-codes
 */
const PERMANENT_DISCORD_ERROR_CODES = new Set([
  10003, // Unknown Channel — routed channel deleted or never existed
  10007, // Unknown Member — left the guild
  10011, // Unknown Role — mapped role deleted
  10013, // Unknown User
  50001, // Missing Access — bot cannot see the channel (needs a channel overwrite)
  50013, // Missing Permissions — bot role sits below the target role
  50028, // Invalid Role — includes managed roles (Booster/bot/integration)
  50033, // Invalid Recipient
  50007, // Cannot send messages to this user — DMs closed
]);

/**
 * True when an error is a Discord API failure that retrying cannot fix.
 *
 * discord.js surfaces these as DiscordAPIError with a numeric/string `code`.
 * Anything else — network blips, 5xx, gateway churn, 429 — stays retryable.
 */
function isPermanentDiscordError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const numeric = typeof code === 'string' ? Number(code) : code;
  return typeof numeric === 'number' && PERMANENT_DISCORD_ERROR_CODES.has(numeric);
}

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
    @InjectRepository(Medal)
    private readonly medals: Repository<Medal>,
    @InjectRepository(MemberMedal)
    private readonly memberMedals: Repository<MemberMedal>,
    @InjectRepository(DiscordBotSettings)
    private readonly settings: Repository<DiscordBotSettings>,
    @InjectRepository(AuditLogEntry)
    private readonly auditEntries: Repository<AuditLogEntry>,
    private readonly gateway: DiscordGateway,
    private readonly audit: AuditService,
    // The enqueue side owns the re-link paging query; the cursor job's whole
    // side effect is "expand one page", so the worker delegates it there.
    private readonly sync: DiscordSyncService,
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
      const now = new Date();
      // Fairness: the bulk fan-out is capped first, then the rest of the tick is
      // filled with everything else and drained FIRST, so a 600-job re-link can
      // never starve an announcement or a decision DM.
      const bulk = await this.jobs.find({
        where: {
          status: DiscordSyncJobStatus.Pending,
          scheduledAt: LessThanOrEqual(now),
          jobType: In(BULK_JOB_TYPES),
        },
        order: { createdAt: 'ASC' },
        take: BULK_SLOTS_PER_TICK,
      });
      const interactive = await this.jobs.find({
        where: {
          status: DiscordSyncJobStatus.Pending,
          scheduledAt: LessThanOrEqual(now),
          jobType: Not(In(BULK_JOB_TYPES)),
        },
        order: { createdAt: 'ASC' },
        take: BATCH_SIZE - bulk.length,
      });
      const due = [...interactive, ...bulk];
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

  /**
   * Read a job's stored payload as the shape its job type declares (T-0172).
   *
   * This replaces `(job.payload ?? {}) as Record<string, string | undefined>`
   * plus a `String(p.foo)` at every use. That old shape asserted every payload
   * value was a STRING, which stopped being true the moment a payload had to
   * carry an embed object — and `String(embed)` would have posted
   * `[object Object]` to a live channel rather than failing loudly.
   *
   * Because {@link dispatch} switches on a narrowed `DiscordSyncJobType`, `type`
   * is a literal inside each `case` and the returned payload is that arm's exact
   * interface — so this is the single cast for the whole worker.
   */
  private payloadOf<T extends DiscordSyncJobType>(
    job: DiscordSyncJob,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    type: T,
  ): DiscordJobPayloadMap[T] {
    return (job.payload ?? {}) as DiscordJobPayloadMap[T];
  }

  /**
   * Post a composed message to a channel.
   *
   * ⚠️ BACKWARD COMPATIBILITY (T-0172): when the payload carries no embed the
   * gateway is called with exactly the two arguments it was called with before
   * this change. That is what makes an outbox row written by the OLD code — it
   * has only `channelId` + `content` — deliver as plain text, byte for byte as
   * it would have on the previous release.
   */
  private postToChannel(p: ChannelMessagePayload): Promise<{ messageId: string }> {
    return p.embed
      ? this.gateway.sendChannelMessage(p.channelId, p.content ?? '', [p.embed])
      : this.gateway.sendChannelMessage(p.channelId, p.content ?? '');
  }

  /** DM a composed message. Same legacy-shaped call as {@link postToChannel}. */
  private dmUser(p: DirectMessagePayload): Promise<{ messageId: string }> {
    return p.embed
      ? this.gateway.sendDirectMessage(p.discordUserId, p.content ?? '', [p.embed])
      : this.gateway.sendDirectMessage(p.discordUserId, p.content ?? '');
  }

  private async dispatch(job: DiscordSyncJob): Promise<void> {
    const type = job.jobType as DiscordSyncJobType;
    switch (type) {
      case DiscordSyncJobType.RoleAssign: {
        const p = this.payloadOf(job, type);
        await this.gateway.assignRole(p.discordUserId, p.roleId);
        return;
      }
      case DiscordSyncJobType.RoleRemove: {
        const p = this.payloadOf(job, type);
        await this.gateway.removeRole(p.discordUserId, p.roleId);
        return;
      }
      case DiscordSyncJobType.RoleSync: {
        const p = this.payloadOf(job, type);
        await this.reconcileRoles(job.regimentId, p.memberId, p.discordUserId);
        return;
      }
      case DiscordSyncJobType.RoleRelinkExpand:
        // Expands ONE page and re-enqueues itself; the gate re-check and the
        // cancel check live with the paging query (DiscordSyncService).
        await this.sync.expandRelinkPage(job);
        return;
      case DiscordSyncJobType.RoleRelinkApply: {
        const p = this.payloadOf(job, type);
        // ⚠️ Re-check the gate at EXECUTION time, exactly like the ban-role job:
        // a fan-out spans minutes, and a re-link job that drains after the bot
        // (or role syncing) was switched off must not touch Discord.
        const settings = await this.settings.findOne({ where: { regimentId: job.regimentId } });
        if (!settings?.botEnabled || !settings?.syncRolesOnChange) {
          this.logger.warn(
            `Skipping queued re-link for ${p.discordUserId}: botEnabled/syncRolesOnChange disabled since enqueue`,
          );
          return;
        }
        await this.reconcileRoles(
          job.regimentId,
          p.memberId,
          p.discordUserId,
          p.outgoingRoleId ?? null,
        );
        return;
      }
      case DiscordSyncJobType.MemberBanRole: {
        const p = this.payloadOf(job, type);
        // ⚠️ SENSITIVE: re-check the gate at EXECUTION time. A ban-role job can
        // sit in the queue (or in retry backoff) after being enqueued; if the
        // owner turned off applyBanRoleOnBan, cleared the Ban role, or disabled
        // the bot in the meantime, do NOT touch Discord. This is the last line of
        // defence for the owner's "re-check every time" request.
        const settings = await this.settings.findOne({ where: { regimentId: job.regimentId } });
        if (!settings?.botEnabled || !settings?.applyBanRoleOnBan) {
          this.logger.warn(
            `Skipping queued ban-role for ${p.discordUserId}: applyBanRoleOnBan/botEnabled disabled since enqueue`,
          );
          return;
        }
        if (!settings.banRoleId) {
          this.logger.warn(
            `Skipping queued ban-role for ${p.discordUserId}: no Ban role configured`,
          );
          return;
        }
        await this.applyBanRole(job.regimentId, p.discordUserId, settings.banRoleId);
        await this.audit.record({
          regimentId: job.regimentId,
          action: 'discord.member.ban_role',
          actor: { type: AuditActorType.Bot, memberId: null, label: 'Lord Adjutant bot' },
          detail: `Stripped managed roles and applied the Ban role to ${p.discordUserId}`,
        });
        return;
      }
      case DiscordSyncJobType.Announce:
      case DiscordSyncJobType.EventReminder:
      case DiscordSyncJobType.ApplicationSubmitted:
        // Announcements, event reminders and enlistment posts are pre-composed
        // channel messages (channel + content/embed resolved at enqueue), so they
        // drain identically. They stay separate JOB TYPES because the operations
        // ledger and the delivery matrix report on them separately.
        await this.postToChannel(this.payloadOf(job, type));
        return;
      case DiscordSyncJobType.AuditLog: {
        const p = this.payloadOf(job, type);
        await this.postToChannel(p);
        // The mirror landed: write the outcome back onto the source audit entry.
        // Guarded so it can NEVER throw here — a throw would retry the job and
        // re-post a duplicate channel message. Unchanged by the embed work
        // (T-0175): what the mirror LOOKS like moved, what it RECORDS did not.
        if (p.auditEntryId) {
          await this.markAuditSync(p.auditEntryId, DiscordSyncStatus.Synced);
        }
        return;
      }
      case DiscordSyncJobType.ApplicationDecision:
        // A decision DM to the applicant (approve/decline/hold) — direct message.
        await this.dmUser(this.payloadOf(job, type));
        return;
      case DiscordSyncJobType.Welcome: {
        const p = this.payloadOf(job, type);
        // The DM fallback is unchanged: no welcome channel ⇒ deliver privately.
        if (p.channelId) {
          await this.postToChannel({ channelId: p.channelId, content: p.content, embed: p.embed });
        } else {
          await this.dmUser({
            discordUserId: p.discordUserId,
            content: p.content,
            embed: p.embed,
          });
        }
        return;
      }
      default:
        throw new Error(`Unknown sync job type: ${job.jobType}`);
    }
  }

  /**
   * Reconcile a member's bot-managed Discord roles. The DESIRED managed-role set
   * is the member's linked rank role plus the linked role of every medal they
   * currently hold. We assign any desired role they lack and remove any MANAGED
   * role they hold that is no longer desired (e.g. the role of a revoked medal),
   * only ever touching roles in {@link managedRoleIds} — unmanaged roles are
   * never added or removed. Best-effort.
   *
   * `outgoingRoleId` is the extra role a bulk re-link must strip (T-0159). It
   * cannot be derived: once the rank/medal points at its new role the previous
   * one is no longer in the managed set, so the diff below would leave it on
   * every holder forever. Only that one id is added to the strippable set —
   * unrelated manual roles stay untouched.
   */
  private async reconcileRoles(
    regimentId: string,
    memberId: string,
    discordUserId: string,
    outgoingRoleId: string | null = null,
  ): Promise<void> {
    const member = await this.members.findOne({
      where: { id: memberId, regimentId },
      relations: { rank: true },
    });
    if (!member) return;
    // A banned member's Discord roles are owned by the ban strip (applyBanRole);
    // never re-grant their rank/medal roles via a reconcile — that would undo the
    // ban (the Ban role would remain but every managed role would come back).
    if (member.bannedAt) return;

    // Desired = the member's rank role (if linked) ∪ the linked role of every
    // medal they currently hold.
    const desired = new Set<string>();
    const rank = member.rankId
      ? await this.ranks.findOne({ where: { id: member.rankId, regimentId } })
      : null;
    if (rank?.discordRoleId) desired.add(rank.discordRoleId);

    const held = await this.memberMedals.find({
      where: { memberId },
      relations: { medal: true },
    });
    for (const mm of held) {
      if (mm.medal?.discordRoleId) desired.add(mm.medal.discordRoleId);
    }

    const managed = await this.managedRoleIds(regimentId);
    const strippable = new Set(managed);
    if (outgoingRoleId) strippable.add(outgoingRoleId);
    // The join/Guest role is assign-only (owned by the guild-join flow); a role
    // reconcile must never strip it even though managedRoleIds lists it (that set
    // is also used by the ban strip, which SHOULD remove it). Only rank/medal
    // roles are reconciled here.
    const settings = await this.settings.findOne({ where: { regimentId } });
    const joinRoleId = settings?.joinRoleId ?? null;

    // Diff against the member's CURRENT roles when the gateway can report them so
    // revoked-medal roles are removed; otherwise fall back to an idempotent
    // assign + explicit strip of every non-held managed medal role.
    const ref = await this.gateway.fetchMember(discordUserId);
    const current = ref ? new Set(ref.roles) : null;

    // Assign every desired role the member is missing (idempotent when unknown).
    for (const roleId of desired) {
      if (!current || !current.has(roleId)) {
        await this.gateway.assignRole(discordUserId, roleId);
      }
    }

    if (current) {
      // Remove any STRIPPABLE role the member holds that is no longer desired,
      // except the assign-only join/Guest role.
      for (const roleId of current) {
        if (strippable.has(roleId) && roleId !== joinRoleId && !desired.has(roleId)) {
          await this.gateway.removeRole(discordUserId, roleId);
        }
      }
      return;
    }

    // The gateway can't list current roles, so nothing can be diffed and every
    // strip has to be issued blind (removeRole is idempotent for a role the
    // member never had).
    if (outgoingRoleId) {
      // A re-link knows EXACTLY which role left the mapping, so the blind sweep
      // below is unnecessary — one targeted strip is both correct and ~25x
      // cheaper against the rate budget on a 600-member fan-out.
      if (outgoingRoleId !== joinRoleId && !desired.has(outgoingRoleId)) {
        await this.gateway.removeRole(discordUserId, outgoingRoleId);
      }
      return;
    }

    // A plain reconcile has no such hint: strip the linked role of every rank
    // and medal the member does NOT currently hold, so a revoked medal's role —
    // and, since T-0159, a superseded RANK role — is still removed. Without the
    // rank half, a promotion left the old rank role on the member every time
    // fetchMember failed.
    const ranks = await this.ranks.find({ where: { regimentId } });
    const medals = await this.medals.find({ where: { regimentId } });
    for (const linked of [...ranks, ...medals]) {
      const roleId = linked.discordRoleId;
      if (roleId && roleId !== joinRoleId && !desired.has(roleId)) {
        await this.gateway.removeRole(discordUserId, roleId);
      }
    }
  }

  /**
   * Best-effort write-back of a mirror job's outcome onto its source audit entry
   * (synced/failed). GUARDED so it never throws: on the success path a throw here
   * would retry the job and re-post the mirror; and record()/handleFailure must
   * not be broken by a write-back error.
   */
  private async markAuditSync(auditEntryId: string, status: DiscordSyncStatus): Promise<void> {
    try {
      await this.auditEntries.update({ id: auditEntryId }, { discordSyncStatus: status });
    } catch (error) {
      this.logger.error(
        `Audit sync-status write-back failed for entry ${auditEntryId}: ${(error as Error).message}`,
      );
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

  /**
   * The set of Discord role snowflakes the bot manages: every rank role, every
   * medal role, and the join role. Reconciliation and the ban strip only ever
   * touch roles in this set — unmanaged roles are left untouched.
   */
  private async managedRoleIds(regimentId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    const ranks = await this.ranks.find({ where: { regimentId } });
    for (const rank of ranks) {
      if (rank.discordRoleId) ids.add(rank.discordRoleId);
    }
    const medals = await this.medals.find({ where: { regimentId } });
    for (const medal of medals) {
      if (medal.discordRoleId) ids.add(medal.discordRoleId);
    }
    const settings = await this.settings.findOne({ where: { regimentId } });
    if (settings?.joinRoleId) ids.add(settings.joinRoleId);
    return ids;
  }

  private async handleFailure(job: DiscordSyncJob, error: Error): Promise<void> {
    job.attempts += 1;
    job.lastError = error.message.slice(0, 500);
    if (job.attempts < job.maxAttempts && !isPermanentDiscordError(error)) {
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
    // A mirror job that failed terminally: reflect that on its source audit row.
    if ((job.jobType as DiscordSyncJobType) === DiscordSyncJobType.AuditLog) {
      const p = this.payloadOf(job, DiscordSyncJobType.AuditLog);
      if (p.auditEntryId) {
        await this.markAuditSync(p.auditEntryId, DiscordSyncStatus.Failed);
      }
    }
    // One audit row per failed member would be 600 rows AND 600 mirrored channel
    // messages for a single mispositioned bot role — the exact invalid-request
    // storm PERMANENT_DISCORD_ERROR_CODES exists to avoid. A bulk failure is
    // reported by the batch progress endpoint (with its error class) and stays
    // resolvable in the operations ledger; only the log line is per-member.
    if (!BULK_JOB_TYPES.includes(job.jobType as DiscordSyncJobType)) {
      await this.audit.record({
        regimentId: job.regimentId,
        action: 'discord.sync.failed',
        actor: { type: AuditActorType.Bot, memberId: null, label: 'Lord Adjutant bot' },
        detail: `${job.jobType} failed after ${job.attempts} attempts: ${error.message}`.slice(
          0,
          500,
        ),
      });
    }
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
          // A terminally-failed AuditLog mirror must reflect on its source entry,
          // else discordSyncStatus is stuck at 'pending' forever (mirrors handleFailure).
          if ((job.jobType as DiscordSyncJobType) === DiscordSyncJobType.AuditLog) {
            const p = this.payloadOf(job, DiscordSyncJobType.AuditLog);
            if (p.auditEntryId) {
              await this.markAuditSync(p.auditEntryId, DiscordSyncStatus.Failed);
            }
          }
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
    // A 600-member fan-out would push ~600 success rows through the ledger the
    // bot-status screen reads at ?limit=100, burying every other operation for
    // days. Successful bulk jobs are counted by the batch progress endpoint
    // (T-0160) instead; FAILURES still land here, because those are the rows an
    // admin has to resolve.
    if (success && BULK_JOB_TYPES.includes(job.jobType as DiscordSyncJobType)) {
      connection.lastHeartbeatAt = new Date();
      await this.connections.save(connection);
      return;
    }
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
