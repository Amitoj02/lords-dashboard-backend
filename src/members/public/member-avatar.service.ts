import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { MediaEmbedService } from '../../gallery/media/media-embed.service';
import { Member } from '../entities/member.entity';

/** The bytes and declared type of a proxied avatar. */
export interface ProxiedAvatar {
  buffer: Buffer;
  contentType: string;
}

const FETCH_TIMEOUT_MS = 5000;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Raster types only. `image/svg+xml` is excluded ON PURPOSE: this endpoint
 * serves bytes from the app's own origin, and an SVG is scriptable content —
 * proxying one would be stored XSS on the apex domain. Same allowlist the medal
 * thumbnail proxy uses, for the same reason.
 */
const SAFE_AVATAR_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

/**
 * Serves a member's avatar from THIS origin (T-0215).
 *
 * ── WHY A PROXY AND NOT THE URL ─────────────────────────────────────────────
 * `MemberDto.avatarUrl` falls back to the linked Discord avatar when a member
 * never uploaded one, and that URL is
 * `https://cdn.discordapp.com/avatars/<DISCORD_SNOWFLAKE>/<hash>.png`. Putting
 * it in a public roster publishes every member's raw Discord user id in an
 * `<img src>` — string-splittable by anyone viewing source, permanent, and
 * unauthenticated at the other end. It is the single identifier the public
 * projection otherwise refuses to carry, so it cannot arrive through the back
 * door of an image tag.
 *
 * Uploaded avatars are already public bytes on our own CDN and could be linked
 * directly, but they are proxied through the same path anyway: one URL shape
 * means the public HTML never reveals WHICH members have a custom avatar, and
 * the client needs no branch.
 *
 * ── SSRF POSTURE ────────────────────────────────────────────────────────────
 * The URL is never taken from the caller. It is read from the member row, and
 * then re-checked against a host allowlist (the configured CDN origin, plus
 * Discord's) before and after the fetch, so a redirect cannot walk the request
 * onto an internal address. Timeout, size cap and a raster-only content-type
 * pin are the same three controls the medal proxy uses.
 */
@Injectable()
export class MemberAvatarService {
  private readonly logger = new Logger(MemberAvatarService.name);
  private readonly cache = new Map<string, { avatar: ProxiedAvatar; expiresAt: number }>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /**
   * The stable, same-origin path a client should render for this member. Always
   * resolvable — a member with no avatar anywhere gets the generated fallback
   * from {@link fetchFor}, so the client never has to branch.
   */
  pathFor(memberId: string): string {
    return `/${this.config.get('apiPrefix', { infer: true })}/public/members/${memberId}/avatar`;
  }

  /** Fetch and cache the member's avatar bytes, or null when there are none to serve. */
  async fetchFor(member: Member): Promise<ProxiedAvatar | null> {
    const source = member.avatarUrl ?? member.discordIdentity?.avatarUrl ?? null;
    if (!source || !this.isAllowedHost(source)) {
      return null;
    }

    const cached = this.cache.get(member.id);
    if (cached && cached.expiresAt > Date.now() && cached.avatar) {
      return cached.avatar;
    }

    try {
      const res = await fetch(source, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'LordsDashboard/1.0 (+avatar-proxy)' },
      });
      if (!res.ok) return null;
      // A 3xx could have landed the final response off the allowlist.
      if (!this.isAllowedHost(res.url)) {
        this.logger.warn(`Rejected redirected avatar host for ${member.id}: ${res.url}`);
        return null;
      }
      const upstream = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!SAFE_AVATAR_CONTENT_TYPES.has(upstream)) return null;
      if (Number(res.headers.get('content-length') ?? '0') > MAX_AVATAR_BYTES) return null;

      const buffer = await MediaEmbedService.readCapped(res);
      if (!buffer) return null;

      const avatar: ProxiedAvatar = { buffer, contentType: upstream };
      this.remember(member.id, avatar);
      return avatar;
    } catch (error) {
      this.logger.warn(`Avatar fetch failed for ${member.id}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Drop a member's cached bytes (called when their avatar changes). */
  invalidate(memberId: string): void {
    this.cache.delete(memberId);
  }

  /**
   * Only two origins are ever fetched: our own media CDN, and Discord's. The
   * URL comes from our own database, so this is defence in depth against a
   * poisoned row and against a redirect — not the primary control.
   */
  private isAllowedHost(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'cdn.discordapp.com') return true;

    const cdn = this.config.get('storage', { infer: true })?.publicBaseUrl;
    if (!cdn) return false;
    try {
      return new URL(cdn).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  /** Bounded LRU-ish cache: avatars are small, but the roster is not. */
  private remember(memberId: string, avatar: ProxiedAvatar): void {
    if (this.cache.size > 500) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(memberId, { avatar, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
