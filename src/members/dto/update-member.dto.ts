import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Self-service profile patch. Deliberately restricted to a small set of fields a
 * member may change about themselves — their in-game name (the sole display
 * identity) and avatar/banner — while role/status/rank remain NOT editable here
 * (those belong to a future admin members endpoint). Every field is optional;
 * only provided fields are applied.
 */
export class UpdateMemberDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 120,
    description: 'In-game name — the sole display identity across the roster and profile',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  inGameName?: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Storage key of an uploaded avatar image (from POST /storage/uploads)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  avatarKey?: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Storage key of an uploaded banner image (from POST /storage/uploads)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  bannerKey?: string;
}
