import { ApiProperty } from '@nestjs/swagger';
import { Rank } from '../entities/rank.entity';

/**
 * Response projection of a {@link Rank}. Exposes the editable ladder fields plus
 * the server-computed `holdersCount` (how many members currently sit at this
 * rank). The FK `regimentId` is intentionally omitted — the API is single-tenant
 * and the caller's regiment is implicit from the JWT.
 */
export class RankDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true, description: 'Public URL of the uploaded rank image' })
  imageUrl: string | null;

  @ApiProperty({ description: 'Ladder position (lower sorts higher; 1 = top)' })
  precedence: number;

  @ApiProperty({ nullable: true, description: 'Display name of the mapped Discord role' })
  discordRoleName: string | null;

  @ApiProperty({ nullable: true, description: 'Snowflake id of the linked Discord role' })
  discordRoleId: string | null;

  @ApiProperty({ description: 'Whether the rank is linked to a Discord role' })
  linked: boolean;

  @ApiProperty({ description: 'Number of members currently holding this rank' })
  holdersCount: number;

  @ApiProperty({ description: 'ISO timestamp the rank was created' })
  createdAt: string;

  @ApiProperty({ description: 'ISO timestamp the rank was last updated' })
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

  /**
   * Build the projection from a rank plus its computed holder count. The count is
   * derived server-side (a grouped members query), never read off the entity.
   *
   * `relinkBatchId` is omitted rather than nulled when no bulk run was queued, so
   * the field never appears on the list projection at all.
   */
  static from(rank: Rank, holdersCount: number, relinkBatchId?: string | null): RankDto {
    const dto = new RankDto();
    if (relinkBatchId) {
      dto.relinkBatchId = relinkBatchId;
    }
    dto.id = rank.id;
    dto.name = rank.name;
    dto.imageUrl = rank.imageUrl;
    dto.precedence = rank.precedence;
    dto.discordRoleName = rank.discordRoleName;
    dto.discordRoleId = rank.discordRoleId;
    dto.linked = rank.linked;
    dto.holdersCount = holdersCount;
    dto.createdAt = rank.createdAt.toISOString();
    dto.updatedAt = rank.updatedAt.toISOString();
    return dto;
  }
}
