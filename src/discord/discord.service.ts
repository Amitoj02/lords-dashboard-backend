import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { BotConnectionStatus } from '../common/enums';
import { Regiment } from '../regiments/entities/regiment.entity';
import { DiscordOnboardingService } from './discord-onboarding.service';
import { DiscordSyncService } from './discord-sync.service';
import { BotOperationDto, DiscordConnectionDto } from './dto/discord-connection.dto';
import { DiscordBotSettingsDto, UpdateDiscordSettingsDto } from './dto/discord-settings.dto';
import {
  AnnounceDto,
  BindGuildDto,
  DiscordOperationsQueryDto,
  SimulateJoinDto,
} from './dto/discord-inputs.dto';
import { BotOperation } from './entities/bot-operation.entity';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordConnection } from './entities/discord-connection.entity';
import { DiscordGateway } from './gateway/discord-gateway';

/**
 * Bot-control plane behind /discord: connection status + verification, bot
 * settings, resync/announce, and the bot-operations ledger. Every mutation is
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

  /** Run a live connection check + persist the authority snapshot (wizard step). */
  async verifyConnection(
    user: AuthenticatedUser,
    ip: string | null,
  ): Promise<DiscordConnectionDto> {
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

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.connection.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', label: 'connection' },
      detail: `Connection verified (${connection.connectionStatus})`,
    });
    return DiscordConnectionDto.from(status, connection);
  }

  /** Read the bot settings (materialising defaults). */
  async getSettings(user: AuthenticatedUser): Promise<DiscordBotSettingsDto> {
    const settings = await this.sync.getSettings(user.regimentId);
    return DiscordBotSettingsDto.from(settings);
  }

  /** Update the bot settings. Toggling kickOnBan is flagged in the audit trail. */
  async updateSettings(
    user: AuthenticatedUser,
    dto: UpdateDiscordSettingsDto,
    ip: string | null,
  ): Promise<DiscordBotSettingsDto> {
    const settings = await this.sync.getSettings(user.regimentId);
    const kickWas = settings.kickOnBan;

    if (dto.botEnabled !== undefined) settings.botEnabled = dto.botEnabled;
    if (dto.announcementChannelId !== undefined)
      settings.announcementChannelId = dto.announcementChannelId;
    if (dto.welcomeChannelId !== undefined) settings.welcomeChannelId = dto.welcomeChannelId;
    if (dto.welcomeMessage !== undefined) settings.welcomeMessage = dto.welcomeMessage;
    if (dto.joinRoleId !== undefined) settings.joinRoleId = dto.joinRoleId;
    if (dto.joinRoleName !== undefined) settings.joinRoleName = dto.joinRoleName;
    if (dto.syncRolesOnChange !== undefined) settings.syncRolesOnChange = dto.syncRolesOnChange;
    if (dto.kickOnBan !== undefined) settings.kickOnBan = dto.kickOnBan;

    const saved = await this.settings.save(settings);

    const kickChanged = dto.kickOnBan !== undefined && dto.kickOnBan !== kickWas;
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.connection.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', label: 'settings' },
      detail: kickChanged
        ? `Bot settings updated — kickOnBan ${saved.kickOnBan ? 'ENABLED' : 'disabled'} (sensitive)`
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

  /** Enqueue an announcement broadcast to Discord. */
  async announce(
    user: AuthenticatedUser,
    dto: AnnounceDto,
    ip: string | null,
  ): Promise<{ enqueued: boolean }> {
    const job = await this.sync.enqueueAnnounce(user.regimentId, dto.content, dto.channelId);
    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.announce',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'discord', label: 'announce' },
      detail: job ? 'Announcement queued' : 'Announcement not queued (bot disabled or no channel)',
    });
    return { enqueued: !!job };
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
