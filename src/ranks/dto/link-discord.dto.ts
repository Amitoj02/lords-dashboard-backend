import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /api/ranks/:id/link-discord. Binds the rank to a Discord role
 * (its snowflake id, and optionally a fresh display name) and flips `linked` on.
 */
export class LinkDiscordDto {
  @ApiProperty({ maxLength: 20, example: '112233445566778899', description: 'Discord role id' })
  @IsString()
  @MaxLength(20)
  discordRoleId: string;

  @ApiPropertyOptional({ maxLength: 80, example: '@Sergeant' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  discordRoleName?: string;
}
