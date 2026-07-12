import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { DiscordBotSettings } from '../entities/discord-bot-settings.entity';

/** The regiment's Discord bot configuration (read). */
export class DiscordBotSettingsDto {
  @ApiProperty() botEnabled: boolean;
  @ApiProperty({ nullable: true }) announcementChannelId: string | null;
  @ApiProperty({ nullable: true }) welcomeChannelId: string | null;
  @ApiProperty({ nullable: true }) welcomeMessage: string | null;
  @ApiProperty({ nullable: true }) joinRoleId: string | null;
  @ApiProperty() joinRoleName: string;
  @ApiProperty() syncRolesOnChange: boolean;
  @ApiProperty({ description: '⚠ When true, an app ban also kicks the member from Discord.' })
  kickOnBan: boolean;

  static from(s: DiscordBotSettings): DiscordBotSettingsDto {
    return {
      botEnabled: s.botEnabled,
      announcementChannelId: s.announcementChannelId,
      welcomeChannelId: s.welcomeChannelId,
      welcomeMessage: s.welcomeMessage,
      joinRoleId: s.joinRoleId,
      joinRoleName: s.joinRoleName,
      syncRolesOnChange: s.syncRolesOnChange,
      kickOnBan: s.kickOnBan,
    };
  }
}

/** Partial update of the Discord bot configuration. */
export class UpdateDiscordSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() botEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) announcementChannelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) welcomeChannelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) welcomeMessage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) joinRoleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) joinRoleName?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() syncRolesOnChange?: boolean;

  @ApiPropertyOptional({
    description:
      '⚠ SENSITIVE: enabling this makes an app-side ban ALSO kick the member from the ' +
      'Discord guild. Off by default; requires an explicit, deliberate opt-in.',
  })
  @IsOptional()
  @IsBoolean()
  kickOnBan?: boolean;
}
