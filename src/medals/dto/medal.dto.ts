import { ApiProperty } from '@nestjs/swagger';
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

  @ApiProperty({ description: 'Short glyph/abbreviation (1..4 chars), used as the fallback label' })
  glyph: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true, description: 'Public URL of the uploaded medal image' })
  imageUrl: string | null;

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

  @ApiProperty({
    nullable: true,
    required: false,
    description:
      'Set ONLY on the link/unlink responses, and only when that change actually queued a bulk ' +
      'role re-sync (T-0158). It is the handle the admin UI polls for progress and cancels with ' +
      'via /api/discord/relink/:batchId — without it the client has just triggered a background ' +
      'run it has no way to name. Absent on every list/read projection.',
  })
  relinkBatchId?: string | null;

  @ApiProperty({
    nullable: true,
    required: false,
    description:
      'Advisory set ONLY on the link response, and only when the role just linked carries ' +
      'privileged Discord permissions (T-0189). The link SUCCEEDED — this is something to ' +
      'show the admin, not an error to handle. Absent on every other projection.',
  })
  discordRoleWarning?: string | null;

  /**
   * Build the projection from a medal plus its derived award counts. The caller
   * is responsible for computing `holdersCount` (distinct members) and
   * `awardsCount` (total award rows) — usually batched for the whole list.
   *
   * `relinkBatchId` and `discordRoleWarning` are omitted rather than nulled when
   * there is nothing to say, so neither field appears on the list projection.
   */
  static from(
    medal: Medal,
    holdersCount: number,
    awardsCount: number,
    relinkBatchId?: string | null,
    discordRoleWarning?: string | null,
  ): MedalDto {
    const dto = new MedalDto();
    if (relinkBatchId) {
      dto.relinkBatchId = relinkBatchId;
    }
    if (discordRoleWarning) {
      dto.discordRoleWarning = discordRoleWarning;
    }
    dto.id = medal.id;
    dto.title = medal.title;
    dto.glyph = medal.glyph;
    dto.description = medal.description;
    dto.imageUrl = medal.imageUrl;
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
