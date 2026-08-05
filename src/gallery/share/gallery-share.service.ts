import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GalleryMediaType, GalleryType } from '../../common/enums';
import { AppConfig } from '../../config/configuration';
import { RegimentsService } from '../../regiments/regiments.service';
import { BRAND_ACCENT, documentTitle } from '../../seo/html/brand';
import { imageMimeFor, isoDuration, videoMimeFor } from '../../seo/html/media-type';
import {
  renderPageShell,
  ShellImage,
  ShellMedia,
  ShellPage,
  ShellVideo,
} from '../../seo/html/page-shell';
import { GalleryQueryDto } from '../dto/gallery-query.dto';
import { GalleryFileDto, GalleryItemDto } from '../dto/gallery-item.dto';
import { GalleryService } from '../gallery.service';
import { MediaEmbedService } from '../media/media-embed.service';

/** Trimmed to a length every unfurler renders without an ellipsis of its own. */
const MAX_DESCRIPTION = 200;

/** How many dispatches the crawler shell lists on one gallery page. */
const GALLERY_PAGE_SIZE = 24;

/** What `cardFor` decided this item is, before any of it is turned into markup. */
interface GalleryCard {
  image: ShellImage | null;
  video: ShellVideo | null;
  /** The `<img>`/`<video>` the body renders, when the media is ours to embed. */
  media: ShellMedia | null;
  /** Appended to the description for an external host we will not fetch from. */
  descriptionSuffix?: string;
}

/**
 * Builds the share page for a public gallery item (T-0197, rebuilt in T-0293).
 *
 * ── THE RULE FOR EXTERNAL LINKS ─────────────────────────────────────────────
 * Only providers this codebase ALREADY understands get a rich card: YouTube and
 * Medal.tv, recognised by the same pure extractors the in-app embed resolver
 * uses. Anything else falls back to a titled card with the link written out —
 * deliberately, because the alternative is fetching an arbitrary
 * member-supplied URL from the server and re-publishing whatever it returns, on
 * an UNAUTHENTICATED route. That is an SSRF surface and a way to launder
 * someone else's content through this domain's reputation. A dull preview is
 * the right failure.
 *
 * ── AND WHY NOTHING HERE MAKES AN OUTBOUND REQUEST ──────────────────────────
 * The YouTube thumbnail is a static i.ytimg.com URL derived from the video id,
 * and the Medal thumbnail points at this API's own already-public, throttled,
 * cached proxy. Both are computed, not fetched. The authenticated
 * `/gallery/media/resolve` endpoint may fetch; this one may not, because a
 * crawler hitting it is not a signed-in member.
 *
 * ── WHY IT RENDERS A WHOLE PAGE NOW, NOT A HEAD FULL OF META TAGS (T-0293) ──
 * It was built for Discord and it shows: the entire body used to be one anchor.
 * That is the right document for an unfurler and the wrong one for Google, and
 * the same UA matcher sends BOTH here — `googlebot` is in the Caddy regex. A
 * search engine receiving a stub while every human gets a populated Angular
 * page is cloaking whatever the intent was. So this now renders through
 * `renderPageShell`, the same renderer the roster and profile shells use, with
 * the picture or the clip actually in the body, the author and the tags as
 * crawlable facts, and `ImageObject`/`VideoObject` structured data — while
 * keeping every `og:video`/`twitter:player` tag the unfurler came for.
 *
 * ── WHY THE AUTHOR IS NOT A LINK TO THEIR PROFILE ───────────────────────────
 * `GalleryMemberRefDto` carries `memberId` and a display name but no handle, so
 * building `/u/@…` would mean resolving the member — and `MembersModule` already
 * imports `GalleryModule`, so importing it back here is a dependency cycle. The
 * author is named in the facts list and in the JSON-LD `author` instead, which
 * is what the SPA shows too; the profile is one click away through the roster.
 */
@Injectable()
export class GalleryShareService {
  constructor(
    private readonly gallery: GalleryService,
    private readonly regiments: RegimentsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * The share shell for one item, or null when there is nothing shareable —
   * the item does not exist, is not approved, or the gallery is private. The
   * caller turns that into the generic card rather than leaking which of the
   * three it was, because a 404 body unfurls in Discord as a broken preview.
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
    return renderPageShell(this.pageFor(item, await this.regimentName()));
  }

  /** The public gallery index, as a crawlable list of its most recent items. */
  async renderIndex(page: number): Promise<string> {
    const regimentName = await this.regimentName();
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    // A real DTO instance, not a literal: `skip` is a getter on the base class,
    // so an object that looks structurally identical would silently paginate
    // from zero on every page.
    const query = new GalleryQueryDto();
    query.page = safePage;
    query.limit = GALLERY_PAGE_SIZE;
    const result = await this.gallery.findPublic(query);

    const items = result.data;
    // The newest item with a usable still becomes the card for the whole
    // gallery — an image archive whose own share link has no image is the one
    // failure this page cannot afford.
    const lead = items.map((item) => this.stillFor(item)).find((still) => !!still) ?? null;

    return renderPageShell({
      canonicalUrl: this.galleryUrl(safePage),
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      title: documentTitle(safePage === 1 ? 'Gallery' : `Gallery (page ${safePage})`, regimentName),
      description:
        `Photographs, clips and dispatches from the campaigns of ${regimentName}, ` +
        `a Holdfast: Nations at War regiment — ${result.meta.total} ` +
        `${result.meta.total === 1 ? 'entry' : 'entries'} submitted by its members.`,
      heading: 'Gallery',
      subheading: `${result.meta.total} ${result.meta.total === 1 ? 'dispatch' : 'dispatches'}`,
      imageUrl: lead,
      paragraphs: [
        `Every image and clip below was submitted by a member of ${regimentName} and ` +
          'approved by its officers before it was published.',
      ],
      prevUrl: result.meta.hasPrev ? this.galleryUrl(safePage - 1) : null,
      nextUrl: result.meta.hasNext ? this.galleryUrl(safePage + 1) : null,
      sections: [
        {
          heading: 'Dispatches',
          links: items.map((item) => ({
            href: `${this.siteUrl()}/gallery/${item.id}`,
            label: item.title,
            meta: [item.author?.name, this.formatDate(item.submittedAt)]
              .filter(Boolean)
              .join(' · '),
          })),
        },
        {
          heading: 'Regiment',
          links: this.regimentLinks(),
        },
      ],
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ImageGallery',
        name: `${regimentName} gallery`,
        url: this.galleryUrl(safePage),
        numberOfItems: result.meta.total,
        // `ItemList` inside the gallery rather than as a sibling node: it is the
        // gallery's contents, and a flat second list would compete with it.
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: items.map((item, index) => ({
            '@type': 'ListItem',
            position: (safePage - 1) * GALLERY_PAGE_SIZE + index + 1,
            url: `${this.siteUrl()}/gallery/${item.id}`,
            name: item.title,
          })),
        },
      },
    });
  }

  /** The generic site card, used when an id resolves to nothing public. */
  async renderFallback(): Promise<string> {
    const regimentName = await this.regimentName();
    return renderPageShell({
      canonicalUrl: `${this.siteUrl()}/gallery`,
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      title: documentTitle('Gallery', regimentName),
      description: 'Roster, events and gallery for a Holdfast: Nations at War regiment.',
      heading: 'Gallery',
      // A share link that no longer resolves must not be indexed as if it did:
      // the id is gone, the card is generic, and the canonical points at the
      // index. Without this the whole `/gallery/*` space would look like one
      // page duplicated at every dead id.
      noIndex: true,
      paragraphs: ['This dispatch is no longer available.'],
      sections: [{ heading: 'Regiment', links: this.regimentLinks() }],
    });
  }

  /** Everything one item's page says, in both languages the document speaks. */
  private pageFor(item: GalleryItemDto, regimentName: string): ShellPage {
    const card = this.cardFor(item);
    const canonicalUrl = `${this.siteUrl()}/gallery/${item.id}`;
    const description = this.describe(item, regimentName, card.descriptionSuffix);

    return {
      canonicalUrl,
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      title: documentTitle(item.title, regimentName),
      description,
      ogType: card.video ? 'video.other' : 'article',
      imageUrl: card.image,
      video: card.video,
      media: card.media,
      heading: item.title,
      subheading: item.author?.name ? `Submitted by ${item.author.name}` : null,
      publishedTime: item.approvedAt ?? item.submittedAt,
      modifiedTime: item.updatedAt,
      // The caption is the only hand-written prose an item has; the generated
      // line below it is what makes the page readable when there is none.
      paragraphs: [
        ...(item.caption?.trim() ? [item.caption.trim()] : []),
        `From the ${regimentName} gallery, a Holdfast: Nations at War regiment.`,
      ],
      facts: [
        ...(item.author?.name ? [{ label: 'Submitted by', value: item.author.name }] : []),
        { label: 'Published', value: this.formatDate(item.approvedAt ?? item.submittedAt) },
        { label: 'Type', value: this.typeLabel(item) },
        ...(item.tags.length ? [{ label: 'Tags', value: item.tags.join(', ') }] : []),
      ],
      sections: [
        ...(item.type === GalleryType.Link && item.linkUrl
          ? [
              {
                heading: 'Source',
                links: [
                  {
                    href: item.linkUrl,
                    label: this.originOf(item.linkUrl) ?? item.linkUrl,
                    // Member-chosen destination, exactly like a profile's social
                    // links: not an endorsement, and not somewhere this domain
                    // should spend its crawl equity.
                    rel: 'nofollow ugc',
                  },
                ],
              },
            ]
          : []),
        { heading: 'Regiment', links: this.regimentLinks() },
      ],
      jsonLd: this.jsonLdFor(item, canonicalUrl, description, card, regimentName),
    };
  }

  /**
   * Which asset represents this item, and how.
   *
   * The order is the SPA's order, and it has to stay that way: the client
   * applies the same rule in `gallery-detail.component.ts` on Googlebot's
   * rendered pass, and a card that disagreed with the page it labels is the
   * exact divergence dynamic rendering must not have.
   */
  private cardFor(item: GalleryItemDto): GalleryCard {
    const poster = item.thumbnailUrl ?? null;

    // An uploaded VIDEO: the object-store URL is permanent, unsigned, carries a
    // real content type and no Content-Disposition, so unfurlers play it
    // directly rather than offering a download.
    const video = item.files?.find((file) => file.mediaType === GalleryMediaType.Video && file.url);
    if (video?.url) {
      const type = videoMimeFor(video.url);
      return {
        // The poster frame. A player card with no image is dropped outright by
        // several unfurlers, so the still matters more than the player does.
        image: poster ? { url: poster, type: imageMimeFor(poster), alt: item.title } : null,
        video: {
          url: video.url,
          type,
          width: video.width,
          height: video.height,
          durationSeconds: video.durationSeconds,
        },
        media: {
          kind: 'video',
          url: video.url,
          posterUrl: poster,
          type,
          width: video.width,
          height: video.height,
        },
      };
    }

    // An uploaded IMAGE: first file wins. A multi-image submission previews as
    // its first frame and links back for the rest — an unfurl shows one image.
    const image = item.files?.find((file) => file.mediaType === GalleryMediaType.Image && file.url);
    if (image?.url) {
      return {
        image: this.shellImageFor(image, item.title),
        video: null,
        media: {
          kind: 'image',
          url: image.url,
          alt: item.caption?.trim() || item.title,
          width: image.width,
          height: image.height,
        },
      };
    }

    if (item.type === GalleryType.Link && item.linkUrl) {
      return this.linkCard(item, poster);
    }

    return {
      image: poster ? { url: poster, type: imageMimeFor(poster), alt: item.title } : null,
      video: null,
      media: null,
    };
  }

  /** A card for a recognised external provider, or a plain one for anything else. */
  private linkCard(item: GalleryItemDto, poster: string | null): GalleryCard {
    const fallback: GalleryCard = {
      image: poster ? { url: poster, type: imageMimeFor(poster), alt: item.title } : null,
      video: null,
      media: null,
    };

    let parsed: URL;
    try {
      parsed = new URL(item.linkUrl as string);
    } catch {
      return fallback;
    }
    // NOT `parsed.hostname` — the extractors match the bare `youtube.com`, so a
    // raw hostname misses every `www.` URL, which is the form YouTube hands out.
    const host = MediaEmbedService.hostOf(parsed);

    const youtubeId = MediaEmbedService.extractYouTubeId(parsed, host);
    if (youtubeId) {
      const thumbnail = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
      return {
        image: { url: thumbnail, type: 'image/jpeg', alt: item.title, width: 480, height: 360 },
        video: {
          // `youtube-nocookie` matches the `frame-src` the site CSP already
          // allows, so the in-app player and the unfurled one agree.
          url: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
          type: 'text/html',
          width: 1280,
          height: 720,
        },
        // No body media: an <iframe> to a third party in a document served to
        // crawlers is a request we do not need to make on their behalf, and the
        // `Source` link below already takes a human there.
        media: null,
      };
    }

    const medalId = MediaEmbedService.extractMedalId(parsed, host);
    if (medalId) {
      return {
        // This API's own proxy: stable, unlike Medal's signed CDN URLs, which
        // expire and would leave the card imageless days later.
        image: {
          url: `${this.siteUrl()}/${this.apiPrefix()}/gallery/media/medal/${medalId}/thumbnail`,
          alt: item.title,
        },
        video: null,
        media: null,
      };
    }

    // Unrecognised host: say what it is, show nothing fetched from it.
    return { ...fallback, descriptionSuffix: parsed.origin };
  }

  private shellImageFor(file: GalleryFileDto, title: string): ShellImage {
    return {
      url: file.url as string,
      alt: title,
      width: file.width,
      height: file.height,
      type: imageMimeFor(file.url as string),
    };
  }

  /**
   * `ImageObject` / `VideoObject` for the item, or a plain `CreativeWork`.
   *
   * A `VideoObject` is only claimed when there is a poster AND an upload date,
   * because Google treats both as required and an incomplete one is an invalid
   * structured-data error rather than a partial win. The same logic keeps an
   * `ImageObject` off an item with no image.
   */
  private jsonLdFor(
    item: GalleryItemDto,
    canonicalUrl: string,
    description: string,
    card: GalleryCard,
    regimentName: string,
  ): unknown {
    const uploadDate = item.approvedAt ?? item.submittedAt;
    const common = {
      '@context': 'https://schema.org',
      name: item.title,
      description,
      url: canonicalUrl,
      datePublished: uploadDate,
      // `creator` AND `creditText` are not belt-and-braces: Google's ImageObject
      // requires `contentUrl` plus AT LEAST ONE of creator/creditText/
      // copyrightNotice/license, and an item submitted by a member with no
      // stored name would otherwise satisfy none of them.
      ...(item.author?.name
        ? {
            author: { '@type': 'Person', name: item.author.name },
            creator: { '@type': 'Person', name: item.author.name },
            creditText: `${item.author.name} · ${regimentName}`,
          }
        : { creditText: regimentName }),
      copyrightNotice: `© ${regimentName}`,
      ...(item.tags.length ? { keywords: item.tags.join(', ') } : {}),
      isPartOf: {
        '@type': 'CollectionPage',
        name: `${regimentName} gallery`,
        url: `${this.siteUrl()}/gallery`,
      },
      copyrightHolder: { '@type': 'Organization', name: regimentName, url: this.siteUrl() },
    };

    if (card.video && card.image) {
      return {
        ...common,
        '@type': 'VideoObject',
        thumbnailUrl: card.image.url,
        uploadDate,
        contentUrl: card.video.type === 'text/html' ? undefined : card.video.url,
        embedUrl: card.video.type === 'text/html' ? card.video.url : undefined,
        ...(isoDuration(card.video.durationSeconds)
          ? { duration: isoDuration(card.video.durationSeconds) }
          : {}),
        ...(card.video.width && card.video.height
          ? { width: card.video.width, height: card.video.height }
          : {}),
      };
    }

    if (card.image) {
      return {
        ...common,
        '@type': 'ImageObject',
        contentUrl: card.image.url,
        thumbnailUrl: card.image.url,
        ...(card.image.width && card.image.height
          ? { width: card.image.width, height: card.image.height }
          : {}),
      };
    }

    return { ...common, '@type': 'CreativeWork' };
  }

  /** Caption first, falling back to the author line, then a bare site line. */
  private describe(item: GalleryItemDto, regimentName: string, suffix?: string): string {
    const base = this.baseDescription(item, regimentName);
    // An unrecognised external link: naming the origin the link points at beats
    // a card that says nothing about where it goes.
    return suffix ? `${base} — ${suffix}`.slice(0, 300) : base;
  }

  private baseDescription(item: GalleryItemDto, regimentName: string): string {
    const caption = item.caption?.trim();
    if (caption) {
      return caption.length > MAX_DESCRIPTION
        ? `${caption.slice(0, MAX_DESCRIPTION - 1)}…`
        : caption;
    }
    return item.author?.name
      ? `Shared by ${item.author.name} in the ${regimentName} gallery.`
      : `From the ${regimentName} gallery.`;
  }

  private typeLabel(item: GalleryItemDto): string {
    if (item.type === GalleryType.Video) return 'Video';
    if (item.type === GalleryType.Link) return 'Link';
    const count = item.files?.length ?? 0;
    return count > 1 ? `Image (${count} files)` : 'Image';
  }

  /** The still an index card can use, from whichever asset this item has. */
  private stillFor(item: GalleryItemDto): ShellImage | null {
    return this.cardFor(item).image;
  }

  private originOf(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  private regimentLinks(): { href: string; label: string }[] {
    return [
      { href: `${this.siteUrl()}/gallery`, label: 'Gallery' },
      { href: `${this.siteUrl()}/roster`, label: 'Regimental Roster' },
      { href: `${this.siteUrl()}/events`, label: 'Events' },
    ];
  }

  private galleryUrl(page: number): string {
    return page <= 1 ? `${this.siteUrl()}/gallery` : `${this.siteUrl()}/gallery?page=${page}`;
  }

  private formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  private async regimentName(): Promise<string> {
    try {
      const profile = await this.regiments.getProfile();
      return profile?.name || 'Lords Regiment';
    } catch {
      return 'Lords Regiment';
    }
  }

  private siteUrl(): string {
    return (this.config.get('frontend', { infer: true }).url ?? '').replace(/\/$/, '');
  }

  private apiPrefix(): string {
    return this.config.get('apiPrefix', { infer: true });
  }
}
