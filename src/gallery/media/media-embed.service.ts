import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { MediaProvider } from '../../common/enums';
import { ResolvedMediaDto } from './dto/resolve-link.dto';

/** A fetched, cacheable image (bytes + content type) for the Medal thumbnail proxy. */
export interface MedalThumbnail {
  buffer: Buffer;
  contentType: string;
}

interface CachedThumbnail extends MedalThumbnail {
  expiresAt: number;
}

interface YouTubeEnrichment {
  title: string | null;
  durationSeconds: number | null;
}

interface CachedEnrichment {
  value: YouTubeEnrichment | null;
  expiresAt: number;
}

/** Medal clip ids are short url-safe tokens; validate before any outbound fetch (SSRF). */
const MEDAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** YouTube video ids are 11 url-safe chars. */
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const MEDAL_THUMB_TTL_MS = 6 * 60 * 60 * 1000; // 6h — Medal CDN URLs are signed/expiring.
const YOUTUBE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — title/duration are stable; stay quota-safe.
const FETCH_TIMEOUT_MS = 5000;
/** Cap the proxied thumbnail size so a large/hostile og:image can't exhaust memory. */
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
/**
 * The ONLY Content-Types this public proxy will serve back on the app origin
 * (LDA-M18): safe raster formats. Notably excludes image/svg+xml, which is
 * scriptable, and anything non-image.
 */
const SAFE_THUMBNAIL_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
/** Bound the in-memory thumbnail cache so it can't grow without limit (LRU-ish). */
const MAX_THUMBNAIL_CACHE = 256;

/**
 * Server-side media resolver + Medal.tv thumbnail proxy (T-0110/T-0112).
 *
 * Medal media/thumbnail URLs are signed + expiring and the clip page/api are not
 * CORS-enabled, so the browser cannot fetch them — this must live server-side.
 * The resolver turns an external link into a provider + embed + thumbnail shape;
 * the proxy fetches the Medal clip's og:image once and caches the BYTES behind a
 * stable URL that survives signed-URL expiry. All outbound fetches are host-
 * allowlisted to medal.tv / the YouTube Data API (SSRF-safe) and time-bounded.
 */
@Injectable()
export class MediaEmbedService {
  private readonly logger = new Logger(MediaEmbedService.name);
  private readonly medalThumbCache = new Map<string, CachedThumbnail>();
  private readonly youtubeCache = new Map<string, CachedEnrichment>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get youtubeApiKey(): string {
    return this.config.get('integrations', { infer: true }).youtubeApiKey;
  }

  private get apiPrefix(): string {
    return this.config.get('apiPrefix', { infer: true });
  }

  /**
   * Resolve an external link into a provider + embedUrl + thumbnailUrl shape.
   * YouTube/Medal get an iframe embed + poster; direct image/video URLs are
   * detected by extension; anything else is a plain link. When the YouTube Data
   * API key is configured, YouTube links are enriched with title + duration.
   */
  async resolve(url: string): Promise<ResolvedMediaDto> {
    const base: ResolvedMediaDto = {
      url,
      provider: MediaProvider.Link,
      embedUrl: null,
      thumbnailUrl: null,
      title: null,
      durationSeconds: null,
    };

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return base;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return base;
    }
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    const youtubeId = MediaEmbedService.extractYouTubeId(parsed, host);
    if (youtubeId) {
      const enrichment = await this.enrichYouTube(youtubeId);
      return {
        ...base,
        provider: MediaProvider.YouTube,
        embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
        title: enrichment?.title ?? null,
        durationSeconds: enrichment?.durationSeconds ?? null,
      };
    }

    const medalId = MediaEmbedService.extractMedalId(parsed, host);
    if (medalId) {
      return {
        ...base,
        provider: MediaProvider.MedalTv,
        embedUrl: `https://medal.tv/clip/${medalId}`,
        // Stable, same-origin proxy URL — survives the Medal CDN signed-URL expiry.
        thumbnailUrl: `/${this.apiPrefix}/gallery/media/medal/${medalId}/thumbnail`,
      };
    }

    if (/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(parsed.pathname)) {
      return { ...base, provider: MediaProvider.Image, thumbnailUrl: url };
    }
    if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(parsed.pathname)) {
      return { ...base, provider: MediaProvider.Video };
    }
    return base;
  }

  /** Extract a YouTube video id from watch?v= / youtu.be / shorts / embed URLs. */
  static extractYouTubeId(parsed: URL, host: string): string | null {
    const valid = (id: string | null | undefined): string | null =>
      id && YOUTUBE_ID_RE.test(id) ? id : null;

    if (host === 'youtu.be') {
      return valid(parsed.pathname.split('/').filter(Boolean)[0]);
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (parsed.pathname === '/watch') {
        return valid(parsed.searchParams.get('v'));
      }
      const segs = parsed.pathname.split('/').filter(Boolean);
      if (segs[0] === 'shorts' || segs[0] === 'embed' || segs[0] === 'v') {
        return valid(segs[1]);
      }
    }
    return null;
  }

  /** Extract a Medal.tv clip id from /clips/:id, /clip/:id(/:hash) or ?contentId=. */
  static extractMedalId(parsed: URL, host: string): string | null {
    if (host !== 'medal.tv') {
      return null;
    }
    const valid = (id: string | null | undefined): string | null =>
      id && MEDAL_ID_RE.test(id) ? id : null;

    const contentId = parsed.searchParams.get('contentId');
    if (contentId) {
      return valid(contentId);
    }
    const segs = parsed.pathname.split('/').filter(Boolean);
    // /clips/<id>, /clip/<id>, /clip/<id>/<hash>, /games/<game>/clips/<id>
    const idx = segs.findIndex((s) => s === 'clips' || s === 'clip');
    if (idx !== -1 && segs[idx + 1]) {
      return valid(segs[idx + 1]);
    }
    return null;
  }

  /**
   * Fetch (and cache) the Medal clip's og:image bytes. Returns null when the id
   * is unknown / the clip has no resolvable image / the fetch fails, so the
   * controller can serve a graceful 404 and the client falls back to a placeholder.
   */
  async getMedalThumbnail(clipId: string): Promise<MedalThumbnail | null> {
    if (!MEDAL_ID_RE.test(clipId)) {
      return null;
    }
    const cached = this.medalThumbCache.get(clipId);
    if (cached && cached.expiresAt > Date.now()) {
      return { buffer: cached.buffer, contentType: cached.contentType };
    }

    try {
      const imageUrl = await this.scrapeMedalOgImage(clipId);
      if (!imageUrl) {
        return null;
      }
      const res = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        return null;
      }
      // Defense-in-depth: a 3xx could land the final response off the allowlist.
      if (!MediaEmbedService.isMedalHost(res.url)) {
        this.logger.warn(`Rejected redirected Medal thumbnail host for ${clipId}: ${res.url}`);
        return null;
      }
      // Pin the served Content-Type to a safe RASTER allowlist rather than
      // reflecting whatever the upstream declared (LDA-M18). A bare
      // startsWith('image/') would pass image/svg+xml, which the proxy would then
      // serve from the app origin as scriptable content.
      const upstream = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!SAFE_THUMBNAIL_CONTENT_TYPES.has(upstream)) {
        return null;
      }
      const contentType = upstream;
      // Reject oversized images up front (Content-Length) and while reading (bounded).
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > MAX_THUMBNAIL_BYTES) {
        return null;
      }
      const buffer = await MediaEmbedService.readCapped(res);
      if (!buffer) {
        return null;
      }
      this.cacheThumbnail(clipId, { buffer, contentType });
      return { buffer, contentType };
    } catch (error) {
      this.logger.warn(`Medal thumbnail fetch failed for ${clipId}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Fetch the clip page and extract its og:image URL (host-allowlisted to medal.tv). */
  private async scrapeMedalOgImage(clipId: string): Promise<string | null> {
    const res = await fetch(`https://medal.tv/clip/${clipId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'LordsDashboard/1.0 (+thumbnail-proxy)' },
    });
    if (!res.ok || !MediaEmbedService.isMedalHost(res.url)) {
      return null;
    }
    const html = await res.text();
    const match =
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
    const imageUrl = match?.[1];
    if (!imageUrl) {
      return null;
    }
    // SSRF guard: only ever fetch bytes from a medal.tv host.
    if (!MediaEmbedService.isMedalHost(imageUrl)) {
      this.logger.warn(`Rejected non-medal og:image for ${clipId}: ${imageUrl}`);
      return null;
    }
    return imageUrl;
  }

  /** True when a URL's host is medal.tv or a subdomain of it (SSRF allowlist). */
  static isMedalHost(urlStr: string): boolean {
    try {
      const host = new URL(urlStr).hostname.toLowerCase();
      return host === 'medal.tv' || host.endsWith('.medal.tv');
    } catch {
      return false;
    }
  }

  /** Read a response body into a Buffer, aborting if it exceeds the size cap. */
  private static async readCapped(res: Response): Promise<Buffer | null> {
    const reader = res.body?.getReader();
    if (!reader) {
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_THUMBNAIL_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /** Store a thumbnail, evicting the oldest entry when the cache is full. */
  private cacheThumbnail(clipId: string, thumb: MedalThumbnail): void {
    if (this.medalThumbCache.size >= MAX_THUMBNAIL_CACHE) {
      // Evict the oldest entry (Map preserves insertion order).
      for (const key of this.medalThumbCache.keys()) {
        this.medalThumbCache.delete(key);
        break;
      }
    }
    this.medalThumbCache.set(clipId, {
      ...thumb,
      expiresAt: Date.now() + MEDAL_THUMB_TTL_MS,
    });
  }

  /**
   * Enrich a YouTube video with its canonical title + duration via the Data API
   * (videos.list, part=snippet,contentDetails — 1 quota unit). Key-gated and
   * cached per video id so it is called at most once per id within the TTL.
   * Returns null (never throws) when the key is unset or the call fails.
   */
  async enrichYouTube(videoId: string): Promise<YouTubeEnrichment | null> {
    if (!YOUTUBE_ID_RE.test(videoId) || !this.youtubeApiKey) {
      return null;
    }
    const cached = this.youtubeCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let value: YouTubeEnrichment | null = null;
    try {
      const params = new URLSearchParams({
        part: 'snippet,contentDetails',
        id: videoId,
        key: this.youtubeApiKey,
      });
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Transient failure (quota 403 / 5xx). Do NOT cache — a cached null would
        // suppress enrichment for the full TTL even after the quota resets.
        this.logger.warn(`YouTube enrichment failed for ${videoId}: ${res.status}`);
        return null;
      }
      const body = (await res.json()) as {
        items?: {
          snippet?: { title?: string };
          contentDetails?: { duration?: string };
        }[];
      };
      const item = body.items?.[0];
      if (item) {
        value = {
          title: item.snippet?.title ?? null,
          durationSeconds: MediaEmbedService.parseIso8601Duration(item.contentDetails?.duration),
        };
      }
    } catch (error) {
      // Network error / timeout — also transient, so leave the cache untouched.
      this.logger.warn(`YouTube enrichment error for ${videoId}: ${(error as Error).message}`);
      return null;
    }

    // Only an authoritative response (res.ok, whether or not the video existed) is
    // cached — a definitive result worth remembering for the TTL.
    this.youtubeCache.set(videoId, { value, expiresAt: Date.now() + YOUTUBE_TTL_MS });
    return value;
  }

  /** Parse an ISO-8601 duration (e.g. `PT1M30S`) into whole seconds, or null. */
  static parseIso8601Duration(iso: string | undefined): number | null {
    if (!iso) return null;
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!m) return null;
    const [, h, min, s] = m;
    return Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0) || 0;
  }
}
