import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GalleryMediaType, GalleryType } from '../../common/enums';
import { AppConfig } from '../../config/configuration';
import { GalleryItemDto } from '../dto/gallery-item.dto';
import { GalleryService } from '../gallery.service';
import { MediaEmbedService } from '../media/media-embed.service';
import { OpenGraphCard, renderOpenGraphShell } from './og-html';

/** Trimmed to a length every unfurler renders without an ellipsis of its own. */
const MAX_DESCRIPTION = 200;

/**
 * Builds the Open Graph card for a public gallery share link (T-0197).
 *
 * ── THE RULE FOR EXTERNAL LINKS ─────────────────────────────────────────────
 * Only providers this codebase ALREADY understands get a rich card: YouTube and
 * Medal.tv, recognised by the same pure extractors the in-app embed resolver
 * uses. Anything else falls back to a titled card with the regiment crest and
 * the link written out — deliberately, because the alternative is fetching an
 * arbitrary member-supplied URL from the server and re-publishing whatever it
 * returns, on an UNAUTHENTICATED route. That is an SSRF surface and a way to
 * launder someone else's content through this domain's reputation. A dull
 * preview is the right failure.
 *
 * ── AND WHY NOTHING HERE MAKES AN OUTBOUND REQUEST ──────────────────────────
 * The YouTube thumbnail is a static i.ytimg.com URL derived from the video id,
 * and the Medal thumbnail points at this API's own already-public, throttled,
 * cached proxy. Both are computed, not fetched. The authenticated
 * `/gallery/media/resolve` endpoint may fetch; this one may not, because a
 * crawler hitting it is not a signed-in member.
 */
@Injectable()
export class GalleryShareService {
  private readonly logger = new Logger(GalleryShareService.name);

  constructor(
    private readonly gallery: GalleryService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * The share shell for one item, or null when there is nothing shareable —
   * the item does not exist, is not approved, or the gallery is private. The
   * caller turns that into a 404 rather than leaking which of the three it was.
   */
  async renderItem(id: string): Promise<string | null> {
    let item: GalleryItemDto;
    try {
      item = await this.gallery.findOnePublic(id);
    } catch {
      // NotFound and Forbidden (a private gallery) are the same answer to a
      // crawler: there is no public card for this id.
      return null;
    }
    return renderOpenGraphShell(this.cardFor(item));
  }

  /** The generic site card, used when an id resolves to nothing public. */
  renderFallback(): string {
    return renderOpenGraphShell({
      canonicalUrl: this.siteUrl(),
      siteName: this.siteName(),
      title: this.siteName(),
      description: 'Roster, events and gallery for a Holdfast: Nations at War regiment.',
    });
  }

  private cardFor(item: GalleryItemDto): OpenGraphCard {
    const base: OpenGraphCard = {
      canonicalUrl: `${this.siteUrl()}/gallery/${item.id}`,
      siteName: this.siteName(),
      title: item.title,
      description: this.describe(item),
      imageUrl: item.thumbnailUrl ?? null,
    };

    // An uploaded VIDEO: the R2 URL is permanent, unsigned, carries a real
    // content type and no Content-Disposition, so unfurlers play it directly.
    const video = item.files?.find((file) => file.mediaType === GalleryMediaType.Video && file.url);
    if (video?.url) {
      return {
        ...base,
        // The poster frame — a player card with no image is dropped outright by
        // some unfurlers, so the still matters more than the player does.
        imageUrl: item.thumbnailUrl ?? null,
        video: {
          url: video.url,
          type: this.videoMimeFor(video.url),
          width: video.width,
          height: video.height,
        },
      };
    }

    // An uploaded IMAGE: first file wins. A multi-image submission previews as
    // its first frame and links back for the rest — an unfurl shows one image.
    const image = item.files?.find((file) => file.mediaType === GalleryMediaType.Image && file.url);
    if (image?.url) {
      return { ...base, imageUrl: image.url };
    }

    if (item.type === GalleryType.Link && item.linkUrl) {
      return this.linkCard(base, item.linkUrl);
    }

    return base;
  }

  /** A card for a recognised external provider, or a plain one for anything else. */
  private linkCard(base: OpenGraphCard, linkUrl: string): OpenGraphCard {
    let parsed: URL;
    try {
      parsed = new URL(linkUrl);
    } catch {
      return base;
    }
    const host = parsed.hostname.toLowerCase();

    const youtubeId = MediaEmbedService.extractYouTubeId(parsed, host);
    if (youtubeId) {
      return {
        ...base,
        imageUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
        video: {
          // `youtube-nocookie` matches the `frame-src` the site CSP already
          // allows, so the in-app player and the unfurled one agree.
          url: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
          type: 'text/html',
          width: 1280,
          height: 720,
        },
      };
    }

    const medalId = MediaEmbedService.extractMedalId(parsed, host);
    if (medalId) {
      return {
        ...base,
        // This API's own proxy: stable, unlike Medal's signed CDN URLs, which
        // expire and would leave the card imageless days later.
        imageUrl: `${this.siteUrl()}/${this.apiPrefix()}/gallery/media/medal/${medalId}/thumbnail`,
      };
    }

    // Unrecognised host: say what it is, show nothing fetched from it.
    return { ...base, description: `${base.description} — ${parsed.origin}`.slice(0, 300) };
  }

  /** Caption first, falling back to the author line, then a bare site line. */
  private describe(item: GalleryItemDto): string {
    const caption = item.caption?.trim();
    if (caption) {
      return caption.length > MAX_DESCRIPTION
        ? `${caption.slice(0, MAX_DESCRIPTION - 1)}…`
        : caption;
    }
    return item.author?.name
      ? `Shared by ${item.author.name} in the ${this.siteName()} gallery.`
      : `From the ${this.siteName()} gallery.`;
  }

  /**
   * The container type for an uploaded video, from its extension.
   *
   * Uploads are constrained to mp4/webm/mov at presign time and the extension is
   * minted by the server from the signed content type, so the extension is
   * trustworthy here in a way a client-supplied one would not be. `.mov` is
   * reported as `video/mp4`: QuickTime is a fourcc-compatible container and
   * `video/quicktime` makes most unfurlers refuse to play it at all.
   */
  private videoMimeFor(url: string): string {
    return url.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
  }

  private siteUrl(): string {
    return (this.config.get('frontend', { infer: true }).url ?? '').replace(/\/$/, '');
  }

  private siteName(): string {
    return 'Lords Regiment';
  }

  private apiPrefix(): string {
    return this.config.get('apiPrefix', { infer: true });
  }
}
