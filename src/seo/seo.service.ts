import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventStatus } from '../common/enums';
import { AppConfig } from '../config/configuration';
import { EventDto } from '../events/dto/event.dto';
import { EventQueryDto } from '../events/dto/event-query.dto';
import { EventsService } from '../events/events.service';
import { GalleryQueryDto } from '../gallery/dto/gallery-query.dto';
import { GalleryService } from '../gallery/gallery.service';
import { GalleryShareService } from '../gallery/share/gallery-share.service';
import { PublicMemberDto } from '../members/dto/public-member.dto';
import { PublicMemberQueryDto } from '../members/public/public-member-query.dto';
import { PublicMembersService } from '../members/public/public-members.service';
import { RegimentProfileDto } from '../regiments/dto/regiment-profile.dto';
import { RegimentsService } from '../regiments/regiments.service';
import { BRAND_ACCENT, documentTitle } from './html/brand';
import { imageMimeFor } from './html/media-type';
import { renderPageShell, ShellImage, ShellLink } from './html/page-shell';

/** How many roster rows the crawler shell lists per page. */
const ROSTER_PAGE_SIZE = 50;

/** How many events the crawler shell lists per page. */
const EVENTS_PAGE_SIZE = 50;

/**
 * Where an event's own description is cut for the meta description.
 *
 * 200 characters, matching `DESCRIPTION_LIMIT` in the SPA's
 * `event-detail.component.ts` exactly — the two strings have to be identical,
 * and this is the number that decides where they stop.
 */
const EVENT_DESCRIPTION_LIMIT = 200;

/**
 * The card image for a page that has nothing of its own to show (T-0293).
 *
 * Site-relative on purpose: it is an asset in the Angular build, served from
 * this origin, and {@link SeoService.siteUrl} makes it absolute. Without a
 * default, the home page and an empty events calendar would unfurl as a bare
 * line of text — `twitter:card` degrades to `summary` when there is no image,
 * and the frontend's `SeoService` applies the identical fallback so the two
 * documents keep agreeing.
 */
const DEFAULT_CARD_IMAGE = '/assets/images/banner.png';
const DEFAULT_CARD_WIDTH = 853;
const DEFAULT_CARD_HEIGHT = 480;

/**
 * Renders the public pages as crawlable HTML (T-0215, widened in T-0293).
 *
 * ── THE EQUIVALENCE RULE ────────────────────────────────────────────────────
 * Every method here answers from the SAME service, the same exclusion predicate
 * and the same DTO the SPA's own fetch uses — {@link PublicMembersService} for
 * the roster and profiles, {@link EventsService} for the calendar,
 * {@link GalleryShareService} (over `GalleryService.findPublic`) for the
 * gallery. That is not tidiness, it is the thing that keeps this out of
 * cloaking territory: a crawler and a human are looking at one source of truth
 * rendered twice, so they cannot disagree about who is on the roster, what is
 * on the calendar or what a profile says. If a predicate changes, both surfaces
 * change together.
 *
 * ── WHY EVERY PUBLIC PAGE IS HERE NOW, NOT JUST THE ROSTER ──────────────────
 * The module shipped covering `/roster` and `/u/*` because those were the URLs
 * with something to rank. `/events`, `/events/:id`, `/gallery` and `/home` were
 * left on the Angular shell, which meant a member pasting an event link into
 * Discord got a preview with the site's generic title, the site's generic blurb
 * and no banner — identical for every event the regiment has ever run. The
 * pages a regiment actually SHARES are the ones this module was missing.
 */
@Injectable()
export class SeoService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly members: PublicMembersService,
    private readonly regiments: RegimentsService,
    private readonly events: EventsService,
    private readonly gallery: GalleryShareService,
    private readonly galleryItems: GalleryService,
  ) {}

  /** The public roster as a crawlable, linked list. */
  async renderRoster(page: number): Promise<string> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    // A real DTO instance, not a literal: `skip` is a getter on the base class,
    // so an object literal that looks structurally identical would silently
    // paginate from zero on every page.
    const query = new PublicMemberQueryDto();
    query.page = safePage;
    query.limit = ROSTER_PAGE_SIZE;
    const result = await this.members.list(query);
    const regimentName = await this.regimentName();

    const links: ShellLink[] = result.data.map((member) => ({
      href: `${this.siteUrl()}${member.canonicalPath}`,
      label: this.displayName(member),
      meta: [member.rank, member.role].filter(Boolean).join(' · ') || null,
    }));

    return renderPageShell({
      canonicalUrl: this.rosterUrl(safePage),
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      imageUrl: this.defaultCardImage(),
      title: documentTitle(
        safePage === 1 ? 'Regimental Roster' : `Regimental Roster (page ${safePage})`,
        regimentName,
      ),
      description:
        `Every serving member of ${regimentName}, a Holdfast: Nations at War regiment — ` +
        `${result.meta.total} members with their rank and decorations.`,
      heading: 'Regimental Roster',
      subheading: `${result.meta.total} serving members`,
      paragraphs: [
        `${regimentName} is a Holdfast: Nations at War regiment. Every member below has a ` +
          'public profile listing their rank, their decorations and how long they have served.',
      ],
      sections: [{ heading: 'Members', links }],
      prevUrl: result.meta.hasPrev ? this.rosterUrl(safePage - 1) : null,
      nextUrl: result.meta.hasNext ? this.rosterUrl(safePage + 1) : null,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `${regimentName} roster`,
        numberOfItems: result.meta.total,
        itemListElement: result.data.map((member, index) => ({
          '@type': 'ListItem',
          position: (safePage - 1) * ROSTER_PAGE_SIZE + index + 1,
          url: `${this.siteUrl()}${member.canonicalPath}`,
          name: this.displayName(member),
        })),
      },
    });
  }

  /**
   * One member's profile. Throws whatever {@link PublicMembersService} throws —
   * 404 for a member with no public page, 410 for a deleted account — so the
   * crawler gets the same status code the API would give, which is the entire
   * point of returning a status code to a crawler.
   */
  async renderProfile(handle: string): Promise<string> {
    const { dto } = await this.members.findByHandle(handle);
    const regimentName = await this.regimentName();
    const canonicalUrl = `${this.siteUrl()}${dto.canonicalPath}`;
    const name = this.displayName(dto);
    const handleLabel = dto.username ? `@${dto.username}` : null;

    // ── THE BIO IS THE ONLY UNIQUE BODY COPY A PROFILE HAS (T-0216) ──────────
    // `page-shell.ts` argues at length that a crawler must not be served less
    // than a human, and the medal citations were this page's answer to the
    // adjacent worry: that a profile is a THIN page. Everything else here is
    // generated from structured fields, so every profile says it in the same
    // words with the nouns swapped — which is what a doorway page looks like.
    // A bio is hand-written prose that exists on no other URL on the internet,
    // so it is the single strongest thing this document can carry, and it must
    // be in the shell because the SPA renders it directly under the name on the
    // second pass. Trimmed and dropped when blank: the service stores NULL for
    // whitespace-only, and an empty `<p>` would be markup asserting nothing.
    const bio = dto.bio?.trim() ?? '';

    const facts = [
      { label: 'In-game name', value: dto.inGameName },
      ...(handleLabel ? [{ label: 'Handle', value: handleLabel }] : []),
      ...(dto.rank ? [{ label: 'Rank', value: dto.rank }] : []),
      { label: 'Role', value: dto.role },
      ...(dto.joinedAt ? [{ label: 'Serving since', value: this.formatDate(dto.joinedAt) }] : []),
      { label: 'Events attended', value: String(dto.eventsAttended) },
      { label: 'Decorations', value: String(dto.medals.length) },
    ];

    return renderPageShell({
      canonicalUrl,
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      ogType: 'profile',
      title: documentTitle(name, regimentName),
      description: this.describeProfile(dto, regimentName),
      heading: name,
      subheading: [dto.rank, dto.role].filter(Boolean).join(' · ') || null,
      imageUrl: this.profileCardImage(dto, name),
      // The avatar again, always, as the visible portrait. `imageUrl` above may
      // have chosen the banner for the card; this is the face.
      media: dto.avatarUrl
        ? { kind: 'image', url: this.absoluteAsset(dto.avatarUrl) as string, alt: name }
        : null,
      paragraphs: [
        // The member's own words lead, as they do in the SPA (the bio is the
        // paragraph under the name); the generated sentence follows it.
        ...(bio ? [bio] : []),
        `${name} serves with ${regimentName}, a Holdfast: Nations at War regiment` +
          (dto.rank ? `, at the rank of ${dto.rank}` : '') +
          (dto.joinedAt ? `, since ${this.formatDate(dto.joinedAt)}` : '') +
          '.',
      ],
      facts,
      sections: [
        {
          heading: 'Honours & Decorations',
          // Each medal contributes its own title AND the catalogue criteria —
          // this is the substance that keeps a profile from reading as a thin
          // doorway page with nothing on it but a name.
          links: dto.medals.map((medal) => ({
            href: `${this.siteUrl()}/roster`,
            label: medal.title,
            meta: medal.description ?? this.formatDate(medal.awardedAt),
          })),
        },
        {
          // ── MEMBER-AUTHORED OUTBOUND LINKS (T-0216) ─────────────────────────
          // `href` is NOT member input, and that distinction is the entire
          // reason social links are stored as HANDLES: the DTO carries a URL
          // composed server-side from the stored handle against one of the
          // seven hardcoded origins in `members/social-platforms.ts`, so the
          // set of hosts this page can ever link to is fixed and a member
          // cannot widen it. What a member controls is the path segment, which
          // is bounded by that platform's handle pattern.
          //
          // They still get `rel="nofollow ugc"`: the destination is a user's
          // choice, not an editorial endorsement by the regiment, and this
          // domain should not spend crawl equity on it. For the same reason
          // they are NOT added to the JSON-LD `Person` as `sameAs`: that
          // property asserts "this account IS this person", and nothing here
          // verifies a handle — anyone can type someone else's. An unverified
          // `sameAs` is a false structured-data claim; an anchor is just a link.
          //
          // Nothing is filtered here on purpose. The shell's one job is to say
          // exactly what the SPA says, so a link dropped HERE would be a link
          // the crawler misses on pass one and finds on pass two — the precise
          // disagreement this module exists to avoid. A row whose platform has
          // no registry entry is dropped once, in the projection that builds
          // `socialLinks`, and is therefore absent from both surfaces.
          heading: 'Elsewhere',
          links: dto.socialLinks.map((link) => ({
            href: link.url,
            label: `${link.label} — ${link.handle}`,
            rel: 'nofollow ugc',
          })),
        },
        {
          heading: 'Regiment',
          links: [
            { href: `${this.siteUrl()}/roster`, label: 'Regimental Roster' },
            { href: `${this.siteUrl()}/events`, label: 'Events' },
            { href: `${this.siteUrl()}/gallery`, label: 'Gallery' },
          ],
        },
      ],
      // Slack renders these as two labelled fields beneath the unfurl. Nothing
      // else reads them, and nothing else has a place to put them.
      labels: [
        ...(dto.rank ? [{ label: 'Rank', data: dto.rank }] : []),
        { label: 'Decorations', data: String(dto.medals.length) },
      ],
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        url: canonicalUrl,
        // `dateCreated` is the join date, which is what Google's ProfilePage
        // documentation means by it — when the profile's subject came into
        // existence here, not when the row was last touched.
        ...(dto.joinedAt ? { dateCreated: dto.joinedAt } : {}),
        dateModified: new Date().toISOString(),
        mainEntity: {
          '@type': 'Person',
          name,
          alternateName: handleLabel ?? dto.inGameName,
          identifier: dto.id,
          url: canonicalUrl,
          ...(bio ? { description: bio } : {}),
          ...(dto.avatarUrl ? { image: this.absoluteAsset(dto.avatarUrl) } : {}),
          ...(dto.rank ? { jobTitle: dto.rank } : {}),
          memberOf: { '@type': 'Organization', name: regimentName, url: this.siteUrl() },
          ...(dto.medals.length ? { award: dto.medals.map((medal) => medal.title) } : {}),
        },
      },
    });
  }

  /**
   * The landing page (T-0293).
   *
   * ── WHY `/home` AND NOT `/` ─────────────────────────────────────────────────
   * Both render the landing component, but the router redirects `/` to `/home`,
   * so `/home` is the URL a visitor's address bar actually settles on and the
   * one the SPA declares canonical. Two URLs for one page is a duplicate; this
   * shell agrees with the SPA about which of them wins.
   *
   * `/` itself is deliberately NOT routed to a shell at the edge — see the
   * matcher comment in the Caddyfile. It is the one path Cloudflare is told to
   * cache, and Cloudflare does not honour `Vary: User-Agent`, so a UA-varying
   * `/` would eventually serve this crawler document to a human.
   */
  async renderHome(): Promise<string> {
    const profile = await this.regimentProfile();
    const regimentName = profile?.name || 'Lords Regiment';
    const canonicalUrl = `${this.siteUrl()}/home`;
    const mission =
      profile?.missionStatement?.trim() ||
      'Roster, events and gallery for a Holdfast: Nations at War regiment.';

    // The admin-editable hero wins, then the regiment banner, then NULL — which
    // `cardImageFor` turns into the shipped brand banner complete with its
    // dimensions. Naming `DEFAULT_CARD_IMAGE` here instead would route it
    // through the same branch as a CDN URL and silently drop the width/height
    // an unfurler lays the card out from.
    const hero = profile?.presentation?.heroBannerUrl || profile?.bannerUrl || null;

    const established = profile?.establishedYear ?? null;

    return renderPageShell({
      canonicalUrl,
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      title: documentTitle(regimentName, regimentName),
      description: mission,
      heading: regimentName,
      subheading: established ? `A Holdfast: Nations at War regiment since ${established}` : null,
      imageUrl: this.cardImageFor(hero, regimentName),
      paragraphs: [
        mission,
        `${regimentName} musters for line battles, drills and campaign nights in ` +
          'Holdfast: Nations at War. The roster below lists every serving member with ' +
          'their rank and decorations; the calendar lists what is scheduled next.',
      ],
      facts: [
        ...(profile?.memberCount ? [{ label: 'Members', value: String(profile.memberCount) }] : []),
        ...(established ? [{ label: 'Established', value: String(established) }] : []),
        { label: 'Game', value: 'Holdfast: Nations at War' },
      ],
      sections: [
        {
          heading: 'Regiment',
          links: [
            { href: `${this.siteUrl()}/roster`, label: 'Regimental Roster' },
            { href: `${this.siteUrl()}/events`, label: 'Events' },
            { href: `${this.siteUrl()}/gallery`, label: 'Gallery' },
          ],
        },
      ],
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: regimentName,
          description: mission,
          url: this.siteUrl(),
          ...(profile?.crestUrl ? { logo: profile.crestUrl } : {}),
          ...(hero ? { image: this.absoluteAsset(hero) } : {}),
          ...(established ? { foundingDate: String(established) } : {}),
          // The Discord invite is the regiment's own published account, not a
          // member's unverified claim to one — so unlike a profile's social
          // links it IS a `sameAs` we can stand behind.
          ...(profile?.discordInviteUrl ? { sameAs: [profile.discordInviteUrl] } : {}),
        },
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: regimentName,
          url: this.siteUrl(),
        },
      ],
    });
  }

  /**
   * The public calendar (T-0293).
   *
   * Mirrors `listPublic` exactly, which means it inherits its 90-day window on
   * past events and its `startsAt ASC` ordering. RSVP tallies are absent on
   * purpose: they are member-projection fields (turnout is unit strength), so
   * the shell cannot show what the SPA's public page does not.
   */
  async renderEvents(page: number): Promise<string> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    // A real DTO instance, not a literal — `skip` is a getter on the base class.
    const query = new EventQueryDto();
    query.page = safePage;
    query.limit = EVENTS_PAGE_SIZE;
    const result = await this.events.listPublic(query);
    const regimentName = await this.regimentName();

    const upcoming = result.data.filter((event) => event.status !== EventStatus.Previous);
    // The next event's banner is the card, because that is the thing a shared
    // calendar link is actually advertising. Null falls through to the brand
    // banner, so a quiet week still unfurls with a picture.
    const lead = upcoming.find((event) => event.bannerUrl)?.bannerUrl ?? null;

    return renderPageShell({
      canonicalUrl: this.eventsUrl(safePage),
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      title: documentTitle(
        safePage === 1 ? 'Events & Orders' : `Events & Orders (page ${safePage})`,
        regimentName,
      ),
      description: this.describeEvents(regimentName),
      heading: 'Events & Orders',
      subheading: `${upcoming.length} scheduled · ${result.meta.total} on the calendar`,
      imageUrl: this.cardImageFor(lead, `${regimentName} events`),
      paragraphs: [
        `Line battles, drills and campaign nights run by ${regimentName}, a Holdfast: ` +
          'Nations at War regiment. Every entry below is open to members and lists when ' +
          'it starts in its own timezone.',
      ],
      prevUrl: result.meta.hasPrev ? this.eventsUrl(safePage - 1) : null,
      nextUrl: result.meta.hasNext ? this.eventsUrl(safePage + 1) : null,
      sections: [
        {
          heading: 'Calendar',
          links: result.data.map((event) => ({
            href: `${this.siteUrl()}/events/${event.id}`,
            label: event.title,
            meta: this.eventWhen(event),
          })),
        },
        {
          heading: 'Regiment',
          links: [
            { href: `${this.siteUrl()}/roster`, label: 'Regimental Roster' },
            { href: `${this.siteUrl()}/gallery`, label: 'Gallery' },
          ],
        },
      ],
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `${regimentName} events`,
        numberOfItems: result.meta.total,
        itemListElement: result.data.map((event, index) => ({
          '@type': 'ListItem',
          position: (safePage - 1) * EVENTS_PAGE_SIZE + index + 1,
          url: `${this.siteUrl()}/events/${event.id}`,
          name: event.title,
        })),
      },
    });
  }

  /**
   * One event (T-0293).
   *
   * Throws whatever {@link EventsService} throws — 404 for an event that is
   * missing, drafted, archived or soft-deleted, 403 when the regiment has made
   * its calendar private. Both are the honest answer, and both are answers the
   * SPA physically cannot give: its wildcard route 200s everything.
   */
  async renderEvent(id: string): Promise<string> {
    const event = await this.events.getPublic(id);
    const regimentName = await this.regimentName();
    const canonicalUrl = `${this.siteUrl()}/events/${event.id}`;
    const when = this.eventWhen(event);

    return renderPageShell({
      canonicalUrl,
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      ogType: 'article',
      title: documentTitle(event.title, regimentName),
      description: this.describeEvent(event, regimentName),
      heading: event.title,
      subheading: when,
      imageUrl: this.cardImageFor(event.bannerUrl, event.title),
      media: event.bannerUrl ? { kind: 'image', url: event.bannerUrl, alt: event.title } : null,
      publishedTime: event.startsAt,
      paragraphs: [
        ...(event.description?.trim() ? [event.description.trim()] : []),
        `${event.title} is run by ${regimentName}, a Holdfast: Nations at War regiment.`,
        ...(event.outcome?.trim() ? [`Outcome: ${event.outcome.trim()}`] : []),
      ],
      facts: [
        { label: 'Starts', value: when },
        ...(event.endsAt
          ? [{ label: 'Ends', value: this.formatDateTime(event.endsAt, event.timezone) }]
          : []),
        { label: 'Timezone', value: event.timezone },
        { label: 'Status', value: this.eventStatusLabel(event) },
        ...(event.platforms.length
          ? [{ label: 'Platforms', value: event.platforms.join(', ') }]
          : []),
        ...(event.tags.length ? [{ label: 'Tags', value: event.tags.join(', ') }] : []),
      ],
      sections: [
        ...(event.twitchUrl
          ? [
              {
                heading: 'Watch',
                // The stream is a destination the regiment chose, but it is
                // still off-site and still someone else's page.
                links: [{ href: event.twitchUrl, label: 'Live on Twitch', rel: 'nofollow' }],
              },
            ]
          : []),
        {
          heading: 'Regiment',
          links: [
            { href: `${this.siteUrl()}/events`, label: 'Events' },
            { href: `${this.siteUrl()}/roster`, label: 'Regimental Roster' },
            { href: `${this.siteUrl()}/gallery`, label: 'Gallery' },
          ],
        },
      ],
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: event.title,
        url: canonicalUrl,
        // The absolute instants, never a rendered wall clock: `startsAt` is the
        // real moment, and `timezone` is only how to display it.
        startDate: event.startsAt,
        ...(event.endsAt ? { endDate: event.endsAt } : {}),
        eventStatus: 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
        // It happens on a game server whose binding is members-only, so the
        // only location a crawler can be given is the page itself.
        location: { '@type': 'VirtualLocation', url: canonicalUrl },
        organizer: { '@type': 'Organization', name: regimentName, url: this.siteUrl() },
        ...(event.description?.trim() ? { description: event.description.trim() } : {}),
        ...(event.bannerUrl ? { image: event.bannerUrl } : {}),
      },
    });
  }

  /**
   * The gallery index and one gallery item, both rendered by
   * {@link GalleryShareService} (T-0293).
   *
   * Delegated rather than reimplemented: that service owns the rule for which
   * asset represents an item, the YouTube/Medal extractors, and the refusal to
   * fetch an arbitrary member-supplied URL server-side. A second copy here
   * would drift from `/api/share/gallery/:id`, which an un-synced Caddyfile on
   * the box still points at, and the two would disagree about the same URL.
   */
  renderGallery(page: number): Promise<string> {
    return this.gallery.renderIndex(page);
  }

  async renderGalleryItem(id: string): Promise<string> {
    return (await this.gallery.renderItem(id)) ?? (await this.gallery.renderFallback());
  }

  /**
   * `urlset` for every indexable URL.
   *
   * Capped at the profile list the service returns and deliberately NOT
   * paginated into a sitemap index: a regiment is hundreds of people, not the
   * 50 000-URL limit, and a single file that a human can open and read is worth
   * more here than a scheme that scales to a size this site will never reach.
   */
  async renderSitemap(): Promise<string> {
    const site = this.siteUrl();
    const profiles = await this.members.listForSitemap();
    // Events and gallery items are each a real, indexable URL with its own
    // banner and its own copy, and until T-0293 neither appeared here — so the
    // only way Google ever found one was by following a link from a page it had
    // already crawled. Both are best-effort: a private calendar or a private
    // gallery throws, and a sitemap missing a section beats a 500 that costs us
    // the whole file.
    const [events, gallery] = await Promise.all([this.sitemapEvents(), this.sitemapGallery()]);

    const urls: { loc: string; lastmod?: string; priority: string }[] = [
      // `/home`, not `/`. The router redirects `/` to `/home` and every SPA page
      // and shell declares `/home` canonical, so listing the root would be
      // submitting a URL that immediately points somewhere else.
      { loc: `${site}/home`, priority: '1.0' },
      { loc: `${site}/roster`, priority: '0.9' },
      { loc: `${site}/events`, priority: '0.8' },
      { loc: `${site}/gallery`, priority: '0.7' },
      { loc: `${site}/terms`, priority: '0.2' },
      { loc: `${site}/privacy`, priority: '0.2' },
      { loc: `${site}/guidelines`, priority: '0.2' },
      ...profiles.map((profile) => ({
        loc: `${site}${profile.canonicalPath}`,
        lastmod: profile.updatedAt?.toISOString(),
        priority: '0.6',
      })),
      ...events,
      ...gallery,
    ];

    const body = urls
      .map((url) => {
        const lastmod = url.lastmod ? `\n    <lastmod>${url.lastmod}</lastmod>` : '';
        // `loc` values are built from our own ids and handles, both of which are
        // constrained to `[a-z0-9_]` / base62 — but they are escaped anyway,
        // because "the input is safe" is a property that quietly stops being
        // true, and an unescaped `&` alone makes the whole document invalid XML.
        return `  <url>\n    <loc>${escapeXml(url.loc)}</loc>${lastmod}\n    <priority>${url.priority}</priority>\n  </url>`;
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  }

  /** The generic card, for a URL that resolves to nothing public. */
  async renderFallback(): Promise<string> {
    const regimentName = await this.regimentName();
    return renderPageShell({
      canonicalUrl: `${this.siteUrl()}/home`,
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      title: documentTitle(regimentName, regimentName),
      description: 'Roster, events and gallery for a Holdfast: Nations at War regiment.',
      imageUrl: this.defaultCardImage(),
      sections: [
        {
          heading: 'Regiment',
          links: [
            { href: `${this.siteUrl()}/roster`, label: 'Regimental Roster' },
            { href: `${this.siteUrl()}/events`, label: 'Events' },
            { href: `${this.siteUrl()}/gallery`, label: 'Gallery' },
          ],
        },
      ],
    });
  }

  // ── Sitemap sections ────────────────────────────────────────────────────────

  private async sitemapEvents(): Promise<{ loc: string; priority: string }[]> {
    try {
      const query = new EventQueryDto();
      query.page = 1;
      query.limit = 100;
      const result = await this.events.listPublic(query);
      return result.data.map((event) => ({
        loc: `${this.siteUrl()}/events/${event.id}`,
        priority: '0.5',
      }));
    } catch {
      // A private calendar, or no regiment row yet. Not an error worth failing
      // the whole document over.
      return [];
    }
  }

  private async sitemapGallery(): Promise<{ loc: string; priority: string }[]> {
    try {
      const query = new GalleryQueryDto();
      query.page = 1;
      query.limit = 100;
      const result = await this.galleryItems.findPublic(query);
      return result.data.map((item) => ({
        loc: `${this.siteUrl()}/gallery/${item.id}`,
        priority: '0.4',
      }));
    } catch {
      return [];
    }
  }

  // ── Card images ─────────────────────────────────────────────────────────────

  /**
   * The shipped brand banner, for a page with no image of its own.
   *
   * Without this the roster, an empty calendar and the generic card would all
   * unfurl with `twitter:card: summary` and no picture — technically honest, and
   * indistinguishable from a broken link in a Discord channel. Dimensions are
   * hardcoded because the file is a build asset in this repo's sibling: it
   * cannot change without a deploy, and declaring them is what lets an unfurler
   * size the embed before the fetch lands.
   */
  private defaultCardImage(): ShellImage {
    return {
      url: this.absoluteAsset(DEFAULT_CARD_IMAGE) as string,
      width: DEFAULT_CARD_WIDTH,
      height: DEFAULT_CARD_HEIGHT,
      type: 'image/png',
      alt: 'Lords Regiment',
    };
  }

  /** A page-supplied image, with its type inferred and its alt text attached. */
  private cardImageFor(url: string | null | undefined, alt: string): ShellImage {
    if (!url) return this.defaultCardImage();
    const absolute = this.absoluteAsset(url) as string;
    return { url: absolute, alt, type: imageMimeFor(absolute) };
  }

  /**
   * A profile's card image.
   *
   * The BANNER when the member has set one — it is landscape, so it fills a
   * `summary_large_image` card the way Discord wants. Otherwise the avatar,
   * declared `square` so the card degrades deliberately to the thumbnail
   * layout rather than being demoted into it: Discord inspects the real file
   * and demotes a square image anyway, and a card that asked for the wide
   * layout and did not get it looks broken in a way the thumbnail does not.
   *
   * `bannerUrl` is a fully-qualified object-store URL and `avatarUrl` is a path
   * on THIS origin (the proxy that keeps a member's Discord snowflake out of the
   * markup) — {@link absoluteAsset} is what makes that difference invisible here.
   */
  private profileCardImage(member: PublicMemberDto, name: string): ShellImage {
    if (member.bannerUrl) {
      const url = this.absoluteAsset(member.bannerUrl) as string;
      return { url, alt: name, type: imageMimeFor(url) };
    }
    if (member.avatarUrl) {
      const url = this.absoluteAsset(member.avatarUrl) as string;
      return { url, alt: name, shape: 'square' };
    }
    return this.defaultCardImage();
  }

  /**
   * Absolute, whichever kind of URL this is.
   *
   * Member banners, event banners and gallery files are stored fully-qualified
   * against the object store's public origin; avatars and build assets are
   * paths on this site. Prefixing the first kind produces
   * `https://site https://cdn/...` and prefixing nothing at all leaves an
   * unfurler with a relative URL it will not resolve.
   */
  private absoluteAsset(pathOrUrl: string | null): string | null {
    if (!pathOrUrl) return null;
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.siteUrl()}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  }

  // ── Events copy ─────────────────────────────────────────────────────────────

  /**
   * The calendar's description.
   *
   * Held here as one string because the SPA's `events-page.component.ts` builds
   * the identical sentence from the identical parts — the equivalence rule
   * applies to a list page exactly as it does to a profile.
   */
  private describeEvents(regimentName: string): string {
    return (
      `Line battles, drills and campaign nights run by ${regimentName} — ` +
      'what is running now, what is scheduled next, and what has just been fought.'
    );
  }

  /**
   * One event's description: its own words, collapsed and cut, or a generated
   * line naming the date.
   *
   * The 200-character cut and the `…` are the SPA's rule, character for
   * character. The fallback names the date in the EVENT's timezone rather than
   * the reader's, which is the one thing a server-rendered copy has to do
   * differently from a naive client one — a browser-local date could never
   * match this string, and two descriptions for one URL is the divergence the
   * whole module exists to avoid.
   */
  private describeEvent(event: EventDto, regimentName: string): string {
    const text = (event.description || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return `${event.title} — a ${regimentName} operation on ${this.formatDateIn(event.startsAt, event.timezone)}.`;
    }
    return text.length > EVENT_DESCRIPTION_LIMIT
      ? `${text.slice(0, EVENT_DESCRIPTION_LIMIT - 1).trimEnd()}…`
      : text;
  }

  /** "21 July 2026 at 19:00 GMT+1" — the event's own wall clock, never the reader's. */
  private eventWhen(event: EventDto): string {
    return this.formatDateTime(event.startsAt, event.timezone);
  }

  private eventStatusLabel(event: EventDto): string {
    if (event.status === EventStatus.Upcoming) return 'Scheduled';
    if (event.status === EventStatus.Ongoing) return 'In progress';
    return 'Concluded';
  }

  private eventsUrl(page: number): string {
    return page <= 1 ? `${this.siteUrl()}/events` : `${this.siteUrl()}/events?page=${page}`;
  }

  /**
   * A date+time rendered in the event's OWN zone.
   *
   * ── WHY THE COMPONENTS ARE SPELLED OUT AND NOT `dateStyle`/`timeStyle` ──────
   * Intl throws `TypeError: Invalid option` if either style shorthand is
   * combined with `timeZoneName`, and the zone name is not optional here:
   * without it "20:00" is a claim about a timezone the reader cannot see and
   * will assume is their own. The explicit component list is the only way to
   * ask for both.
   *
   * The zone falls back to UTC when the stored one is not in Node's ICU build,
   * because a `RangeError` here would 500 an entire crawlable page over a
   * formatting detail.
   */
  private formatDateTime(iso: string, timezone: string): string {
    try {
      return this.dateTimeIn(iso, timezone);
    } catch {
      return this.dateTimeIn(iso, 'UTC');
    }
  }

  private dateTimeIn(iso: string, timezone: string): string {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
      timeZoneName: 'short',
    });
  }

  private formatDateIn(iso: string, timezone: string): string {
    try {
      return new Date(iso).toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: timezone,
      });
    } catch {
      return this.formatDate(iso);
    }
  }

  /** The regiment profile, or null — every caller has a sensible default. */
  private async regimentProfile(): Promise<RegimentProfileDto | null> {
    try {
      return (await this.regiments.getProfile()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The display name. The handle is preferred when there is one, because it is
   * what the URL says and what a search for "Holdfast panda" is actually
   * looking for — the in-game name follows it in the facts list either way.
   */
  private displayName(member: PublicMemberDto): string {
    return member.username ? `${member.inGameName} (@${member.username})` : member.inGameName;
  }

  /**
   * The `<meta name="description">` for a profile.
   *
   * ── WHY THE BIO IS DELIBERATELY *NOT* IN HERE (T-0216) ──────────────────────
   * On the merits the bio belongs here: a hand-written sentence outperforms this
   * generated "Rank in Regiment · N decorations · N events attended" line as a
   * search snippet, and truncating it to ~160 characters is trivial. It is left
   * out anyway, and the reason is the equivalence rule at the top of this file.
   *
   * The SPA builds a description for the SAME URL, in its own `describe()` used
   * by `applySeo` in the frontend repo, and Googlebot renders that second pass
   * and compares it with this one. Two different descriptions for one URL is
   * exactly the disagreement that makes dynamic rendering look like cloaking —
   * and the description is worse than the body copy in that respect, because it
   * is a single short string where a diff is unambiguous rather than prose where
   * whitespace differs harmlessly. The shell is the copy served to the crawler,
   * so it is the copy that must not move first.
   *
   * Adopting the bio later is one coupled deploy, not a change here: the
   * frontend's `describe()` has to implement the identical rule first — bio when
   * non-blank, trimmed, cut at the same character boundary with the same
   * ellipsis, falling back to this exact generated string when blank — and only
   * then does this method follow. Anything short of byte-for-byte agreement is
   * worse than keeping the generated line on both sides.
   *
   * The bio still reaches the crawler: it is the first body paragraph in
   * {@link renderProfile}, which is where unique copy actually earns its keep.
   */
  private describeProfile(member: PublicMemberDto, regimentName: string): string {
    const parts = [
      member.rank ? `${member.rank} in ${regimentName}` : `Member of ${regimentName}`,
      member.medals.length === 1 ? '1 decoration' : `${member.medals.length} decorations`,
      `${member.eventsAttended} events attended`,
    ];
    if (member.joinedAt) parts.push(`serving since ${this.formatDate(member.joinedAt)}`);
    return `${parts.join(' · ')}.`;
  }

  private formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  private rosterUrl(page: number): string {
    return page <= 1 ? `${this.siteUrl()}/roster` : `${this.siteUrl()}/roster?page=${page}`;
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
}

/** XML escape — a superset of what HTML needs, for the sitemap document. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
