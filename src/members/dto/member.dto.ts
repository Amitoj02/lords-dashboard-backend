import { ApiProperty } from '@nestjs/swagger';
import { MemberRole, MemberStatus, Platform } from '../../common/enums';
import { Member } from '../entities/member.entity';

/** Computed/derived attendance metrics passed into the {@link MemberDto} mapper. */
export interface MemberMetrics {
  /** Number of past events this member has confirmed attendance for. */
  eventsAttended: number;
  /** Attendance percentage (0..100), rounded; 0 when there are no past events. */
  attendanceRate: number;
}

/**
 * Public roster projection of a {@link Member}. Never expose the raw entity:
 * secrets (Discord tokens live on the identity), internal flags and FK ids are
 * omitted. Rank/chevron/attendance fields are derived server-side.
 */
export class MemberDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  inGameName: string | null;

  @ApiProperty({ enum: MemberRole })
  role: MemberRole;

  @ApiProperty({ enum: MemberStatus })
  status: MemberStatus;

  @ApiProperty({ enum: Platform, nullable: true })
  platform: Platform | null;

  @ApiProperty({ nullable: true })
  timezone: string | null;

  @ApiProperty({ nullable: true, description: 'Rank name (from the rank ladder)' })
  rank: string | null;

  @ApiProperty({ description: 'Chevron count for the rank (0 when unranked)' })
  chevrons: number;

  @ApiProperty({ nullable: true, description: 'Rank precedence (lower sorts higher)' })
  rankPrecedence: number | null;

  @ApiProperty({ nullable: true, description: 'Linked Discord tag, e.g. "@user"' })
  discordTag: string | null;

  @ApiProperty()
  discordLinked: boolean;

  @ApiProperty()
  publicProfile: boolean;

  @ApiProperty({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ nullable: true })
  bannerUrl: string | null;

  @ApiProperty({ nullable: true, description: 'Standing label (e.g. good/warning)' })
  standing: string | null;

  @ApiProperty({ nullable: true, description: 'ISO timestamp the member joined' })
  joinedAt: string | null;

  @ApiProperty({ nullable: true, description: 'ISO timestamp of last activity' })
  lastSeenAt: string | null;

  @ApiProperty({ description: 'Confirmed attendances at past events' })
  eventsAttended: number;

  @ApiProperty({ description: 'Attendance rate as a 0..100 percentage' })
  attendanceRate: number;

  // TODO(medals): a future MedalsModule will enrich this projection with the
  // member's awarded medals/ribbons. Intentionally omitted here.

  /**
   * Build the projection from a (rank-joined) member plus its computed metrics.
   * The caller is responsible for having joined `member.rank` and (optionally)
   * `member.discordIdentity` so the derived fields can be read.
   */
  static from(member: Member, metrics: MemberMetrics): MemberDto {
    const dto = new MemberDto();
    dto.id = member.id;
    dto.name = member.name;
    dto.inGameName = member.inGameName;
    dto.role = member.role;
    dto.status = member.status;
    dto.platform = member.platform;
    dto.timezone = member.timezone;
    dto.rank = member.rank?.name ?? null;
    dto.chevrons = member.rank?.chevrons ?? 0;
    dto.rankPrecedence = member.rank?.precedence ?? null;
    dto.discordTag = member.discordIdentity?.discordTag ?? null;
    dto.discordLinked = member.discordLinked;
    dto.publicProfile = member.publicProfile;
    dto.avatarUrl = member.avatarUrl;
    dto.bannerUrl = member.bannerUrl;
    dto.standing = member.standing;
    dto.joinedAt = member.joinedAt ? member.joinedAt.toISOString() : null;
    dto.lastSeenAt = member.lastSeenAt ? member.lastSeenAt.toISOString() : null;
    dto.eventsAttended = metrics.eventsAttended;
    dto.attendanceRate = metrics.attendanceRate;
    return dto;
  }
}
