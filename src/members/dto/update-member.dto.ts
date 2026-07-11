import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { Platform } from '../../common/enums';

/**
 * Self-service profile patch. Deliberately restricted to a small set of fields a
 * member may change about themselves — role/status/rank/name are NOT editable
 * here (those belong to a future admin members endpoint). Every field is optional;
 * only provided fields are applied.
 */
export class UpdateMemberDto {
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
