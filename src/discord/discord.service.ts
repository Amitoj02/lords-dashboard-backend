import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { BotConnectionStatus } from '../common/enums';
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
import { BindGuildDto, DiscordOperationsQueryDto, SimulateJoinDto } from './dto/discord-inputs.dto';
import { BotOperation } from './entities/bot-operation.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordConnection } from './entities/discord-connection.entity';
import { DiscordGateway } from './gateway/discord-gateway';

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

    if (dto.botEnabled !== undefined) settings.botEnabled = dto.botEnabled;
    if (dto.welcomeChannelId !== undefined) settings.welcomeChannelId = dto.welcomeChannelId;
    if (dto.welcomeMessage !== undefined) settings.welcomeMessage = dto.welcomeMessage;
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

    // The Ban role is REQUIRED before the ban-on-ban behaviour can be enabled.
    if (settings.applyBanRoleOnBan && !settings.banRoleId) {
      throw new BadRequestException(
        'A Ban role must be selected before enabling “apply Ban role on ban”.',
      );
    }

    const saved = await this.settings.save(settings);

    const banGateChanged =
      dto.applyBanRoleOnBan !== undefined && dto.applyBanRoleOnBan !== banGateWas;
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.connection.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', label: 'settings' },
      detail: banGateChanged
        ? `Bot settings updated — applyBanRoleOnBan ${saved.applyBanRoleOnBan ? 'ENABLED' : 'disabled'} (sensitive)`
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

  /** Dev/testing: simulate a guild-member-add to exercise onboarding via the mock. */
  async simulateMemberJoin(dto: SimulateJoinDto): Promise<{ ok: true }> {
    await this.onboarding.onMemberJoin(dto.discordUserId);
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
