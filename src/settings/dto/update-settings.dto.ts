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
} from 'class-validator';

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

  @ApiPropertyOptional({ maxLength: 6 })
  @IsOptional()
  @IsString()
  @MaxLength(6)
  shortTag?: string;

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
  publicRoster?: boolean;

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
