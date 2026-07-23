import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import {
  BotConnectionStatus,
  DiscordSyncJobStatus,
  DiscordSyncJobType,
  RoleRelinkBatchState,
} from '../common/enums';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordOnboardingService } from './discord-onboarding.service';
import { DiscordSyncService } from './discord-sync.service';
import {
  BotOperationDto,
  BotStatusDto,
  DiscordConnectionDto,
  DiscordRoleDto,
  DiscordVerifyConnectionDto,
} from './dto/discord-connection.dto';
import { DiscordChannel, DiscordRole } from './gateway/discord-gateway';
import { DiscordBotSettingsDto, UpdateDiscordSettingsDto } from './dto/discord-settings.dto';
import {
  BindGuildDto,
  DiscordOperationsQueryDto,
  SimulateJoinDto,
  SimulateLeaveDto,
} from './dto/discord-inputs.dto';
import { RoleRelinkFailuresDto, RoleRelinkProgressDto } from './dto/role-relink.dto';
import { RoleRelinkPayload } from './discord-sync.service';
import { BotOperation } from './entities/bot-operation.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordConnection } from './entities/discord-connection.entity';
import { DiscordSyncJob } from './entities/discord-sync-job.entity';
import { DiscordGateway } from './gateway/discord-gateway';

/** How many distinct failure messages the progress summary carries. */
const FAILURE_SAMPLE_LIMIT = 3;

/** One (jobType, status) bucket of a batch, with the retry breakdown folded in. */
interface RelinkCountRow {
  jobType: DiscordSyncJobType;
  status: DiscordSyncJobStatus;
  count: string;
  /** Jobs in this bucket that used up every attempt (vs failing permanently). */
  exhausted: string;
  /** Jobs in this bucket that have failed at least once. */
  attempted: string;
}

/**
 * Bot-control plane behind /discord: connection status + verification, bot
 * settings, resync, and the bot-operations ledger. Every mutation is
 * regiment-scoped and audited; the actual Discord work is always enqueued
 * through the outbox, never done inline.
 */
@Injectable()
export class DiscordService {
  constructor(
    @InjectRepository(DiscordConnection)
    private readonly connections: Repository<DiscordConnection>,
    @InjectRepository(BotOperation)
    private readonly operations: Repository<BotOperation>,
    @InjectRepository(DiscordBotSettings)
    private readonly settings: Repository<DiscordBotSettings>,
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
    @InjectRepository(DiscordSyncJob)
    private readonly jobs: Repository<DiscordSyncJob>,
    private readonly gateway: DiscordGateway,
    private readonly sync: DiscordSyncService,
    private readonly onboarding: DiscordOnboardingService,
    private readonly audit: AuditService,
  ) {}

  /** Current connection snapshot (live gateway status + persisted authority). */
  async getConnection(user: AuthenticatedUser): Promise<DiscordConnectionDto> {
    const status = await this.gateway.getStatus();
    const connection = await this.connections.findOne({ where: { regimentId: user.regimentId } });
    return DiscordConnectionDto.from(status, connection);
  }

  /**
   * Lean bot status for the STAFF dashboard widget (T-0077): online/offline +
   * live runtime metrics, with the sensitive authority/config fields omitted (see
   * {@link BotStatusDto}). Same data source as getConnection, projected safely.
   */
  async getBotStatus(user: AuthenticatedUser): Promise<BotStatusDto> {
    const status = await this.gateway.getStatus();
    const connection = await this.connections.findOne({ where: { regimentId: user.regimentId } });
    return BotStatusDto.from(status, connection);
  }

  /**
   * Run a live connection check + persist the authority snapshot (wizard step).
   * Also returns the guild's roles + text channels so the Settings pickers
   * (join/Ban roles, routed channels) populate from this one call; both are
   * best-effort and empty when the bot is disconnected — never failing verify.
   */
  async verifyConnection(
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<DiscordVerifyConnectionDto> {
    const status = await this.gateway.getStatus();
    const connection = await this.ensureConnection(user.regimentId);
    connection.connectionStatus = status.connected
      ? BotConnectionStatus.Connected
      : BotConnectionStatus.Error;
    connection.botVersion = status.botVersion;
    connection.totalRoles = status.totalRoles;
    connection.botRolePosition = status.botRolePosition;
    connection.membersVisible = status.membersVisible;
    connection.lastHeartbeatAt = new Date();
    await this.connections.save(connection);

    let roles: DiscordRole[] = [];
    let channels: DiscordChannel[] = [];
    if (status.connected) {
      try {
        roles = await this.gateway.listRoles();
      } catch {
        roles = [];
      }
      try {
        channels = await this.gateway.listChannels();
      } catch {
        channels = [];
      }
    }

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.connection.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', label: 'connection' },
      detail: `Connection verified (${connection.connectionStatus})`,
    });
    return DiscordVerifyConnectionDto.fromStatus(status, connection, roles, channels);
  }

  /**
   * List the guild's roles for the rank/medal link pickers (scoped to
   * edit_ranks_medals, so an editor without manage_settings can still populate
   * the picker). Best-effort: returns [] when the bot is disconnected/disabled or
   * the live fetch fails — mirrors the verifyConnection roles pattern.
   */
  async listRoles(): Promise<DiscordRoleDto[]> {
    const status = await this.gateway.getStatus();
    if (!status.connected) return [];
    try {
      const roles = await this.gateway.listRoles();
      return roles.map((r) => ({ id: r.id, name: r.name, position: r.position }));
    } catch {
      return [];
    }
  }

  /** Read the bot settings (materialising defaults). */
  async getSettings(user: AuthenticatedUser): Promise<DiscordBotSettingsDto> {
    const settings = await this.sync.getSettings(user.regimentId);
    return DiscordBotSettingsDto.from(settings);
  }

  /**
   * Update the bot settings. Toggling applyBanRoleOnBan is flagged in the audit
   * trail, and it can only be ENABLED when a Ban role is (or is being) set
   * (T-0034 answer: the Ban role is required).
   */
  async updateSettings(
    user: AuthenticatedUser,
    dto: UpdateDiscordSettingsDto,
    ip: string | null,
  ): Promise<DiscordBotSettingsDto> {
    const settings = await this.sync.getSettings(user.regimentId);
    const banGateWas = settings.applyBanRoleOnBan;
    const guildGateWas = settings.guildGateEnabled;

    if (dto.botEnabled !== undefined) settings.botEnabled = dto.botEnabled;
    if (dto.welcomeChannelId !== undefined) settings.welcomeChannelId = dto.welcomeChannelId;
    // Blank means "use the house default", so it is stored as NULL rather than
    // '' (T-0184). Every other optional string on this endpoint is only ever
    // read for truthiness (`if (!s.joinRoleId)`, `if (!s.auditLogChannelId)`),
    // where '' and null behave identically — the welcome message is the one
    // column read with `??`, so '' silently became an EMPTY greeting instead of
    // the default. Trimming here also means the editor cannot save trailing
    // whitespace that reads as a difference on the next dirty-check.
    // `?.` guards the null the editor really does post when nothing is configured.
    if (dto.welcomeMessage !== undefined) {
      settings.welcomeMessage = dto.welcomeMessage?.trim() || null;
    }
    if (dto.enlistmentChannelId !== undefined)
      settings.enlistmentChannelId = dto.enlistmentChannelId || null;
    if (dto.enlistmentChannelName !== undefined)
      settings.enlistmentChannelName = dto.enlistmentChannelName || null;
    if (dto.auditLogChannelId !== undefined)
      settings.auditLogChannelId = dto.auditLogChannelId || null;
    if (dto.auditLogChannelName !== undefined)
      settings.auditLogChannelName = dto.auditLogChannelName || null;
    if (dto.eventAnnouncementChannelId !== undefined)
      settings.eventAnnouncementChannelId = dto.eventAnnouncementChannelId || null;
    if (dto.eventAnnouncementChannelName !== undefined)
      settings.eventAnnouncementChannelName = dto.eventAnnouncementChannelName || null;
    if (dto.joinRoleId !== undefined) settings.joinRoleId = dto.joinRoleId;
    if (dto.joinRoleName !== undefined) settings.joinRoleName = dto.joinRoleName;
    if (dto.banRoleId !== undefined) settings.banRoleId = dto.banRoleId || null;
    if (dto.banRoleName !== undefined) settings.banRoleName = dto.banRoleName || null;
    if (dto.syncRolesOnChange !== undefined) settings.syncRolesOnChange = dto.syncRolesOnChange;
    if (dto.applyBanRoleOnBan !== undefined) settings.applyBanRoleOnBan = dto.applyBanRoleOnBan;
    if (dto.guildGateEnabled !== undefined) settings.guildGateEnabled = dto.guildGateEnabled;

    // The Ban role is REQUIRED before the ban-on-ban behaviour can be enabled.
    if (settings.applyBanRoleOnBan && !settings.banRoleId) {
      throw new BadRequestException(
        'A Ban role must be selected before enabling “apply Ban role on ban”.',
      );
    }

    const saved = await this.settings.save(settings);

    // Both of these change who/what the bot can act on, so a flip is named
    // explicitly in the trail rather than hiding inside "settings updated".
    const sensitive: string[] = [];
    if (dto.applyBanRoleOnBan !== undefined && dto.applyBanRoleOnBan !== banGateWas) {
      sensitive.push(
        `applyBanRoleOnBan ${saved.applyBanRoleOnBan ? 'ENABLED' : 'disabled'} (sensitive)`,
      );
    }
    if (dto.guildGateEnabled !== undefined && dto.guildGateEnabled !== guildGateWas) {
      sensitive.push(
        `guildGateEnabled ${saved.guildGateEnabled ? 'ENABLED' : 'disabled'} (sensitive)`,
      );
    }
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.connection.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', label: 'settings' },
      detail:
        sensitive.length > 0
          ? `Bot settings updated — ${sensitive.join('; ')}`
          : 'Bot settings updated',
    });
    return DiscordBotSettingsDto.from(saved);
  }

  /** Enqueue a full role resync for every linked member. */
  async resync(user: AuthenticatedUser, ip: string | null): Promise<{ enqueued: number }> {
    const enqueued = await this.sync.resyncAll(user.regimentId);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.resync',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', label: 'resync' },
      detail: `Enqueued ${enqueued} role syncs`,
    });
    return { enqueued };
  }

  /**
   * Live progress (or the terminal summary) of one bulk re-link batch (T-0160).
   * Every number comes from the job rows grouped by `batchId` — nothing is held
   * in memory — so the run survives an API restart and every open admin tab
   * polling this sees the same counts. 404 when the batch is not this
   * regiment's (or never existed).
   */
  async getRelinkProgress(
    user: AuthenticatedUser,
    batchId: string,
  ): Promise<RoleRelinkProgressDto> {
    const rows = await this.jobs
      .createQueryBuilder('job')
      .select('job.jobType', 'jobType')
      .addSelect('job.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(CASE WHEN job.attempts >= job.maxAttempts THEN 1 ELSE 0 END)', 'exhausted')
      .addSelect('SUM(CASE WHEN job.attempts > 0 THEN 1 ELSE 0 END)', 'attempted')
      .where('job.regimentId = :regimentId', { regimentId: user.regimentId })
      .andWhere('job.batchId = :batchId', { batchId })
      .groupBy('job.jobType')
      .addGroupBy('job.status')
      .getRawMany<RelinkCountRow>();
    if (rows.length === 0) throw new NotFoundException('Re-link batch not found');

    // The cursor job that seeded the batch is the only row carrying what the
    // run is about; it stays in the table after it succeeds.
    const seed = await this.jobs.findOne({
      where: {
        regimentId: user.regimentId,
        batchId,
        jobType: DiscordSyncJobType.RoleRelinkExpand,
      },
      order: { createdAt: 'ASC' },
    });
    const descriptor = seed?.payload as RoleRelinkPayload | undefined;

    const applyRows = rows.filter((r) => r.jobType === DiscordSyncJobType.RoleRelinkApply);
    const bucket = (status: DiscordSyncJobStatus, from = applyRows): RelinkCountRow | undefined =>
      from.find((r) => r.status === status);
    const total = applyRows.reduce((sum, r) => sum + Number(r.count), 0);
    const applied = Number(bucket(DiscordSyncJobStatus.Succeeded)?.count ?? 0);
    const pending = Number(bucket(DiscordSyncJobStatus.Pending)?.count ?? 0);
    const processing = Number(bucket(DiscordSyncJobStatus.Processing)?.count ?? 0);
    const failedRow = bucket(DiscordSyncJobStatus.Failed);
    const failed = Number(failedRow?.count ?? 0);
    const cancelled = Number(bucket(DiscordSyncJobStatus.Cancelled)?.count ?? 0);

    const expandRows = rows.filter((r) => r.jobType === DiscordSyncJobType.RoleRelinkExpand);
    const expanding =
      Number(bucket(DiscordSyncJobStatus.Pending, expandRows)?.count ?? 0) +
        Number(bucket(DiscordSyncJobStatus.Processing, expandRows)?.count ?? 0) >
      0;

    const running = expanding || pending > 0 || processing > 0;
    // Read the cancel signal from the WHOLE batch, not just the per-member jobs:
    // a run stopped before its first page expanded has a cancelled cursor and no
    // member jobs at all, and reporting that as "completed" would be a lie.
    const stopped = rows.some((r) => r.status === DiscordSyncJobStatus.Cancelled);
    // A run stopped by an operator is reported as PARTIAL rather than failed:
    // the members already applied are correct and are deliberately not rolled
    // back, so "some of it happened" is the honest terminal state.
    const state = running
      ? RoleRelinkBatchState.Running
      : stopped
        ? applied > 0
          ? RoleRelinkBatchState.Partial
          : RoleRelinkBatchState.Cancelled
        : RoleRelinkBatchState.Completed;

    return {
      batchId,
      state,
      subject: descriptor?.subject ?? 'rank',
      subjectLabel: descriptor?.subjectLabel ?? null,
      outgoingRoleId: descriptor?.outgoingRoleId ?? null,
      incomingRoleId: descriptor?.incomingRoleId ?? null,
      expanding,
      total,
      applied,
      pending: pending + processing,
      failed,
      cancelled,
      failures: await this.relinkFailures(user.regimentId, batchId, failedRow, applyRows),
      startedAt: (seed?.createdAt ?? new Date()).toISOString(),
      finishedAt: running ? null : await this.relinkFinishedAt(user.regimentId, batchId),
    };
  }

  /**
   * Stop a bulk re-link (T-0160): every PENDING job of the batch becomes
   * Cancelled, which also stops further expansion because the cursor job is one
   * of them. Nothing is rolled back — members already updated are correct, and
   * un-applying them would put the regiment in a third, worse state.
   */
  async cancelRelink(
    user: AuthenticatedUser,
    batchId: string,
    ip: string | null,
  ): Promise<RoleRelinkProgressDto> {
    const known = await this.jobs.count({ where: { regimentId: user.regimentId, batchId } });
    if (known === 0) throw new NotFoundException('Re-link batch not found');

    const stopped = await this.jobs.update(
      { regimentId: user.regimentId, batchId, status: DiscordSyncJobStatus.Pending },
      {
        status: DiscordSyncJobStatus.Cancelled,
        processedAt: new Date(),
        lastError: 'Cancelled by an operator',
      },
    );

    const progress = await this.getRelinkProgress(user, batchId);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.role.relink.cancel',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', id: batchId, label: progress.subjectLabel ?? 'role re-link' },
      detail:
        `Cancelled ${stopped.affected ?? 0} queued role updates; ` +
        `${progress.applied} members were already updated and are NOT rolled back.`,
    });
    return progress;
  }

  /**
   * Split a batch's failures by Discord error CLASS. A job that failed with
   * attempts still on the clock can only have hit PERMANENT_DISCORD_ERROR_CODES
   * (the worker short-circuits those on the first attempt), which is exactly
   * what distinguishes "your bot role sits below the target role" from "Discord
   * was flaky" — no extra column needed to tell them apart.
   */
  private async relinkFailures(
    regimentId: string,
    batchId: string,
    failedRow: RelinkCountRow | undefined,
    applyRows: RelinkCountRow[],
  ): Promise<RoleRelinkFailuresDto> {
    const failed = Number(failedRow?.count ?? 0);
    const exhausted = Number(failedRow?.exhausted ?? 0);
    const pendingRow = applyRows.find((r) => r.status === DiscordSyncJobStatus.Pending);
    const failures: RoleRelinkFailuresDto = {
      permanent: failed - exhausted,
      exhausted,
      retrying: Number(pendingRow?.attempted ?? 0),
      samples: [],
    };
    if (failed === 0) return failures;

    const rows = await this.jobs.find({
      where: { regimentId, batchId, status: DiscordSyncJobStatus.Failed },
      order: { processedAt: 'DESC' },
      take: 20,
    });
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.lastError && !seen.has(row.lastError)) seen.add(row.lastError);
      if (seen.size === FAILURE_SAMPLE_LIMIT) break;
    }
    failures.samples = [...seen];
    return failures;
  }

  /** When the last job of a drained batch was processed (terminal runs only). */
  private async relinkFinishedAt(regimentId: string, batchId: string): Promise<string | null> {
    const last = await this.jobs.findOne({
      where: { regimentId, batchId },
      order: { processedAt: 'DESC' },
    });
    return last?.processedAt ? last.processedAt.toISOString() : null;
  }

  /** Paginated recent bot operations for the regiment. */
  async listOperations(
    user: AuthenticatedUser,
    query: DiscordOperationsQueryDto,
  ): Promise<PaginatedResponseDto<BotOperationDto>> {
    const connection = await this.connections.findOne({ where: { regimentId: user.regimentId } });
    if (!connection) {
      return new PaginatedResponseDto([], 0, query.page, query.limit);
    }
    const [rows, total] = await this.operations.findAndCount({
      where: { discordConnectionId: connection.id },
      order: { occurredAt: 'DESC' },
      skip: query.skip,
      take: query.limit,
    });
    return new PaginatedResponseDto(
      rows.map((op) => BotOperationDto.from(op)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Mark a (failed) bot operation resolved. */
  async resolveOperation(
    user: AuthenticatedUser,
    id: string,
    ip: string | null,
  ): Promise<BotOperationDto> {
    const connection = await this.connections.findOne({ where: { regimentId: user.regimentId } });
    const op = connection
      ? await this.operations.findOne({ where: { id, discordConnectionId: connection.id } })
      : null;
    if (!op) throw new NotFoundException('Operation not found');
    op.resolvable = false;
    await this.operations.save(op);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.operation.resolve',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', id: op.id, label: op.operation },
    });
    return BotOperationDto.from(op);
  }

  /** Bind the regiment to a Discord guild (onboarding wizard connection step). */
  async bind(
    user: AuthenticatedUser,
    dto: BindGuildDto,
    ip: string | null,
  ): Promise<{ discordServerId: string | null; discordServerName: string | null }> {
    const regiment = await this.regiments.findOne({ where: { id: user.regimentId } });
    if (!regiment) throw new NotFoundException('Regiment not found');
    regiment.discordServerId = dto.discordServerId;
    if (dto.discordServerName !== undefined) regiment.discordServerName = dto.discordServerName;
    await this.regiments.save(regiment);
    await this.sync.getSettings(user.regimentId); // materialise settings row
    await this.ensureConnection(user.regimentId);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.connection.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', label: 'guild' },
      detail: `Bound to guild ${dto.discordServerId}`,
    });
    return {
      discordServerId: regiment.discordServerId,
      discordServerName: regiment.discordServerName,
    };
  }

  /**
   * Dev/testing: simulate a guild-member-add to exercise onboarding via the mock.
   * Routed through the gateway's simulate hook when there is one, so EVERY
   * GuildMemberAdd subscriber fires — onboarding and the membership verdict
   * writer (T-0169) — rather than just onboarding. The real gateway has no such
   * hook (it will not fabricate Discord events), so it falls back to driving
   * onboarding directly, exactly as this route did before.
   */
  async simulateMemberJoin(dto: SimulateJoinDto): Promise<{ ok: true }> {
    if (this.gateway.simulateMemberJoin) {
      await this.gateway.simulateMemberJoin(dto.discordUserId);
    } else {
      await this.onboarding.onMemberJoin(dto.discordUserId);
    }
    return { ok: true };
  }

  /**
   * Dev/testing counterpart: simulate a guild-member-remove (T-0169) so the
   * departure path — verdict flipped to false, cached verdict replaced — is
   * coverable with DISCORD_BOT_MOCK=true. A no-op against the real gateway,
   * which has nothing to simulate.
   */
  async simulateMemberLeave(dto: SimulateLeaveDto): Promise<{ ok: true }> {
    await this.gateway.simulateMemberLeave?.(dto.discordUserId);
    return { ok: true };
  }

  private async ensureConnection(regimentId: string): Promise<DiscordConnection> {
    const existing = await this.connections.findOne({ where: { regimentId } });
    if (existing) return existing;
    return this.connections.save(
      this.connections.create({ regimentId, connectionStatus: BotConnectionStatus.Idle }),
    );
  }
}
