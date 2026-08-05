import { ApiProperty } from '@nestjs/swagger';
import { MemberRole } from '../../common/enums';
import { profilePathFor } from '../../common/ids/username';
import { MemberSocialLink } from '../entities/member-social-link.entity';
import { Member } from '../entities/member.entity';
import { MemberSocialLinkDto } from './member-social-link.dto';
import { MemberMedalSummary, MemberMetrics } from './member.dto';

/**
 * One medal on a PUBLIC profile.
 *
 * Deliberately NOT {@link MemberMedalSummary}: that carries `detail`, the
 * per-award citation an officer writes about this member on this occasion. It
 * is free-form staff prose that can name other people or reference an incident,
 * and it is currently rendered on no screen at all — publishing it would be the
 * first time anyone outside the DB saw it. `description` (the medal's own
 * catalogue text, identical for every holder) is the public half.
 */
export class PublicMemberMedalDto {
  @ApiProperty({ description: 'The award (member_medal) id' })
  id: string;

  @ApiProperty()
  medalId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ description: 'Short fallback label (shown when the medal has no image)' })
  glyph: string;

  @ApiProperty({ nullable: true })
  imageUrl: string | null;

  @ApiProperty({
    nullable: true,
    description: 'The CATALOGUE description — what the medal is awarded for. Public by nature.',
  })
  description: string | null;

  @ApiProperty({ description: 'ISO timestamp the medal was awarded' })
  awardedAt: string;
}

/**
 * The anonymous projection of a member (T-0215) — what a logged-out visitor and
 * a search engine are allowed to see.
 *
 * ── WHY THIS IS A SEPARATE CLASS AND NOT `MemberDto` WITH FIELDS DELETED ────
 * Because a redaction you have to REMEMBER is a redaction you will eventually
 * forget. `MemberDto` is one shape shared by the roster list and the member
 * detail route, so a field added there for an admin screen is instantly live on
 * every row of both — and this module already has the cautionary example:
 * `GalleryItemDto.from` sets `status` and `declineReason` unconditionally and
 * is safe only because today's public query happens to filter to approved rows.
 * Here the sensitive fields are not conditionally stripped, they are ABSENT
 * FROM THE TYPE, so adding one to `MemberDto` cannot leak through this DTO and
 * adding one HERE is a visible, reviewable decision to publish it.
 *
 * ── WHAT IS DELIBERATELY MISSING, AND WHY ───────────────────────────────────
 *  - `discordTag` / `discordLinked` — the one field that resolves an in-game
 *    handle to a real, DM-able Discord account. Signed-in only. (The same value
 *    already sits behind `view_audit_log` in `CommandInfoDto`; the roster was
 *    the inconsistency.)
 *  - `status`, `suspendedUntil`, `bannedAt`, `standing` — disciplinary state.
 *    Publishing "suspended" about a named person is a defamation surface, and
 *    the excluded-member predicate means a suspended member has no public page
 *    to print it on anyway.
 *  - `lastSeenAt` — bumped on EVERY authenticated request, so it is a live
 *    presence timeline rather than a "last login". Signed-in only, by decision.
 *  - `permittedActions` — computed from the CALLER, not the subject. It is the
 *    single thing that would make this response vary per viewer, which is
 *    exactly what stops it being cacheable at the edge.
 *  - `medals[].detail` — see {@link PublicMemberMedalDto}.
 *
 * ── AND WHY `bio` AND `socialLinks` ARE HERE (T-0216) ───────────────────────
 * Every exclusion above shares a property: the field is something the SYSTEM or
 * an OFFICER asserts about the member, published without them ever choosing to
 * publish it. `bio` and `socialLinks` are the opposite case on all three counts.
 * They are member-AUTHORED — nobody else can write them, PATCH /members/:id
 * refuses any id but the caller's own. They are BLANK BY DEFAULT, so appearing
 * here is an act, not an omission; a member who wants no public presence beyond
 * a name simply never fills them in and the profile is exactly as bare as it is
 * today. And they are SELF-PUBLISHED BY INTENT: the entire reason a member types
 * a Twitch handle into their regiment profile is so that visitors follow it.
 *
 * The dangerous half of "let a member publish something on a crawlable page we
 * host" is the outbound LINK, and that is closed structurally rather than by
 * moderation: what is stored is a handle over a bounded character class, and the
 * `url` is composed server-side from one of seven hardcoded origins (see
 * `src/members/social-platforms.ts`). No input can widen that set, so a member
 * cannot point our reputation at a phishing page. The `bio` is plain text
 * escaped at render time by `escapeHtml` in `src/seo`, the same treatment
 * `inGameName` already gets.
 *
 * `avatarUrl` is a path on THIS origin, never the upstream URL: the Discord CDN
 * fallback is `cdn.discordapp.com/avatars/<SNOWFLAKE>/…`, so emitting it would
 * publish every member's raw Discord user id in an `<img src>` — the one
 * identifier this DTO otherwise never carries.
 */
export class PublicMemberDto {
  @ApiProperty({ description: 'Short id — always addressable, even without a handle' })
  id: string;

  @ApiProperty({ nullable: true, description: 'Vanity handle, without the @ sigil' })
  username: string | null;

  @ApiProperty({ description: 'In-game name — the sole display identity' })
  inGameName: string;

  @ApiProperty({
    enum: MemberRole,
    description: 'Never `Applicant` — applicants have no public profile at all.',
  })
  role: MemberRole;

  @ApiProperty({ nullable: true })
  rank: string | null;

  @ApiProperty({ nullable: true })
  rankImageUrl: string | null;

  @ApiProperty({ nullable: true, description: 'Lower sorts higher; the public roster sort key' })
  rankPrecedence: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Same-origin avatar PATH, or null when the member has no avatar anywhere (the client ' +
      'then renders its initials tile, as it already does). Never the upstream Discord CDN ' +
      "URL — that embeds the member's Discord snowflake.",
  })
  avatarUrl: string | null;

  @ApiProperty({ nullable: true })
  bannerUrl: string | null;

  @ApiProperty({
    nullable: true,
    maxLength: 280,
    description:
      'Member-authored blurb, or null when never written. Raw text — escaped at render ' +
      'time by `escapeHtml`, never pre-escaped on the wire.',
  })
  bio: string | null;

  @ApiProperty({
    type: [MemberSocialLinkDto],
    description:
      'Published social accounts, in canonical display order; `[]` when none, never null. ' +
      'Each `url` is built server-side from a validated handle.',
  })
  socialLinks: MemberSocialLinkDto[];

  @ApiProperty({ nullable: true, description: 'ISO timestamp the member joined' })
  joinedAt: string | null;

  @ApiProperty({ description: 'Confirmed attendances at past events (an aggregate, not a list)' })
  eventsAttended: number;

  @ApiProperty({ type: [PublicMemberMedalDto] })
  medals: PublicMemberMedalDto[];

  @ApiProperty({
    description:
      'The canonical public path for this member — `/u/@handle` when a handle is set, ' +
      '`/u/<shortId>` otherwise. Clients use it for rel=canonical and for links.',
  })
  canonicalPath: string;

  /**
   * Build the anonymous projection. `medals` arrives already ordered by the
   * medal cabinet (precedence ASC, then newest first) — that order is part of
   * the contract and no client re-sorts it.
   *
   * `socialLinks` arrives as raw ENTITY rows and is projected here through
   * `MemberSocialLinkDto.fromMany`, which drops any row whose platform the
   * registry can no longer explain — see {@link MemberDto.from} for why that
   * mapper must not be something a caller can skip. It is appended LAST and
   * defaults to `[]` (T-0216): a call site that has not been taught to fetch
   * them then emits an empty array, the same thing a member with no links emits,
   * rather than `undefined` — the failure mode of a missing fetch is "shows
   * nothing", never a shape the client has to special-case.
   */
  static from(
    member: Member,
    metrics: MemberMetrics,
    medals: MemberMedalSummary[],
    avatarPath: string | null,
    socialLinks: MemberSocialLink[] = [],
  ): PublicMemberDto {
    const dto = new PublicMemberDto();
    dto.id = member.id;
    dto.username = member.username ?? null;
    dto.inGameName = member.inGameName;
    dto.role = member.role;
    dto.rank = member.rank?.name ?? null;
    dto.rankImageUrl = member.rank?.imageUrl ?? null;
    dto.rankPrecedence = member.rank?.precedence ?? null;
    dto.avatarUrl = avatarPath;
    dto.bannerUrl = member.bannerUrl;
    dto.bio = member.bio ?? null;
    dto.joinedAt = member.joinedAt ? member.joinedAt.toISOString() : null;
    dto.eventsAttended = metrics.eventsAttended;
    // Re-copied field-by-field for the same reason as medals below:
    // MemberSocialLinkDto is SHARED with the authenticated projection, so a
    // field added there for a signed-in screen would otherwise ride straight
    // onto an anonymous, crawlable page. The allowlist is asserted in the spec.
    dto.socialLinks = MemberSocialLinkDto.fromMany(socialLinks).map((link) => ({
      platform: link.platform,
      label: link.label,
      handle: link.handle,
      url: link.url,
    }));
    // Field-by-field, NOT a spread: a spread would carry `detail` through the
    // moment anyone widens MemberMedalSummary.
    dto.medals = medals.map((award) => ({
      id: award.id,
      medalId: award.medalId,
      title: award.title,
      glyph: award.glyph,
      imageUrl: award.imageUrl,
      description: award.description,
      awardedAt: award.awardedAt,
    }));
    dto.canonicalPath = profilePathFor(member);
    return dto;
  }
}
