import { MemberSocialPlatform } from '../common/enums';

/**
 * The member social-links registry (T-0216) — the ONE place that knows what a
 * handle for each network looks like, what it is called, and what URL it
 * resolves to.
 *
 * ── WHY HANDLES AND NOT URLs ────────────────────────────────────────────────
 * A member profile is a CRAWLABLE, anonymous page (`/u/@panda`, rendered
 * server-side by the SEO module). If members stored a URL, then every member
 * would hold a primitive that publishes an arbitrary outbound link on our
 * origin, signed with the regiment's reputation: a phishing page, a malware
 * download, an SEO-spam farm, a `javascript:` payload aimed at whatever renderer
 * forgets to escape it, or a redirect that quietly changes destination a month
 * after a moderator looked at it. Blocklisting hosts does not fix that — it is a
 * denylist against an open set, and the attacker picks the set.
 *
 * So the stored value is a HANDLE — a bounded string over a per-platform
 * character class — and the URL is ALWAYS composed here, server-side, from a
 * hardcoded origin plus that handle. The set of hosts a member can cause us to
 * link to is therefore exactly the seven origins written in this file, and it
 * cannot be widened by any input. That is the whole point of the decision, and
 * it is why nothing outside this module may build a profile URL or accept one.
 *
 * As defence in depth the builders run the handle through
 * `encodeURIComponent`. For every handle that passes {@link isValidSocialHandle}
 * that is the identity function (the allowed classes are all URI-unreserved), so
 * it changes nothing in practice — it exists so that a handle which somehow
 * reached the builder unvalidated cannot break out of the path segment.
 *
 * ── WHY A REGISTRY AND NOT SEVEN `if`s ──────────────────────────────────────
 * The pattern, the label and the URL shape for one network are three facts that
 * must agree; split across a DTO, a service and a template they drift, and the
 * drift shows up as a member whose handle validated but whose link 404s. Adding
 * a network is one entry in {@link MEMBER_SOCIAL_PLATFORMS} plus one member on
 * {@link MemberSocialPlatform} — and a spec fails if you do only one of the two.
 */

/** One network's rules: what a handle may look like and where it points. */
export interface MemberSocialPlatformSpec {
  /** Wire value + storage value; also the frontend's icon key. */
  readonly platform: MemberSocialPlatform;
  /** Human label as rendered beside the link ('Medal.tv', not 'medal'). */
  readonly label: string;
  /**
   * Accepted handle shapes, tested against the NORMALISED handle. More than one
   * only where a network has two genuinely different id forms (Steam).
   */
  readonly patterns: readonly RegExp[];
  /** Server-side URL composer. Never sees anything but a stored handle. */
  readonly buildUrl: (handle: string) => string;
}

/**
 * Column width for `member_social_links.handle`. Deliberately far wider than any
 * pattern above allows (the longest accepts 32 chars) so a network's ceiling can
 * be raised without a migration — the same reasoning as
 * `USERNAME_MAX_LENGTH` vs `USERNAME_REGEX`.
 */
export const SOCIAL_HANDLE_MAX_LENGTH = 190;

/**
 * A 17-digit steamID64 (`76561198…`). Steam profiles are addressable two ways
 * and the URL PREFIX differs between them, so this is the one place a platform
 * needs to branch on which form it was given. Note the digits-only shape is
 * already accepted by the vanity pattern's `{2,32}` range — it is spelled out
 * separately because {@link socialProfileUrl} switches on it, not to widen what
 * validates.
 */
const STEAM_ID64_RE = /^\d{17}$/;

/**
 * The seven networks, in DISPLAY ORDER. The array index is the canonical
 * `precedence` written to `member_social_links.precedence`, so the profile
 * renders them in a stable order no matter what order the member submitted.
 */
export const MEMBER_SOCIAL_PLATFORMS: readonly MemberSocialPlatformSpec[] = [
  {
    platform: MemberSocialPlatform.Twitch,
    label: 'Twitch',
    // Twitch logins: 4–25, letters/digits/underscore. Case is preserved for
    // display ('LordPanda'); the URL is case-insensitive at Twitch's end.
    patterns: [/^[A-Za-z0-9_]{4,25}$/],
    buildUrl: (handle) => `https://www.twitch.tv/${encodeURIComponent(handle)}`,
  },
  {
    platform: MemberSocialPlatform.YouTube,
    label: 'YouTube',
    // The @handle namespace (not the legacy /channel/UC… id, which is not a
    // handle a member types). Dots and hyphens are legal there, unlike Twitch.
    patterns: [/^[A-Za-z0-9._-]{3,30}$/],
    buildUrl: (handle) => `https://www.youtube.com/@${encodeURIComponent(handle)}`,
  },
  {
    platform: MemberSocialPlatform.Instagram,
    label: 'Instagram',
    patterns: [/^[A-Za-z0-9._]{1,30}$/],
    buildUrl: (handle) => `https://www.instagram.com/${encodeURIComponent(handle)}`,
  },
  {
    platform: MemberSocialPlatform.TikTok,
    label: 'TikTok',
    patterns: [/^[A-Za-z0-9._]{2,24}$/],
    buildUrl: (handle) => `https://www.tiktok.com/@${encodeURIComponent(handle)}`,
  },
  {
    platform: MemberSocialPlatform.X,
    label: 'X',
    // x.com, not twitter.com: one canonical origin per network, and the old one
    // only redirects. 1–15 letters/digits/underscore is the account rule.
    patterns: [/^[A-Za-z0-9_]{1,15}$/],
    buildUrl: (handle) => `https://x.com/${encodeURIComponent(handle)}`,
  },
  {
    platform: MemberSocialPlatform.Steam,
    label: 'Steam',
    patterns: [/^[A-Za-z0-9_-]{2,32}$/, STEAM_ID64_RE],
    buildUrl: (handle) =>
      STEAM_ID64_RE.test(handle)
        ? `https://steamcommunity.com/profiles/${encodeURIComponent(handle)}`
        : `https://steamcommunity.com/id/${encodeURIComponent(handle)}`,
  },
  {
    platform: MemberSocialPlatform.MedalTv,
    label: 'Medal.tv',
    patterns: [/^[A-Za-z0-9_-]{2,32}$/],
    buildUrl: (handle) => `https://medal.tv/u/${encodeURIComponent(handle)}`,
  },
];

/** Wire/storage keys, in display order — for `@IsIn` and for the frontend. */
export const MEMBER_SOCIAL_PLATFORM_KEYS: readonly string[] = MEMBER_SOCIAL_PLATFORMS.map(
  (spec) => spec.platform,
);

const SPEC_BY_PLATFORM = new Map<string, MemberSocialPlatformSpec>(
  MEMBER_SOCIAL_PLATFORMS.map((spec) => [spec.platform as string, spec]),
);

/**
 * Canonical storage form, applied BEFORE validation and before the write.
 *
 * People paste what they see rather than what a field asks for: `@panda` from a
 * Twitch overlay, `panda/` from the end of a copied URL, and either with the
 * whitespace a double-click drags along. Rejecting those is a support ticket
 * about an invisible space, so all three are stripped instead.
 *
 * Exactly ONE leading `@` is removed: `@@panda` is not a paste artefact, it is a
 * handle that does not exist, and it should fail validation rather than be
 * silently repaired into someone else's account.
 *
 * Case is PRESERVED. Every network here is case-insensitive in its URL but
 * case-PRESERVING in its display name, and a member typing `LordPanda` expects
 * to see `LordPanda` on their profile. Uniqueness does not depend on it: the key
 * is (member, platform), so a member cannot hold two rows for one network in any
 * casing.
 */
export function normalizeSocialHandle(raw: string): string {
  let value = (raw ?? '').trim();
  if (value.startsWith('@')) {
    value = value.slice(1);
  }
  if (value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Narrowing guard for a platform key off the wire or out of the database.
 *
 * `member_social_links.platform` is a varchar open set (SCHEMA.md §2), so a row
 * can outlive the registry entry that explains it. Every read path that renders
 * a stored row MUST filter through this first.
 */
export function isSupportedSocialPlatform(value: string): value is MemberSocialPlatform {
  return SPEC_BY_PLATFORM.has(value);
}

/** True when `handle` (already normalised) satisfies one of the platform's shapes. */
export function isValidSocialHandle(
  platform: MemberSocialPlatform | string,
  handle: string,
): boolean {
  const spec = SPEC_BY_PLATFORM.get(platform);
  if (!spec || typeof handle !== 'string') {
    return false;
  }
  return spec.patterns.some((pattern) => pattern.test(handle));
}

/**
 * Compose the public profile URL. The ONLY sanctioned way to turn a stored
 * handle into a link — see the module header for why members never supply one.
 *
 * THROWS for a platform with no registry entry, and that is deliberate: there is
 * no safe fallback URL, and inventing one (or echoing an unknown value into a
 * path) is precisely the arbitrary-outbound-link hazard this module exists to
 * prevent. Callers projecting stored rows guard with
 * {@link isSupportedSocialPlatform} and drop what they cannot explain.
 */
export function socialProfileUrl(platform: MemberSocialPlatform | string, handle: string): string {
  const spec = SPEC_BY_PLATFORM.get(platform);
  if (!spec) {
    throw new Error(`Unsupported social platform: ${platform}`);
  }
  return spec.buildUrl(handle);
}

/**
 * Display label for a platform key. Falls back to the raw key rather than
 * throwing — a label is cosmetic, so a retired platform still on an old row
 * renders as its own key instead of taking a profile page down with it. (The URL
 * builder does NOT get the same latitude, because a wrong URL is not cosmetic.)
 */
export function socialPlatformLabel(platform: MemberSocialPlatform | string): string {
  return SPEC_BY_PLATFORM.get(platform)?.label ?? platform;
}

/**
 * Canonical display order as an integer, for `member_social_links.precedence`.
 * Unknown platforms sort last rather than first, so a value the registry cannot
 * explain never leads the list.
 */
export function socialPlatformPrecedence(platform: MemberSocialPlatform | string): number {
  const index = MEMBER_SOCIAL_PLATFORM_KEYS.indexOf(platform);
  return index === -1 ? MEMBER_SOCIAL_PLATFORMS.length : index;
}
