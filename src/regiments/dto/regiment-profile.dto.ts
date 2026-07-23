import { ApiProperty } from '@nestjs/swagger';
import { PresentationDto } from '../../settings/dto/presentation.dto';
import { RegimentSettings } from '../entities/regiment-settings.entity';
import { Regiment } from '../entities/regiment.entity';

/**
 * Public profile projection of a {@link Regiment}. Never expose the raw entity:
 * internal identity/ownership fields (`discordServerId`, `ownerMemberId`) and
 * setup bookkeeping are omitted. `memberCount` is computed server-side.
 */
export class RegimentProfileDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

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

  @ApiProperty({ nullable: true })
  discordServerName: string | null;

  @ApiProperty({ description: 'Whether the first-run setup wizard is finished' })
  setupComplete: boolean;

  @ApiProperty({ description: 'Count of non-deleted members in the regiment' })
  memberCount: number;

  @ApiProperty({
    description:
      'Whether the mercenary enlistment track is currently offered. The public apply ' +
      'form hides the Mercenary option when false; the API refuses that track anyway (T-0137)',
  })
  allowMercenaries: boolean;

  @ApiProperty({
    type: PresentationDto,
    description:
      'Admin-authored presentation for the landing + sign-in pages (T-0147). Every field is ' +
      'nullable; null means the client should render its shipped default. This rides on the ' +
      'ANONYMOUS profile because both consuming pages are unauthenticated — the sign-in page ' +
      'in particular cannot read anything behind a capability gate.',
  })
  presentation: PresentationDto;

  /**
   * Build the public projection from a regiment, its computed member count, and
   * its settings row (T-0137 mercenary toggle + T-0147 presentation).
   *
   * `settings` is nullable because a regiment mid-first-run may not have its
   * 1—1 row yet; that degrades to the documented defaults (mercenaries allowed,
   * presentation all-null) rather than failing the landing page.
   */
  static from(
    regiment: Regiment,
    memberCount: number,
    settings: RegimentSettings | null,
  ): RegimentProfileDto {
    // A settings object that OMITS the column must stay permissive — the same
    // `=== false` shape the mercenary guards use, never a truthiness check.
    const allowMercenaries = settings ? settings.allowMercenaries !== false : true;
    const dto = new RegimentProfileDto();
    dto.id = regiment.id;
    dto.name = regiment.name;
    dto.missionStatement = regiment.missionStatement;
    dto.accentTone = regiment.accentTone;
    dto.crestUrl = regiment.crestUrl;
    dto.bannerUrl = regiment.bannerUrl;
    dto.establishedYear = regiment.establishedYear;
    dto.establishedAt = regiment.establishedAt;
    dto.discordInviteUrl = regiment.discordInviteUrl;
    dto.discordServerName = regiment.discordServerName;
    dto.setupComplete = regiment.setupComplete;
    dto.memberCount = memberCount;
    dto.allowMercenaries = allowMercenaries;
    dto.presentation = PresentationDto.from(settings);
    return dto;
  }
}
