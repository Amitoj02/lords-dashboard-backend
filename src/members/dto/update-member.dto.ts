import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsUsername, normalizeUsername } from '../../common/ids/username';

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
    nullable: true,
    minLength: 3,
    maxLength: 20,
    description:
      'Vanity handle backing /u/@handle. Lowercase letters, numbers and underscore, 3-20 ' +
      'characters. Send null to release the handle and fall back to the short-id URL. ' +
      'Changing it is limited to once every 30 days.',
  })
  @IsOptional()
  // `null` is a meaningful value here (release the handle), so the format check
  // has to be skipped for it rather than folded into @IsOptional — which only
  // skips `undefined`.
  @ValidateIf((_, value) => value !== null)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeUsername(value) : value,
  )
  @IsString()
  @IsUsername()
  username?: string | null;

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
