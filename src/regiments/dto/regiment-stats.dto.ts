import { ApiProperty } from '@nestjs/swagger';
import { MemberRole } from '../../common/enums';

/** Per-role member breakdown (every role key present, defaulting to 0). */
export type MembersByRole = Record<MemberRole, number>;

/**
 * Landing-page statistics for the (single) regiment. All counters are computed
 * server-side with grouped COUNT queries — no rows are loaded into memory.
 */
export class RegimentStatsDto {
  @ApiProperty({
    description: 'Enrolled members (non-deleted; excludes Applicants)',
  })
  totalMembers: number;

  @ApiProperty({ description: 'Members whose status is Active' })
  activeMembers: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Map of member role → count (non-deleted members)',
  })
  membersByRole: MembersByRole;

  @ApiProperty({ description: 'Total non-deleted events for the regiment' })
  totalEvents: number;

  @ApiProperty({ description: 'Upcoming, non-archived events' })
  upcomingEvents: number;

  @ApiProperty({ description: 'Previous (concluded) events' })
  previousEvents: number;

  @ApiProperty({ nullable: true, description: 'Year the regiment was established' })
  establishedYear: number | null;
}
