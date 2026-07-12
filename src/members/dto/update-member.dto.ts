import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';
import { Platform } from '../../common/enums';

/**
 * Self-service profile patch. Deliberately restricted to a small set of fields a
 * member may change about themselves — including their own display name — while
 * role/status/rank remain NOT editable here (those belong to a future admin
 * members endpoint). Every field is optional; only provided fields are applied.
 */
export class UpdateMemberDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 120,
    description: 'Display name shown across the roster and profile',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    enum: Platform,
    description: 'Gaming platform the member plays on',
  })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({
    maxLength: 40,
    description: 'IANA/display timezone, e.g. "America/Toronto"',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  timezone?: string;

  @ApiPropertyOptional({
    maxLength: 120,
    description: 'In-game display name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  inGameName?: string;

  // TODO(storage): this is a plain URL today. When real avatar uploads land,
  // accept an upload and replace this with the resulting CDN URL server-side.
  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Absolute URL to the member avatar image',
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(512)
  avatarUrl?: string;
}
