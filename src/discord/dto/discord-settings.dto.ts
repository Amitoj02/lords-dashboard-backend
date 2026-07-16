import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { DiscordBotSettings } from '../entities/discord-bot-settings.entity';

/** The regiment's Discord bot configuration (read). */
export class DiscordBotSettingsDto {
  @ApiProperty() botEnabled: boolean;
  @ApiProperty({ nullable: true }) welcomeChannelId: string | null;
  @ApiProperty({ nullable: true }) welcomeMessage: string | null;
  @ApiProperty({ nullable: true }) enlistmentChannelId: string | null;
  @ApiProperty({ nullable: true }) enlistmentChannelName: string | null;
  @ApiProperty({ nullable: true }) auditLogChannelId: string | null;
  @ApiProperty({ nullable: true }) auditLogChannelName: string | null;
  @ApiProperty({ nullable: true }) eventAnnouncementChannelId: string | null;
  @ApiProperty({ nullable: true }) eventAnnouncementChannelName: string | null;
  @ApiProperty({ nullable: true }) joinRoleId: string | null;
  @ApiProperty() joinRoleName: string;
  @ApiProperty({ nullable: true, description: 'Role applied on an app-side ban.' })
  banRoleId: string | null;
  @ApiProperty({ nullable: true }) banRoleName: string | null;
  @ApiProperty() syncRolesOnChange: boolean;
  @ApiProperty({
    description: '⚠ When true, an app ban strips managed roles and applies the Ban role.',
  })
  applyBanRoleOnBan: boolean;

  static from(s: DiscordBotSettings): DiscordBotSettingsDto {
    return {
      botEnabled: s.botEnabled,
      welcomeChannelId: s.welcomeChannelId,
      welcomeMessage: s.welcomeMessage,
      enlistmentChannelId: s.enlistmentChannelId,
      enlistmentChannelName: s.enlistmentChannelName,
      auditLogChannelId: s.auditLogChannelId,
      auditLogChannelName: s.auditLogChannelName,
      eventAnnouncementChannelId: s.eventAnnouncementChannelId,
      eventAnnouncementChannelName: s.eventAnnouncementChannelName,
      joinRoleId: s.joinRoleId,
      joinRoleName: s.joinRoleName,
      banRoleId: s.banRoleId,
      banRoleName: s.banRoleName,
      syncRolesOnChange: s.syncRolesOnChange,
      applyBanRoleOnBan: s.applyBanRoleOnBan,
    };
  }
}

/** Partial update of the Discord bot configuration. */
export class UpdateDiscordSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() botEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) welcomeChannelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) welcomeMessage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) enlistmentChannelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) enlistmentChannelName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) auditLogChannelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) auditLogChannelName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  eventAnnouncementChannelId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  eventAnnouncementChannelName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) joinRoleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) joinRoleName?: string;
  @ApiPropertyOptional({ description: 'Role snowflake applied on an app-side ban.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  banRoleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) banRoleName?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() syncRolesOnChange?: boolean;

  @ApiPropertyOptional({
    description:
      '⚠ SENSITIVE: when enabled, an app-side ban STRIPS the member’s managed Discord roles ' +
      'and applies the configured Ban role. Off by default; requires a Ban role to be set ' +
      'first and an explicit, deliberate opt-in.',
  })
  @IsOptional()
  @IsBoolean()
  applyBanRoleOnBan?: boolean;
}
