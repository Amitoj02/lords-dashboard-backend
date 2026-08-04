import { Matches, ValidationOptions } from 'class-validator';

/**
 * Vanity usernames — the public handle in `/u/@panda` (T-0215).
 *
 * ── WHY THE SHAPE IS THIS NARROW ────────────────────────────────────────────
 * Lowercase letters, digits and underscore only. Not because anything else is
 * hard to store, but because every extra character class is an impersonation
 * vector on a page whose whole job is to say "this is that person": dots and
 * hyphens let `lord.panda` and `lord-panda` and `lordpanda` coexist as three
 * different people, and any non-ASCII range brings homographs (`раnda` with a
 * Cyrillic а). The database collation already folds case and accents together;
 * this regex is what stops the classes it does NOT fold.
 *
 * 3 characters is the floor because 1–2 char handles are pure land-grab, and 20
 * the ceiling because the roster renders the handle beside the in-game name in
 * a fixed column. The COLUMN is varchar(32) — deliberately wider than the
 * regex, so the ceiling can be raised later without a migration.
 */
export const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

/** Column width. Wider than {@link USERNAME_REGEX} on purpose — see above. */
export const USERNAME_MAX_LENGTH = 32;

/** How long a released handle stays unclaimable after its holder renames. */
export const USERNAME_COOLDOWN_DAYS = 30;

/**
 * Handles nobody may claim, because the URL space would lie.
 *
 * `/u/@<handle>` cannot actually collide with a route — the mandatory `@` sigil
 * is what makes the vanity namespace disjoint from both the app's routing table
 * and the 12-char short-id namespace, and that is the primary defence. This
 * list is the SECOND one: a handle is also a display name, printed as
 * "@support" or "@moderator" next to a real person's face, and a member calling
 * themselves that is a social-engineering surface no routing property fixes.
 *
 * Kept in code rather than in `username_reservations` so a deploy can add one
 * without a migration, and so the list is reviewable in a diff.
 *
 * Every entry must itself satisfy {@link USERNAME_REGEX} — a spec asserts it.
 * A reserved word nobody could have claimed anyway (`u`, `me`, both under the
 * 3-character floor) is dead weight that makes the list look more protective
 * than it is, and it is exactly where a typo hides.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Routing + infrastructure surface, held even though the sigil protects it.
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'dashboard',
  'events',
  'gallery',
  'home',
  'login',
  'logout',
  'onboarding',
  'robots',
  'roster',
  'settings',
  'sitemap',
  'static',
  // Legal + policy pages.
  'guidelines',
  'privacy',
  'terms',
  // Authority-implying handles. The impersonation half of the list.
  'help',
  'moderator',
  'mod',
  'official',
  'owner',
  'staff',
  'support',
  'system',
  // The regiment's own identity.
  'lords',
  'lordsofholdfast',
  'regiment',
  // Values that read as bugs when rendered.
  'null',
  'undefined',
]);

/**
 * Canonical storage form. Applied before validation, before the uniqueness
 * probe and before the write, so "Panda" and "panda " are the same claim and
 * the row that lands is always the lowercase one.
 *
 * Trailing whitespace is trimmed rather than rejected because it is almost
 * always a paste artefact — and because the PAD SPACE collation would treat
 * `panda ` as a duplicate of `panda` anyway, which surfaces as a baffling 409
 * if we let it reach the index.
 */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Runtime guard for the handle format (post-normalisation). */
export function isUsername(value: unknown): value is string {
  return typeof value === 'string' && USERNAME_REGEX.test(value);
}

/** True when the handle is on the code-owned blocklist. */
export function isReservedUsername(value: string): boolean {
  return RESERVED_USERNAMES.has(normalizeUsername(value));
}

/**
 * class-validator decorator for a handle field. Pair it with a
 * `@Transform(normalizeUsername)` so the caller's casing never reaches here.
 */
export function IsUsername(validationOptions?: ValidationOptions): PropertyDecorator {
  return Matches(USERNAME_REGEX, {
    message:
      '$property must be 3-20 characters using lowercase letters, numbers or underscore only',
    ...validationOptions,
  });
}

/**
 * Split a `/u/:handle` path segment into what it actually addresses.
 *
 * The `@` sigil is MANDATORY for a vanity handle and is what keeps the two
 * namespaces disjoint: a 12-char short id is `^[0-9A-Za-z]{12}$`, and a 12-char
 * username would be indistinguishable from one without it. Anything else is
 * neither, and the caller answers 404 rather than guessing.
 *
 * Accepts the percent-encoded `%40` form too, because some clients encode `@`
 * in a path segment even though RFC 3986 lists it as a legal `pchar` — but the
 * canonical URL we emit, link to and put in the sitemap is always the literal
 * `@`, so the two never compete for indexing.
 */
export function parseProfileHandle(raw: string): { username: string } | { shortId: string } | null {
  const decoded = decodeURIComponent(raw ?? '');
  if (decoded.startsWith('@')) {
    const username = normalizeUsername(decoded.slice(1));
    return isUsername(username) ? { username } : null;
  }
  return /^[0-9A-Za-z]{12}$/.test(decoded) ? { shortId: decoded } : null;
}

/** The canonical public path for a member, preferring the vanity handle. */
export function profilePathFor(member: { id: string; username?: string | null }): string {
  return member.username ? `/u/@${member.username}` : `/u/${member.id}`;
}
