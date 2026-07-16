import { ApiProperty } from '@nestjs/swagger';
import { MedalRibbon, MemberRole, MemberStatus } from '../../common/enums';
import { Member } from '../entities/member.entity';

/** Computed/derived metrics passed into the {@link MemberDto} mapper. */
export interface MemberMetrics {
  /** Number of past events this member has confirmed attendance for. */
  eventsAttended: number;
}

/**
 * A single medal award held by the member. Because medals are repeatable, a
 * member may hold several awards of the same medal — each is its own summary
 * row (with its own `id` = member_medal id, so a specific award can be removed).
 */
export class MemberMedalSummary {
  @ApiProperty({ format: 'uuid', description: 'The award (member_medal) id' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  medalId: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  glyph: string;

  @ApiProperty({ enum: MedalRibbon })
  ribbon: MedalRibbon;

  @ApiProperty({ nullable: true })
  detail: string | null;

  @ApiProperty({ description: 'ISO timestamp the medal was awarded' })
  awardedAt: string;
}

/**
 * Public roster projection of a {@link Member}. Never expose the raw entity:
 * secrets (Discord tokens live on the identity), internal flags and FK ids are
 * omitted. Rank/chevron/attendance fields are derived server-side.
 */
export class MemberDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'In-game name — the sole display identity' })
  inGameName: string;

  @ApiProperty({ enum: MemberRole })
  role: MemberRole;

  @ApiProperty({ enum: MemberStatus })
  status: MemberStatus;

  @ApiProperty({ nullable: true, description: 'Rank name (from the rank ladder)' })
  rank: string | null;

  @ApiProperty({ format: 'uuid', description: 'Rank id (to pre-select in admin UI)' })
  rankId: string;

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

  @ApiProperty({ nullable: true, description: 'ISO timestamp until which the member is suspended' })
  suspendedUntil: string | null;

  @ApiProperty({ nullable: true, description: 'ISO timestamp the member was banned' })
  bannedAt: string | null;

  @ApiProperty({
    type: [MemberMedalSummary],
    description: "The member's medal awards (repeatable — same medal may appear more than once)",
  })
  medals: MemberMedalSummary[];

  /**
   * Build the projection from a (rank-joined) member plus its computed metrics.
   * The caller is responsible for having joined `member.rank` and (optionally)
   * `member.discordIdentity` so the derived fields can be read. `medals` is
   * passed in separately (the caller batches the member_medals lookup).
   */
  static from(
    member: Member,
    metrics: MemberMetrics,
    medals: MemberMedalSummary[] = [],
  ): MemberDto {
    const dto = new MemberDto();
    dto.id = member.id;
    dto.inGameName = member.inGameName;
    dto.role = member.role;
    dto.status = member.status;
    dto.rank = member.rank?.name ?? null;
    dto.rankId = member.rankId;
    dto.chevrons = member.rank?.chevrons ?? 0;
    dto.rankPrecedence = member.rank?.precedence ?? null;
    dto.discordTag = member.discordIdentity?.discordTag ?? null;
    dto.discordLinked = member.discordLinked;
    dto.publicProfile = member.publicProfile;
    // Fall back to the linked Discord avatar when the member has no custom one.
    dto.avatarUrl = member.avatarUrl ?? member.discordIdentity?.avatarUrl ?? null;
    dto.bannerUrl = member.bannerUrl;
    dto.standing = member.standing;
    dto.joinedAt = member.joinedAt ? member.joinedAt.toISOString() : null;
    dto.lastSeenAt = member.lastSeenAt ? member.lastSeenAt.toISOString() : null;
    dto.eventsAttended = metrics.eventsAttended;
    dto.suspendedUntil = member.suspendedUntil ? member.suspendedUntil.toISOString() : null;
    dto.bannedAt = member.bannedAt ? member.bannedAt.toISOString() : null;
    dto.medals = medals;
    return dto;
  }
}
