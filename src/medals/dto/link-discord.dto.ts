import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for POST /api/medals/:id/link-discord. Sets the Discord role mapping and
 * flags the medal as linked. `discordRoleId` is a Discord snowflake (≤20 chars).
 */
export class LinkDiscordDto {
  @ApiProperty({
    maxLength: 20,
    description: 'Discord role id (snowflake)',
    example: '123456789012345678',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  discordRoleId: string;

  @ApiPropertyOptional({ maxLength: 80, description: 'Mapped Discord role name' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  discordRoleName?: string;
}
