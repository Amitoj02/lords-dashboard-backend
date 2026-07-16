import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Validates a YYYY-MM-DD date for both SHAPE and CALENDAR validity, so an
 * impossible-but-well-formatted value (e.g. 2023-02-31, 2023-13-01, 0000-00-00)
 * is rejected with a clean 400 rather than reaching the MySQL DATE column and
 * 500ing under strict sql_mode.
 */
@ValidatorConstraint({ name: 'isCalendarDate', async: false })
export class IsCalendarDate implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  defaultMessage(): string {
    return 'establishedAt must be a valid YYYY-MM-DD calendar date';
  }
}

/**
 * Body for PATCH /api/settings. EVERY field is optional — only the provided,
 * whitelisted keys are applied (the rest are left untouched) and audited. Keys
 * split across two tables server-side: profile/branding on the regiment,
 * everything else on regiment_settings. The Discord GUILD binding
 * (`discordServerId`) is intentionally NOT editable here — it moves through the
 * dedicated `transfer-discord` action.
 */
export class UpdateSettingsDto {
  // ── Regiment profile ─────────────────────────────────────────────────────────

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  missionStatement?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  accentTone?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  crestUrl?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  bannerUrl?: string;

  @ApiPropertyOptional({ minimum: 1000, maximum: 9999 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(9999)
  establishedYear?: number;

  @ApiPropertyOptional({
    description: 'Full establishment date as YYYY-MM-DD',
    example: '2023-11-20',
  })
  @IsOptional()
  @Validate(IsCalendarDate)
  establishedAt?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  discordInviteUrl?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  discordServerName?: string;

  // ── Privacy toggles ──────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  publicGallery?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  publicEvents?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  publicStats?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  openRecruitment?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showOfficersMessOnLanding?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowMercenaries?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoApproveTrustedMembers?: boolean;

  // ── Gallery policy ───────────────────────────────────────────────────────────

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  galleryMaxImageSizeMb?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  galleryMaxVideoSizeMb?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  galleryMaxItemsPerSubmission?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  galleryAllowedImageTypes?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  galleryAllowedVideoTypes?: string[];

  // ── Event + audit policy ─────────────────────────────────────────────────────

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  eventDefaultTimezone?: string;

  @ApiPropertyOptional({ maxLength: 5, description: 'HH:mm' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  eventDefaultStartTime?: string;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  eventDefaultNotifyBefore?: number[];

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  auditRetentionMonths?: number;
}
