import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsUsername, normalizeUsername } from '../../common/ids/username';
import { MEMBER_SOCIAL_PLATFORM_KEYS, SOCIAL_HANDLE_MAX_LENGTH } from '../social-platforms';

/**
 * One social account in a profile patch (T-0216).
 *
 * Only the platform key and the raw handle are accepted — deliberately NOT a
 * URL. The link is composed server-side from a hardcoded origin (see
 * `src/members/social-platforms.ts`), so no request body can widen the set of
 * hosts a member profile links out to.
 *
 * The shape check here is only the coarse one that class-validator can express:
 * a known platform, a string within the column width. The PER-PLATFORM handle
 * pattern is enforced in the service, because the rule couples two fields (the
 * pattern depends on `platform`) and because a rejection must name the platform
 * that failed — neither of which a per-property decorator can do. Nothing is
 * normalised here either: `normalizeSocialHandle` runs in the service beside the
 * pattern it feeds, so the value that is validated is exactly the value stored.
 */
export class UpdateMemberSocialLinkDto {
  @ApiProperty({ enum: [...MEMBER_SOCIAL_PLATFORM_KEYS] })
  @IsIn([...MEMBER_SOCIAL_PLATFORM_KEYS])
  platform: string;

  @ApiProperty({
    maxLength: SOCIAL_HANDLE_MAX_LENGTH,
    description:
      'Account name on that network, not a URL. A leading @ and a trailing / are stripped ' +
      'server-side; the remainder must match the handle pattern for that platform.',
  })
  @IsString()
  @MaxLength(SOCIAL_HANDLE_MAX_LENGTH)
  handle: string;
}

/**
 * Self-service profile patch. Deliberately restricted to a small set of fields a
 * member may change about themselves — their in-game name (the sole display
 * identity), their vanity handle, their avatar/banner, and the member-authored
 * half of their public profile (bio + social links) — while role/status/rank
 * remain NOT editable here (those belong to a future admin members endpoint).
 * Every field is optional; only provided fields are applied.
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

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 280,
    description:
      'Member-authored blurb on the public profile. Send null (or a whitespace-only string, ' +
      'which the service normalises to null) to clear it. 280 characters is a PRODUCT rule — ' +
      'the blurb sits beside the avatar and has to stay one paragraph — which is why it is ' +
      'enforced here and not by the column type (`text`).',
  })
  @IsOptional()
  // Same idiom as `username`: null is a meaningful value (clear the bio), and
  // @IsOptional only skips `undefined`, so the string checks have to be skipped
  // for null explicitly rather than folded into it.
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(280)
  bio?: string | null;

  @ApiPropertyOptional({
    type: [UpdateMemberSocialLinkDto],
    maxItems: MEMBER_SOCIAL_PLATFORM_KEYS.length,
    description:
      'The member’s complete set of social accounts. ABSENT leaves them untouched; PRESENT ' +
      'REPLACES them wholesale (delete-then-insert, as gallery tags do), so `[]` clears them. ' +
      'Rejected with 400 when a handle fails its platform pattern or a platform appears twice.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateMemberSocialLinkDto)
  // (member, platform) is the table's unique key, so the registry size IS the
  // whole set: one more entry than there are platforms can only be a duplicate,
  // and the cap turns that into a cheap 400 instead of work the service has to
  // undo. Derived from the registry rather than written as `7`, so adding a
  // network stays the one-line change social-platforms.ts promises it is.
  @ArrayMaxSize(MEMBER_SOCIAL_PLATFORM_KEYS.length)
  socialLinks?: UpdateMemberSocialLinkDto[];
}
