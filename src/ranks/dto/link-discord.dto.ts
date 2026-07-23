import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** A Discord snowflake: 17–20 digits, nothing else (LDA-H1). */
export const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

/**
 * Body for POST /api/ranks/:id/link-discord. Binds the rank to a Discord role
 * (its snowflake id, and optionally a fresh display name) and flips `linked` on.
 */
export class LinkDiscordDto {
  @ApiProperty({ maxLength: 20, example: '112233445566778899', description: 'Discord role id' })
  @IsString()
  @MaxLength(20)
  @Matches(DISCORD_SNOWFLAKE, {
    message: 'discordRoleId must be a Discord snowflake (17–20 digits)',
  })
  discordRoleId: string;

  @ApiPropertyOptional({ maxLength: 80, example: '@Sergeant' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  discordRoleName?: string;
}
