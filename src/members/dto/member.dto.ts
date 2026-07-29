import { ApiProperty } from '@nestjs/swagger';
import { MemberRole, MemberStatus } from '../../common/enums';
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

  @ApiProperty({ description: 'Short fallback label (shown when the medal has no image)' })
  glyph: string;

  @ApiProperty({
    nullable: true,
    description: 'Public URL of the medal image (null → fallback tile)',
  })
  imageUrl: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'The CATALOGUE description — what the medal is awarded FOR, copied from the ' +
      'medals row and identical for every holder. This is what a viewer reads to ' +
      'learn what it takes to earn the medal. Not to be confused with `detail`.',
  })
  description: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "This award's own citation — why THIS member received it on THIS occasion. " +
      'Per-award, so two holders of the same medal have different `detail`.',
  })
  detail: string | null;

  @ApiProperty({ description: 'ISO timestamp the medal was awarded' })
  awardedAt: string;
}

/**
 * Which admin actions the CALLER may perform on THIS member (T-0177), derived
 * from the same predicate the endpoints enforce (see `member-hierarchy.ts`), so
 * the client can grey out an action instead of discovering the 403 by trying
 * it. A flag is true only when the target-scoped rule allows the action AND the
 * caller holds the capability the route requires — there is never a permitted
 * flag where the endpoint would refuse, nor a refusal where the flag was true.
 *
 * The flags are computed per action and can legitimately disagree (T-0211): on
 * a peer, a superior, the regiment owner or the caller's OWN record, an
 * edit_ranks_medals holder gets the four rank/medal actions true and the five
 * moderation ones false. A block is a per-action answer, never one verdict
 * copied nine times.
 */
export class PermittedActionsDto {
  @ApiProperty({ description: 'Requires manage_roles, and the full role hierarchy' })
  changeRole: boolean;

  @ApiProperty({ description: 'Requires edit_ranks_medals; no target restriction' })
  changeRank: boolean;

  @ApiProperty({ description: 'Requires edit_ranks_medals; no target restriction' })
  awardMedal: boolean;

  @ApiProperty({ description: 'Requires edit_ranks_medals; no target restriction' })
  removeMedal: boolean;

  @ApiProperty({ description: 'Requires manage_roles, and the full role hierarchy' })
  suspend: boolean;

  @ApiProperty({ description: 'Requires manage_roles, and the full role hierarchy' })
  unsuspend: boolean;

  @ApiProperty({ description: 'Requires manage_roles, and the full role hierarchy' })
  ban: boolean;

  @ApiProperty({ description: 'Requires manage_roles, and the full role hierarchy' })
  unban: boolean;

  @ApiProperty({
    description:
      'Requires edit_ranks_medals; no target restriction, your own record included ' +
      '(T-0211 relaxed the self refusal T-0204 relied on)',
  })
  deriveFromDiscord: boolean;
}

/**
 * Public roster projection of a {@link Member}. Never expose the raw entity:
 * secrets (Discord tokens live on the identity), internal flags and FK ids are
 * omitted. Rank/rank-image/attendance fields are derived server-side.
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

  @ApiProperty({ nullable: true, description: 'Public URL of the rank insignia image' })
  rankImageUrl: string | null;

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
    description:
      "The member's medal awards (repeatable — same medal may appear more than once), " +
      'ordered by the medal cabinet: `precedence` ascending, then newest award first. ' +
      'Clients render this array as delivered — the order is part of the contract.',
  })
  medals: MemberMedalSummary[];

  @ApiProperty({
    type: PermittedActionsDto,
    description: 'Admin actions the CALLER may perform on this member (T-0177)',
  })
  permittedActions: PermittedActionsDto;

  /**
   * Build the projection from a (rank-joined) member plus its computed metrics.
   * The caller is responsible for having joined `member.rank` and (optionally)
   * `member.discordIdentity` so the derived fields can be read. `medals` is
   * passed in separately (the caller batches the member_medals lookup), and so
   * is `permittedActions` — it depends on the CALLER, not on the member, and is
   * resolved once per request rather than per row (T-0177).
   */
  static from(
    member: Member,
    metrics: MemberMetrics,
    medals: MemberMedalSummary[],
    permittedActions: PermittedActionsDto,
  ): MemberDto {
    const dto = new MemberDto();
    dto.id = member.id;
    dto.inGameName = member.inGameName;
    dto.role = member.role;
    dto.status = member.status;
    dto.rank = member.rank?.name ?? null;
    dto.rankId = member.rankId;
    dto.rankImageUrl = member.rank?.imageUrl ?? null;
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
    dto.permittedActions = permittedActions;
    return dto;
  }
}
