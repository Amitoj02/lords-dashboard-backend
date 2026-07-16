import { ApiProperty } from '@nestjs/swagger';
import { RegimentSettings } from '../../regiments/entities/regiment-settings.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';

/**
 * The full regiment control-panel projection: the editable regiment profile
 * (identity/branding/Discord binding) merged with every row of its 1—1
 * `regiment_settings` (privacy toggles, gallery/event/audit policy). Backs
 * `GET /api/settings`. No secrets live on either source entity, so every field
 * is safe to surface to a caller holding ManageSettings.
 */
export class SettingsDto {
  // ── Regiment profile ─────────────────────────────────────────────────────────

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  missionStatement: string | null;

  @ApiProperty({ description: 'Accent-tone key from the accent_tones lookup' })
  accentTone: string;

  @ApiProperty({ nullable: true })
  crestUrl: string | null;

  @ApiProperty({ nullable: true })
  bannerUrl: string | null;

  @ApiProperty({ nullable: true })
  establishedYear: number | null;

  @ApiProperty({ nullable: true, description: 'Full establishment date (YYYY-MM-DD)' })
  establishedAt: string | null;

  @ApiProperty({ nullable: true })
  discordInviteUrl: string | null;

  @ApiProperty({ nullable: true, description: 'Bound Discord guild id (snowflake)' })
  discordServerId: string | null;

  @ApiProperty({ nullable: true })
  discordServerName: string | null;

  @ApiProperty({
    description: 'False until the Owner has completed first-run setup (drives first-run routing).',
  })
  setupComplete: boolean;

  // ── Privacy toggles ──────────────────────────────────────────────────────────

  @ApiProperty()
  publicGallery: boolean;

  @ApiProperty()
  publicEvents: boolean;

  @ApiProperty()
  publicStats: boolean;

  @ApiProperty()
  openRecruitment: boolean;

  @ApiProperty()
  showOfficersMessOnLanding: boolean;

  @ApiProperty()
  allowMercenaries: boolean;

  @ApiProperty()
  autoApproveTrustedMembers: boolean;

  // ── Gallery policy ───────────────────────────────────────────────────────────

  @ApiProperty()
  galleryMaxImageSizeMb: number;

  @ApiProperty()
  galleryMaxVideoSizeMb: number;

  @ApiProperty()
  galleryMaxItemsPerSubmission: number;

  @ApiProperty({ type: [String], nullable: true })
  galleryAllowedImageTypes: string[] | null;

  @ApiProperty({ type: [String], nullable: true })
  galleryAllowedVideoTypes: string[] | null;

  // ── Event + audit policy ─────────────────────────────────────────────────────

  @ApiProperty()
  eventDefaultTimezone: string;

  @ApiProperty({ nullable: true, description: 'Default HH:mm start time for new events' })
  eventDefaultStartTime: string | null;

  @ApiProperty({
    type: [Number],
    nullable: true,
    description: 'Default notify-before offsets (min)',
  })
  eventDefaultNotifyBefore: number[] | null;

  @ApiProperty()
  auditRetentionMonths: number;

  /** Merge a regiment and its (possibly defaulted) settings row into one DTO. */
  static from(regiment: Regiment, settings: RegimentSettings): SettingsDto {
    const dto = new SettingsDto();
    dto.name = regiment.name;
    dto.missionStatement = regiment.missionStatement;
    dto.accentTone = regiment.accentTone;
    dto.crestUrl = regiment.crestUrl;
    dto.bannerUrl = regiment.bannerUrl;
    dto.establishedYear = regiment.establishedYear;
    dto.establishedAt = regiment.establishedAt;
    dto.discordInviteUrl = regiment.discordInviteUrl;
    dto.discordServerId = regiment.discordServerId;
    dto.discordServerName = regiment.discordServerName;
    dto.setupComplete = regiment.setupComplete;
    dto.publicGallery = settings.publicGallery;
    dto.publicEvents = settings.publicEvents;
    dto.publicStats = settings.publicStats;
    dto.openRecruitment = settings.openRecruitment;
    dto.showOfficersMessOnLanding = settings.showOfficersMessOnLanding;
    dto.allowMercenaries = settings.allowMercenaries;
    dto.autoApproveTrustedMembers = settings.autoApproveTrustedMembers;
    dto.galleryMaxImageSizeMb = settings.galleryMaxImageSizeMb;
    dto.galleryMaxVideoSizeMb = settings.galleryMaxVideoSizeMb;
    dto.galleryMaxItemsPerSubmission = settings.galleryMaxItemsPerSubmission;
    dto.galleryAllowedImageTypes = settings.galleryAllowedImageTypes;
    dto.galleryAllowedVideoTypes = settings.galleryAllowedVideoTypes;
    dto.eventDefaultTimezone = settings.eventDefaultTimezone;
    dto.eventDefaultStartTime = settings.eventDefaultStartTime;
    dto.eventDefaultNotifyBefore = settings.eventDefaultNotifyBefore;
    dto.auditRetentionMonths = settings.auditRetentionMonths;
    return dto;
  }
}
