import { ApiProperty } from '@nestjs/swagger';
import { MedalRibbon } from '../../common/enums';
import { Medal } from '../entities/medal.entity';

/**
 * Catalogue projection of a {@link Medal}. Never expose the raw entity: the FK
 * `regimentId` and relation objects are omitted. `holdersCount`/`awardsCount`
 * are derived server-side from the member_medals junction — a medal may be
 * awarded to the same member more than once, so the two differ (distinct holders
 * vs. total award rows).
 */
export class MedalDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ description: 'Short glyph/abbreviation (1..4 chars)' })
  glyph: string;

  @ApiProperty({ enum: MedalRibbon })
  ribbon: MedalRibbon;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ description: 'Display order (lower sorts first)' })
  precedence: number;

  @ApiProperty({ nullable: true, description: 'Mapped Discord role name' })
  discordRoleName: string | null;

  @ApiProperty({ nullable: true, description: 'Mapped Discord role id (snowflake)' })
  discordRoleId: string | null;

  @ApiProperty({ description: 'Whether the medal is linked to a Discord role' })
  linked: boolean;

  @ApiProperty({ description: 'Distinct members who currently hold this medal' })
  holdersCount: number;

  @ApiProperty({ description: 'Total times this medal has been awarded (all rows)' })
  awardsCount: number;

  @ApiProperty({ description: 'ISO timestamp the medal was created' })
  createdAt: string;

  @ApiProperty({ description: 'ISO timestamp the medal was last updated' })
  updatedAt: string;

  /**
   * Build the projection from a medal plus its derived award counts. The caller
   * is responsible for computing `holdersCount` (distinct members) and
   * `awardsCount` (total award rows) — usually batched for the whole list.
   */
  static from(medal: Medal, holdersCount: number, awardsCount: number): MedalDto {
    const dto = new MedalDto();
    dto.id = medal.id;
    dto.title = medal.title;
    dto.glyph = medal.glyph;
    dto.ribbon = medal.ribbon;
    dto.description = medal.description;
    dto.precedence = medal.precedence;
    dto.discordRoleName = medal.discordRoleName;
    dto.discordRoleId = medal.discordRoleId;
    dto.linked = medal.linked;
    dto.holdersCount = holdersCount;
    dto.awardsCount = awardsCount;
    dto.createdAt = medal.createdAt.toISOString();
    dto.updatedAt = medal.updatedAt.toISOString();
    return dto;
  }
}
