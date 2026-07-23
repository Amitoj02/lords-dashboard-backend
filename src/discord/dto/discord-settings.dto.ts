import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { DiscordBotSettings } from '../entities/discord-bot-settings.entity';
import { WELCOME_TOKENS } from '../embeds/notification-embeds';

/**
 * The welcome-message placeholder contract, rendered for Swagger from the SAME
 * array the composer expands (T-0185) — so the documented tokens cannot drift
 * from the tokens that actually work.
 */
const WELCOME_TOKEN_HINT = WELCOME_TOKENS.map((t) => `\`${t.token}\` — ${t.renders}`).join('; ');

/** The regiment's Discord bot configuration (read). */
export class DiscordBotSettingsDto {
  @ApiProperty() botEnabled: boolean;
  @ApiProperty({ nullable: true }) welcomeChannelId: string | null;
  @ApiProperty({
    nullable: true,
    description:
      'Greeting posted when a member joins the guild. NULL means "use the house default" — ' +
      `a blank message is stored as NULL. Supported placeholders: ${WELCOME_TOKEN_HINT}. ` +
      'Unknown placeholders are left as literal text.',
  })
  welcomeMessage: string | null;
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
  @ApiProperty({
    description:
      'Master switch for guild-membership gating (T-0167). Default false: with no bot ' +
      'connected every membership verdict would be wrong, so the gate stays off until the ' +
      'regiment deliberately turns it on.',
  })
  guildGateEnabled: boolean;

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
      guildGateEnabled: s.guildGateEnabled,
    };
  }
}

/** Partial update of the Discord bot configuration. */
export class UpdateDiscordSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() botEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) welcomeChannelId?: string;
  // `| null` is not decoration: the settings editor round-trips the stored value
  // and PATCHes it back, so it genuinely posts `welcomeMessage: null` whenever
  // no greeting is configured. `@IsOptional()` lets null through validation, so
  // the normaliser in DiscordService.updateSettings must handle it — typing it
  // as `string` would make that a runtime TypeError on a live payload (T-0184).
  @ApiPropertyOptional({
    maxLength: 512,
    nullable: true,
    description:
      'Greeting posted when a member joins the guild. Trimmed on save; blank, whitespace-only ' +
      `or null clears it back to the house default. Supported placeholders: ${WELCOME_TOKEN_HINT}. ` +
      'Unknown placeholders are left as literal text. Omit the field to leave the stored value ' +
      'untouched.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  welcomeMessage?: string | null;
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

  @ApiPropertyOptional({
    description:
      '⚠ SENSITIVE: when enabled, members who are not in the regiment Discord guild are ' +
      'gated out of the dashboard. Off by default. manage_settings holders are always ' +
      'exempt, so turning this on cannot lock you out of turning it back off.',
  })
  @IsOptional()
  @IsBoolean()
  guildGateEnabled?: boolean;
}
