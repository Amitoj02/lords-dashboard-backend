import { ApiProperty } from '@nestjs/swagger';
import { BotConnectionStatus } from '../../common/enums';
import { BotOperation } from '../entities/bot-operation.entity';
import { DiscordConnection } from '../entities/discord-connection.entity';
import { DiscordChannel, DiscordGatewayStatus, DiscordRole } from '../gateway/discord-gateway';

/** Live bot connection + authority snapshot for the wizard / bot-status screen. */
export class DiscordConnectionDto {
  @ApiProperty() connected: boolean;
  @ApiProperty({ enum: BotConnectionStatus }) connectionStatus: BotConnectionStatus;
  @ApiProperty({ nullable: true }) botVersion: string | null;
  @ApiProperty({ nullable: true }) totalRoles: number | null;
  @ApiProperty({ nullable: true }) botRolePosition: number | null;
  @ApiProperty({ nullable: true }) membersVisible: number | null;
  @ApiProperty({ nullable: true }) lastHeartbeatAt: string | null;
  @ApiProperty({ nullable: true }) lastFullSyncAt: string | null;
  // ── Live runtime metrics (T-0076) ───────────────────────────────────────────
  @ApiProperty({ nullable: true, description: 'WebSocket heartbeat latency (ms)' })
  wsPing: number | null;
  @ApiProperty({ nullable: true, description: 'Gateway connection uptime (ms)' })
  uptimeMs: number | null;
  @ApiProperty({ nullable: true, description: 'Bot process resident memory (bytes)' })
  memoryBytes: number | null;
  @ApiProperty({ nullable: true, description: 'Process-average CPU utilization (%)' })
  cpu: number | null;
  @ApiProperty({ nullable: true, description: 'ISO timestamp the gateway became ready' })
  readyAt: string | null;

  static from(
    status: DiscordGatewayStatus,
    connection: DiscordConnection | null,
  ): DiscordConnectionDto {
    return {
      connected: status.connected,
      connectionStatus: connection?.connectionStatus ?? BotConnectionStatus.Idle,
      botVersion: status.botVersion ?? connection?.botVersion ?? null,
      totalRoles: status.totalRoles ?? connection?.totalRoles ?? null,
      botRolePosition: status.botRolePosition ?? connection?.botRolePosition ?? null,
      membersVisible: status.membersVisible ?? connection?.membersVisible ?? null,
      lastHeartbeatAt: connection?.lastHeartbeatAt
        ? connection.lastHeartbeatAt.toISOString()
        : null,
      lastFullSyncAt: connection?.lastFullSyncAt ? connection.lastFullSyncAt.toISOString() : null,
      wsPing: status.wsPing,
      uptimeMs: status.uptimeMs,
      memoryBytes: status.memoryBytes,
      cpu: status.cpu,
      readyAt: status.readyAt,
    };
  }
}

/**
 * Lean, STAFF-safe bot status for the dashboard widget (T-0077). Deliberately
 * OMITS the sensitive authority/config fields the wizard needs (botRolePosition,
 * permissions, ban config) — it carries only online/offline + the live runtime
 * metrics + last-activity timestamps, so Owner/Admin/Moderator can see whether
 * the Quartermaster is healthy without exposing settings surface.
 */
export class BotStatusDto {
  @ApiProperty() connected: boolean;
  @ApiProperty({ enum: BotConnectionStatus }) connectionStatus: BotConnectionStatus;
  @ApiProperty({ nullable: true }) botVersion: string | null;
  @ApiProperty({ nullable: true }) membersVisible: number | null;
  @ApiProperty({ nullable: true }) totalRoles: number | null;
  @ApiProperty({ nullable: true, description: 'WebSocket heartbeat latency (ms)' })
  wsPing: number | null;
  @ApiProperty({ nullable: true, description: 'Gateway connection uptime (ms)' })
  uptimeMs: number | null;
  @ApiProperty({ nullable: true, description: 'Bot process resident memory (bytes)' })
  memoryBytes: number | null;
  @ApiProperty({ nullable: true, description: 'Process-average CPU utilization (%)' })
  cpu: number | null;
  @ApiProperty({ nullable: true, description: 'ISO timestamp the gateway became ready' })
  readyAt: string | null;
  @ApiProperty({ nullable: true }) lastHeartbeatAt: string | null;
  @ApiProperty({ nullable: true }) lastFullSyncAt: string | null;

  static from(status: DiscordGatewayStatus, connection: DiscordConnection | null): BotStatusDto {
    return {
      connected: status.connected,
      connectionStatus: connection?.connectionStatus ?? BotConnectionStatus.Idle,
      botVersion: status.botVersion ?? connection?.botVersion ?? null,
      membersVisible: status.membersVisible ?? connection?.membersVisible ?? null,
      totalRoles: status.totalRoles ?? connection?.totalRoles ?? null,
      wsPing: status.wsPing,
      uptimeMs: status.uptimeMs,
      memoryBytes: status.memoryBytes,
      cpu: status.cpu,
      readyAt: status.readyAt,
      lastHeartbeatAt: connection?.lastHeartbeatAt
        ? connection.lastHeartbeatAt.toISOString()
        : null,
      lastFullSyncAt: connection?.lastFullSyncAt ? connection.lastFullSyncAt.toISOString() : null,
    };
  }
}

/** A guild role, for the role pickers (join role, Ban role). */
export class DiscordRoleDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() position: number;
}

/** A guild text channel, for the channel pickers (announcements, routing). */
export class DiscordChannelDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
}

/**
 * verify-connection response: the connection snapshot plus the guild's roles and
 * text channels, so the Settings pickers (join/Ban roles, routed channels) can
 * populate from one call. Roles/channels are empty when the bot is disconnected.
 */
export class DiscordVerifyConnectionDto extends DiscordConnectionDto {
  @ApiProperty({ type: [DiscordRoleDto] }) roles: DiscordRoleDto[];
  @ApiProperty({ type: [DiscordChannelDto] }) channels: DiscordChannelDto[];

  static fromStatus(
    status: DiscordGatewayStatus,
    connection: DiscordConnection | null,
    roles: DiscordRole[],
    channels: DiscordChannel[],
  ): DiscordVerifyConnectionDto {
    return {
      ...DiscordConnectionDto.from(status, connection),
      roles: roles.map((r) => ({ id: r.id, name: r.name, position: r.position })),
      channels: channels.map((c) => ({ id: c.id, name: c.name })),
    };
  }
}

/** One recorded bot operation (a drained sync job's outcome). */
export class BotOperationDto {
  @ApiProperty() id: string;
  @ApiProperty() occurredAt: string;
  @ApiProperty() operation: string;
  @ApiProperty() success: boolean;
  @ApiProperty({ description: 'True while an admin has not yet resolved a failed op.' })
  resolvable: boolean;

  static from(op: BotOperation): BotOperationDto {
    return {
      id: op.id,
      occurredAt: op.occurredAt.toISOString(),
      operation: op.operation,
      success: op.success,
      resolvable: op.resolvable,
    };
  }
}
