import { ApiProperty } from '@nestjs/swagger';
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

  /**
   * Build the public projection from a regiment, its computed member count, and
   * the mercenary-track toggle read from the regiment's settings row (T-0137).
   */
  static from(
    regiment: Regiment,
    memberCount: number,
    allowMercenaries: boolean,
  ): RegimentProfileDto {
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
    return dto;
  }
}
