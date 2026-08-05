import { ApiProperty } from '@nestjs/swagger';
import { MemberSocialLink } from '../entities/member-social-link.entity';
import {
  MEMBER_SOCIAL_PLATFORM_KEYS,
  isSupportedSocialPlatform,
  socialPlatformLabel,
  socialPlatformPrecedence,
  socialProfileUrl,
} from '../social-platforms';

/**
 * One social account a member has published (T-0216).
 *
 * ── WHY THIS SHAPE IS IDENTICAL ON THE AUTHENTICATED AND ANONYMOUS PROFILES ──
 * {@link MemberDto} and {@link PublicMemberDto} are deliberately separate types
 * precisely so that a field added for staff cannot leak to anonymous visitors —
 * but a social link has no staff half. It is member-authored, self-published and
 * blank by default, so signed-in and signed-out views of it are the SAME
 * response, and one class serving both is what makes that a fact rather than a
 * promise two copies have to keep. That is also why this class lives in its own
 * file: both DTOs import it, and putting it in either one would make the other
 * import its opposite number.
 *
 * ── WHY `url` IS SENT AT ALL, GIVEN THAT `handle` IS ALSO SENT ──────────────
 * Because if the client composed the link, the client would own the origin, and
 * the whole handles-not-URLs decision (see `src/members/social-platforms.ts`)
 * would be a server-side rule enforcing a client-side behaviour. `url` is built
 * HERE, from a hardcoded origin plus a handle that has already passed its
 * platform's pattern, so the set of hosts a member can cause us to link to is
 * exactly the seven origins in the registry. A member can never publish an
 * arbitrary outbound link on a crawlable page carrying the regiment's name.
 * `handle` rides along for display ("@LordPanda"), never for link building.
 */
export class MemberSocialLinkDto {
  @ApiProperty({
    enum: [...MEMBER_SOCIAL_PLATFORM_KEYS],
    description: "Registry key; also the frontend's icon key",
  })
  platform: string;

  @ApiProperty({ description: "Human label as rendered beside the link ('Medal.tv', not 'medal')" })
  label: string;

  @ApiProperty({ description: 'Account name as the member typed it, case preserved, no @ sigil' })
  handle: string;

  @ApiProperty({
    description:
      'Profile URL, composed SERVER-SIDE from a hardcoded origin plus the stored handle. ' +
      'Never a member-supplied link — clients render this value and never build their own.',
  })
  url: string;

  /**
   * Project one stored row.
   *
   * THROWS (via `socialProfileUrl`) when the platform has no registry entry.
   * `member_social_links.platform` is an open varchar set, so a row can outlive
   * the entry that explains it, and there is no safe fallback URL for one —
   * guessing would reintroduce exactly the arbitrary-outbound-link hazard the
   * registry exists to remove. Callers projecting STORED rows should therefore
   * go through {@link fromMany}, which drops what it cannot explain; this
   * single-row form is for a row whose platform the caller has already checked.
   */
  static from(link: MemberSocialLink): MemberSocialLinkDto {
    const dto = new MemberSocialLinkDto();
    dto.platform = link.platform;
    dto.label = socialPlatformLabel(link.platform);
    dto.handle = link.handle;
    dto.url = socialProfileUrl(link.platform, link.handle);
    return dto;
  }

  /**
   * Project a member's rows for the wire: unexplainable platforms dropped,
   * canonical display order applied.
   *
   * The order comes from the LIVE registry rather than from the stored
   * `precedence` integer. `precedence` is a snapshot of the registry's order at
   * INSERT time, so reordering the registry (or inserting a network into the
   * middle of it) would otherwise leave every existing member displaying the old
   * order until they next edited their profile. Sorting here means display order
   * is always current, and the stored column stays useful as the ORDER BY that
   * keeps the query deterministic. The sort is total for a single member's rows
   * because (member, platform) is unique, so no two rows share a key.
   */
  static fromMany(links: MemberSocialLink[]): MemberSocialLinkDto[] {
    return links
      .filter((link) => isSupportedSocialPlatform(link.platform))
      .sort((a, b) => socialPlatformPrecedence(a.platform) - socialPlatformPrecedence(b.platform))
      .map((link) => MemberSocialLinkDto.from(link));
  }
}
