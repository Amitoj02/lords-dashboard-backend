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
import { renderPageShell, ShellImage, ShellLink, ShellMedia } from './html/page-shell';

/**
 * How many roster rows the crawler shell lists per page.
 *
 * ⚠️ MUST EQUAL `PUBLIC_ROSTER_PAGE_SIZE` in the frontend's
 * `core/services/public-members.service.ts`. This was 50 against the SPA's 25,
 * which meant `/roster?page=2` served members 51–100 to a crawler and 26–50 to
 * Googlebot's render pass — one URL, two different member sets, disagreeing
 * `ItemList` positions and `rel=prev/next`. That is precisely the divergence the
 * equivalence rule at the top of this file exists to forbid, and it was live.
 */
const ROSTER_PAGE_SIZE = 25;

/**
 * The game, named in full wherever a searcher might pair it with a member's
 * handle (T-0297).
 *
 * It lives in the meta DESCRIPTION and the body, deliberately not in every
 * `<title>`: Google rewrites titles it reads as boilerplate, and the same
 * eleven characters repeated across every profile on the site is the textbook
 * case. The description is per-page prose, so the same words there read as
 * context rather than as stuffing.
 */
const GAME_NAME = 'Holdfast: Nations at War';

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
 * Where a member's bio is cut for the meta description (T-0297).
 *
 * 160, not the event's 200. A profile description carries a trailing clause the
 * event's does not — "— Captain in Lords Regiment, a Holdfast: Nations at War
 * regiment." — and the two together have to stay inside the ~300 characters
 * Discord keeps and the ~160 Google typically renders before the snippet is
 * rewritten from the page body. The full bio is still the first body paragraph;
 * this cut only decides what the card and the SERP show.
 *
 * ⚠️ Mirrored by `BIO_SNIPPET_LIMIT` in the frontend's `profile.component.ts`.
 */
const PROFILE_DESCRIPTION_LIMIT = 160;

/**
 * The card image for a page that has nothing of its own to show (T-0293).
 *
 * Site-relative on purpose: it is an asset in the Angular build, served from
 * this origin, and {@link SeoService.siteUrl} makes it absolute. Without a
 * default, the home page and an empty events calendar would unfurl as a bare
 * line of text — `twitter:card` degrades to `summary` when there is no image,
 * and the frontend's `SeoService` applies the identical fallback so the two
 * documents keep agreeing.
 *
 * THE CREST, NOT A SCREENSHOT (T-0302). This was `banner.png`, a frame of
 * Holdfast gameplay. It filled the wide card, but a page with nothing of its own
 * to show is exactly the page whose card has to identify the REGIMENT, and every
 * one of them — the roster, an empty calendar, a member with no avatar — unfurled
 * as the same anonymous battlefield. `social-card.png` is the crest centred on
 * `--ink-900` at 1200x630, the wide card's canonical size, so the LAYOUT is
 * unchanged and only the subject is. It is a composed asset rather than
 * `regiment-logo.png` because the crest is square on its own and Discord demotes
 * a square image to a thumbnail whatever the tag claims; the ink field is what
 * buys the large card.
 *
 * ⚠️ Mirrored by `DEFAULT_IMAGE` in the frontend's `core/services/seo.service.ts`
 * and by the static `og:image` in its `index.html`, and the file itself ships in
 * that repo — so changing this is a coupled deploy in both directions.
 */
const DEFAULT_CARD_IMAGE = '/assets/images/social-card.png';
const DEFAULT_CARD_WIDTH = 1200;
const DEFAULT_CARD_HEIGHT = 630;

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
    const profile = await this.regimentProfile();
    const regimentName = profile?.name?.trim() || 'Lords Regiment';

    const links: ShellLink[] = result.data.map((member) => ({
      href: `${this.siteUrl()}${member.canonicalPath}`,
      label: this.displayName(member),
      meta: [member.rank, member.role].filter(Boolean).join(' · ') || null,
    }));

    const totalPages = Math.max(1, Math.ceil(result.meta.total / ROSTER_PAGE_SIZE));

    return renderPageShell({
      canonicalUrl: this.rosterUrl(safePage),
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      // The regiment's own banner, not the shipped brand asset. Every list page
      // on the site was unfurling with the identical stock picture, so a shared
      // roster and a shared gallery were the same card with different words.
      imageUrl: this.cardImageFor(
        profile?.presentation?.heroBannerUrl || profile?.bannerUrl || null,
        `${regimentName} roster`,
      ),
      oEmbedUrl: this.oEmbedUrl(
        `${result.meta.total} serving members`,
        this.rosterUrl(1),
        regimentName,
      ),
      title: documentTitle(
        safePage === 1 ? 'Regimental Roster' : `Regimental Roster (page ${safePage})`,
        regimentName,
      ),
      description:
        `Every serving member of ${regimentName}, a ${GAME_NAME} regiment — ` +
        `${result.meta.total} members with their rank and decorations.`,
      heading: 'Regimental Roster',
      subheading: `${result.meta.total} serving members`,
      paragraphs: [
        `${regimentName} is a ${GAME_NAME} regiment. Every member below has a ` +
          'public profile listing their rank, their decorations and how long they have served.',
      ],
      labels: [
        { label: 'Members', data: String(result.meta.total) },
        { label: 'Game', data: GAME_NAME },
      ],
      sections: [
        { heading: 'Members', links },
        // ── CRAWLABLE PAGINATION (T-0297) ────────────────────────────────────
        // `rel=prev/next` in the <head> is all this page had, and Google stopped
        // using those as an indexing signal in 2019. The SPA paginates with
        // `<button (click)>`, which is invisible to a crawler. Between them,
        // every member past the first page had NO internal link pointing at
        // their profile from anywhere on the site — discoverable only from the
        // sitemap, which is the weakest signal there is. These are real anchors.
        ...(totalPages > 1
          ? [
              {
                heading: 'Roster pages',
                links: Array.from({ length: totalPages }, (_, index) => ({
                  href: this.rosterUrl(index + 1),
                  label: `Page ${index + 1}`,
                })),
              },
            ]
          : []),
        // The roster was the one shell with no outbound section — a link sink
        // that took equity from every profile and passed none back.
        {
          heading: 'Regiment',
          links: [
            { href: `${this.siteUrl()}/home`, label: regimentName },
            { href: `${this.siteUrl()}/events`, label: 'Events' },
            { href: `${this.siteUrl()}/gallery`, label: 'Gallery' },
          ],
        },
      ],
      prevUrl: result.meta.hasPrev ? this.rosterUrl(safePage - 1) : null,
      nextUrl: result.meta.hasNext ? this.rosterUrl(safePage + 1) : null,
      jsonLd: [
        {
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
        this.breadcrumbs([{ name: 'Regimental Roster', url: this.rosterUrl(1) }]),
      ],
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

    // `Events attended` is deliberately absent (T-0297). It was dropped from the
    // roster table, the profile particulars and the meta description in the same
    // change: a count nobody acted on, which read as "0" for most of the
    // regiment and made every card look like a dead account.
    const facts = [
      { label: 'In-game name', value: dto.inGameName },
      ...(handleLabel ? [{ label: 'Handle', value: handleLabel }] : []),
      ...(dto.rank ? [{ label: 'Rank', value: dto.rank }] : []),
      { label: 'Role', value: dto.role },
      ...(dto.joinedAt ? [{ label: 'Serving since', value: this.formatDate(dto.joinedAt) }] : []),
      { label: 'Decorations', value: String(dto.medals.length) },
    ];

    return renderPageShell({
      canonicalUrl,
      siteName: regimentName,
      themeColor: BRAND_ACCENT,
      ogType: 'profile',
      profileUsername: dto.username,
      // The bold line above the title on a Discord card. Composed here, next to
      // the title and description it has to agree with — see `oembed.controller`
      // for why the endpoint itself resolves nothing.
      oEmbedUrl: this.oEmbedUrl(this.profileAuthorLine(dto), canonicalUrl, regimentName),
      title: documentTitle(name, regimentName),
      description: this.describeProfile(dto, regimentName),
      heading: name,
      subheading: [dto.rank, dto.role].filter(Boolean).join(' · ') || null,
      imageUrl: this.profileCardImage(dto, name),
      // The BANNER goes in the body when there is one, because the card is now
      // always the avatar and the banner would otherwise never be seen by
      // anyone reading this document. Falls back to the avatar so a member with
      // no banner still has a portrait below the heading.
      media: this.profileBodyImage(dto, name),
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
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'ProfilePage',
          url: canonicalUrl,
          // `dateCreated` is the join date, which is what Google's ProfilePage
          // documentation means by it — when the profile's subject came into
          // existence here, not when the row was last touched.
          ...(dto.joinedAt ? { dateCreated: dto.joinedAt } : {}),
          // `dateModified` is deliberately ABSENT (T-0297). It used to be
          // `new Date()`, which asserted on every single crawl that the profile
          // had just been edited — a freshness claim that is false by
          // construction, and a field the SPA never emitted at all, so the two
          // documents for one URL disagreed on it permanently. Omitting it is
          // the only answer available until `PublicMemberDto` carries a real
          // content-modified stamp; a wrong date is worse than no date.
          mainEntity: {
            '@type': 'Person',
            name,
            alternateName: handleLabel ?? dto.inGameName,
            identifier: dto.id,
            url: canonicalUrl,
            mainEntityOfPage: canonicalUrl,
            ...(bio ? { description: bio } : {}),
            ...(dto.avatarUrl ? { image: this.absoluteAsset(dto.avatarUrl) } : {}),
            ...(dto.rank ? { jobTitle: dto.rank } : {}),
            // Carries the `@id` the `/home` shell defines the node under, so
            // Google reads one regiment with N members rather than N unlinked
            // organisations that happen to share a name — plus enough of the
            // node to mean something to a consumer holding only this document.
            memberOf: this.organizationRef(regimentName),
            ...(dto.medals.length ? { award: dto.medals.map((medal) => medal.title) } : {}),
          },
        },
        this.breadcrumbs([
          { name: 'Regimental Roster', url: `${this.siteUrl()}/roster` },
          { name, url: canonicalUrl },
        ]),
      ],
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
    const regimentName = profile?.name?.trim() || 'Lords Regiment';
    const canonicalUrl = `${this.siteUrl()}/home`;
    const mission =
      profile?.missionStatement?.trim() ||
      'Roster, events and gallery for a Holdfast: Nations at War regiment.';

    // The admin-editable hero wins, then the regiment banner, then NULL — which
    // `cardImageFor` turns into the shipped crest card complete with its
    // dimensions. Naming `DEFAULT_CARD_IMAGE` here instead would route it
    // through the same branch as a CDN URL and silently drop the width/height
    // an unfurler lays the card out from.
    //
    // Note the order survives T-0302: an owner who has uploaded a hero in
    // Settings has said what THIS page's card should be, and the crest is the
    // answer for a page nobody has spoken for — not an override of one.
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
      oEmbedUrl: this.oEmbedUrl(
        established ? `A ${GAME_NAME} regiment since ${established}` : `A ${GAME_NAME} regiment`,
        canonicalUrl,
        regimentName,
      ),
      labels: [
        ...(profile?.memberCount ? [{ label: 'Members', data: String(profile.memberCount) }] : []),
        { label: 'Game', data: GAME_NAME },
      ],
      jsonLd: [
        {
          '@context': 'https://schema.org',
          // ── THE CANONICAL ORGANISATION NODE (T-0297) ──────────────────────
          // Every profile's `memberOf` is now a bare `{"@id": …}` pointing here,
          // so this is the ONE place the regiment is described. Before, each
          // profile inlined its own id-less copy and the graph held N unlinked
          // organisations that merely shared a name.
          //
          // `SportsTeam` would be the more precise subtype and is legitimate
          // markup — it buys semantic precision and no SERP feature, and it
          // asserts a "sport" this is not. `Organization` is the honest one.
          '@type': 'Organization',
          '@id': this.organizationId(),
          name: regimentName,
          description: mission,
          url: this.siteUrl(),
          // Absolutised like `image` on the next line. `crestUrl` is stored
          // fully-qualified today, so a relative one has never reached here —
          // which is exactly the kind of thing that stops being true quietly.
          ...(profile?.crestUrl ? { logo: this.absoluteAsset(profile.crestUrl) } : {}),
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
      description: this.describeEvents(regimentName, upcoming),
      heading: 'Events & Orders',
      subheading: `${upcoming.length} scheduled · ${result.meta.total} on the calendar`,
      imageUrl: this.cardImageFor(lead, `${regimentName} events`),
      oEmbedUrl: this.oEmbedUrl(
        upcoming.length === 1 ? '1 muster scheduled' : `${upcoming.length} musters scheduled`,
        this.eventsUrl(1),
        regimentName,
      ),
      labels: [
        { label: 'Scheduled', data: String(upcoming.length) },
        { label: 'On the calendar', data: String(result.meta.total) },
      ],
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
      media: event.bannerUrl
        ? {
            kind: 'image',
            // Absolutised like the card image above. `bannerUrl` happens to be
            // stored fully-qualified today, so the raw value worked — but it
            // worked by coincidence of a decision made in another module.
            url: this.absoluteAsset(event.bannerUrl) as string,
            alt: event.title,
            type: imageMimeFor(this.absoluteAsset(event.bannerUrl) as string),
          }
        : null,
      // The date and the muster state, which is what somebody scanning a channel
      // for "is this tonight" actually needs, above the title.
      oEmbedUrl: this.oEmbedUrl(
        `${this.eventStatusLabel(event)} · ${when}`,
        canonicalUrl,
        regimentName,
      ),
      labels: [
        { label: 'When', data: when },
        { label: 'Status', data: this.eventStatusLabel(event) },
      ],
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
        // ── THE SERVER BINDING, NOW PUBLIC (T-0298) ──────────────────────────
        // The name and region are how somebody actually turns up. They were
        // member-only, so the page that exists to advertise a muster to people
        // who are not in the regiment yet withheld the one detail that lets them
        // come. The PASSWORD is still not here and never will be: it is not on
        // `EventDto` on any branch, and reaching it needs a session, the
        // capability and a live RSVP.
        ...(event.serverName ? [{ label: 'Server', value: event.serverName }] : []),
        ...(event.serverRegion ? [{ label: 'Region', value: event.serverRegion }] : []),
        ...(event.hasServerPassword ? [{ label: 'Server password', value: 'Members only' }] : []),
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
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Event',
          name: event.title,
          url: canonicalUrl,
          // The absolute instants, never a rendered wall clock: `startsAt` is the
          // real moment, and `timezone` is only how to display it.
          startDate: event.startsAt,
          ...(event.endsAt ? { endDate: event.endsAt } : {}),
          // `EventScheduled` on a concluded event is CORRECT, not a bug, and it
          // reads like one often enough to be worth writing down. schema.org's
          // enum is {Scheduled, Cancelled, MovedOnline, Postponed, Rescheduled}
          // — there is no "already happened" member, because that is what a past
          // `endDate` says. An event the regiment fought as planned was, and
          // remains, scheduled.
          eventStatus: 'https://schema.org/EventScheduled',
          eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
          // A game server, so the location is virtual. It is named now that the
          // binding is public (T-0298); the page remains the URL, because the
          // server name is not something a client can navigate to.
          location: {
            '@type': 'VirtualLocation',
            url: canonicalUrl,
            ...(event.serverName ? { name: event.serverName } : {}),
          },
          organizer: this.organizationRef(regimentName),
          ...(event.description?.trim() ? { description: event.description.trim() } : {}),
          ...(event.bannerUrl ? { image: this.absoluteAsset(event.bannerUrl) } : {}),
        },
        this.breadcrumbs([
          { name: 'Events & Orders', url: this.eventsUrl(1) },
          { name: event.title, url: canonicalUrl },
        ]),
      ],
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

    // ── NO `<priority>`, NO `<changefreq>` (T-0297) ──────────────────────────
    // Google's sitemap documentation states outright that it ignores both. They
    // were here as a plausible-looking hint that had no reader, and a document
    // full of fields nothing consumes is a document nobody audits. `lastmod` is
    // the one field Google does use — and only when it can verify the claim
    // against what actually changed, so an inaccurate one costs the signal for
    // every URL in the file, not just the URL that lied.
    const urls: { loc: string; lastmod?: string }[] = [
      // `/home`, not `/`. The router redirects `/` to `/home` and every SPA page
      // and shell declares `/home` canonical, so listing the root would be
      // submitting a URL that immediately points somewhere else.
      { loc: `${site}/home` },
      { loc: `${site}/roster` },
      { loc: `${site}/events` },
      { loc: `${site}/gallery` },
      { loc: `${site}/terms` },
      { loc: `${site}/privacy` },
      { loc: `${site}/guidelines` },
      ...profiles.map((profile) => ({
        loc: `${site}${profile.canonicalPath}`,
        lastmod: profile.updatedAt?.toISOString(),
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
        return `  <url>\n    <loc>${escapeXml(url.loc)}</loc>${lastmod}\n  </url>`;
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

  private async sitemapEvents(): Promise<{ loc: string; lastmod?: string }[]> {
    try {
      const query = new EventQueryDto();
      query.page = 1;
      query.limit = 100;
      const result = await this.events.listPublic(query);
      return result.data.map((event) => ({
        loc: `${this.siteUrl()}/events/${event.id}`,
        // `updatedAt` is a member-projection field, so it is undefined on the
        // public DTO and `lastmod` is simply omitted rather than faked from the
        // start date — which would claim a page changed on the day the muster
        // ran, and be wrong for every event ever edited afterwards.
        ...(event.updatedAt ? { lastmod: event.updatedAt } : {}),
      }));
    } catch {
      // A private calendar, or no regiment row yet. Not an error worth failing
      // the whole document over.
      return [];
    }
  }

  private async sitemapGallery(): Promise<{ loc: string; lastmod?: string }[]> {
    try {
      const query = new GalleryQueryDto();
      query.page = 1;
      query.limit = 100;
      const result = await this.galleryItems.findPublic(query);
      return result.data.map((item) => ({
        loc: `${this.siteUrl()}/gallery/${item.id}`,
        ...(item.updatedAt ? { lastmod: item.updatedAt } : {}),
      }));
    } catch {
      return [];
    }
  }

  // ── Card images ─────────────────────────────────────────────────────────────

  /**
   * The shipped crest card, for a page with no image of its own.
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
   * A profile's card image: the AVATAR, always, when the member has one.
   *
   * ── WHY THE FACE AND NOT THE BANNER (T-0297) ────────────────────────────────
   * This used to prefer the banner, because a landscape image fills the wide
   * `summary_large_image` card and a square one does not. That optimised the
   * card's size at the cost of what it is a card ABOUT: half the roster shared
   * their profile and got a picture of a battlefield with a name under it,
   * indistinguishable from the event page they shared an hour earlier.
   *
   * An avatar is square, so this declares `shape: 'square'` and the shell picks
   * `twitter:card: summary` — the small portrait beside the text. That is a
   * deliberate downgrade in size and an upgrade in meaning, and it is the layout
   * every other site on the internet uses for a person. Declaring it is also the
   * only way to get it cleanly: Discord inspects the real file and demotes a
   * square image regardless, so a page that asked for the wide card and lost
   * renders as something broken rather than as something small.
   *
   * The banner is not wasted — {@link profileBodyImage} renders it in the body.
   *
   * `bannerUrl` is a fully-qualified object-store URL and `avatarUrl` is a path
   * on THIS origin (the proxy that keeps a member's Discord snowflake out of the
   * markup) — {@link absoluteAsset} is what makes that difference invisible here.
   */
  private profileCardImage(member: PublicMemberDto, name: string): ShellImage {
    if (member.avatarUrl) {
      const url = this.absoluteAsset(member.avatarUrl) as string;
      // No `type`: the avatar proxy URL is extensionless, and `imageMimeFor`
      // returning null is the honest answer. Dimensions are likewise unknown —
      // the proxy re-serves whatever Discord or the uploader gave us — and a
      // guessed pair is worse than none, because an unfurler reserves the space
      // it was told about.
      return { url, alt: name, shape: 'square' };
    }
    if (member.bannerUrl) {
      const url = this.absoluteAsset(member.bannerUrl) as string;
      return { url, alt: name, type: imageMimeFor(url) };
    }
    return this.defaultCardImage();
  }

  /**
   * The portrait rendered into the BODY of a profile shell.
   *
   * The banner when there is one, because the card is the avatar now and this is
   * the only place the banner would otherwise appear to a reader or to
   * Googlebot's rendered pass. The avatar when there is not, so the page is
   * never text-only.
   */
  private profileBodyImage(member: PublicMemberDto, name: string): ShellMedia | null {
    const url = member.bannerUrl ?? member.avatarUrl;
    if (!url) return null;
    const absolute = this.absoluteAsset(url) as string;
    return { kind: 'image', url: absolute, alt: name, type: imageMimeFor(absolute) };
  }

  // ── Shared JSON-LD nodes ────────────────────────────────────────────────────

  /**
   * The one stable identifier for the regiment as an entity.
   *
   * A fragment id on the site root, which is the convention Google's own
   * Organization guidance uses. `/home` defines the node; every other shell
   * references it. Without this each profile carried its own inline
   * `Organization` blob with no id, so the graph held one unlinked organisation
   * per member instead of one organisation with members.
   */
  private organizationId(): string {
    return `${this.siteUrl()}/#organization`;
  }

  /**
   * How a profile or an event names the regiment.
   *
   * ── WHY THIS IS NOT A BARE `{"@id": …}` ─────────────────────────────────────
   * The `@id` is what merges these into ONE entity rather than N organisations
   * that happen to share a name — that is the whole point of it. But JSON-LD
   * `@id` references resolve within a document's own graph, and the node this id
   * names is defined in a DIFFERENT document (`/home`). A consumer parsing one
   * profile in isolation would find an identifier with nothing behind it, which
   * is strictly worse than the inline copy this replaced.
   *
   * So: the id AND enough of the node to stand alone. A consumer that fetches
   * `/home` merges them on the id; one that never does still learns the
   * regiment's name and URL from the profile it is holding.
   */
  private organizationRef(regimentName: string): Record<string, string> {
    return {
      '@type': 'Organization',
      '@id': this.organizationId(),
      name: regimentName,
      url: this.siteUrl(),
    };
  }

  /**
   * `BreadcrumbList` for a page below the top level.
   *
   * Google renders it as the navigable trail in place of the raw URL line in a
   * result, which on a URL like `/u/@panda` is the difference between a path
   * fragment and "Lords Regiment › Regimental Roster › Panda". The home page is
   * prepended here so no call site has to remember it.
   */
  private breadcrumbs(trail: { name: string; url: string }[]): unknown {
    const items = [{ name: 'Home', url: `${this.siteUrl()}/home` }, ...trail];
    return {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: item.url,
      })),
    };
  }

  /**
   * The `<link rel="alternate" type="application/json+oembed">` target for a
   * page, with its author and provider lines baked into the query.
   *
   * Stateless by design — the endpoint echoes these strings rather than
   * resolving anything. See `oembed.controller.ts` for why that is the point
   * rather than a shortcut.
   */
  private oEmbedUrl(author: string, authorUrl: string, providerName: string): string {
    const query = new URLSearchParams({
      author,
      author_url: authorUrl,
      provider: providerName,
      provider_url: this.siteUrl(),
    });
    // The prefix is read rather than written as a literal `/api`: it is
    // configurable, and a wrong path here does not fail loudly — Discord simply
    // drops the oEmbed response and the author line silently never appears.
    const prefix = this.config.get('apiPrefix', { infer: true });
    return `${this.siteUrl()}/${prefix}/oembed?${query.toString()}`;
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
   * The calendar's description — which muster is next, by name and date.
   *
   * ── WHY THIS IS NOT A CONSTANT ANY MORE (T-0297) ────────────────────────────
   * It was one frozen sentence, so a link to the calendar unfurled with the same
   * words in January and in June. The whole reason somebody pastes `/events` in
   * a channel is to say "look what is coming up", and the card answered a
   * different question. Naming the next event and its date is the single change
   * that makes this a live document instead of a slogan.
   *
   * The date is rendered in the EVENT's timezone, exactly as `describeEvent`
   * does, because a browser-local date could never match a server-rendered one
   * and the two surfaces have to agree on one string.
   *
   * Held here rather than inline because the SPA's `events-page.component.ts`
   * builds the identical sentence from the identical parts — the equivalence
   * rule applies to a list page exactly as it does to a profile.
   */
  private describeEvents(regimentName: string, upcoming: EventDto[]): string {
    const lead = upcoming[0];
    const next = lead
      ? ` Next up: ${lead.title} on ${this.formatDateIn(lead.startsAt, lead.timezone)}.`
      : '';
    return (
      `Line battles, drills and campaign nights run by ${regimentName}, a ${GAME_NAME} ` +
      `regiment — what is running now, what is scheduled next, and what has just been fought.${next}`
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
   * The `<meta name="description">` for a profile — the member's own words when
   * they wrote any (T-0297).
   *
   * ── THE RULE, WHICH THE SPA IMPLEMENTS CHARACTER FOR CHARACTER ──────────────
   * Bio when non-blank: whitespace-collapsed, trimmed, cut at
   * {@link PROFILE_DESCRIPTION_LIMIT} with a `…`, and suffixed with the rank and
   * regiment so the snippet still says who this is. Otherwise the generated
   * line. `describe()` in the frontend's `profile.component.ts` builds the
   * identical string from the identical parts, because Googlebot renders that
   * second pass and compares it with this one — two different descriptions for
   * one URL is the unambiguous, single-string diff that makes dynamic rendering
   * look like cloaking. If either side of this moves, both move in one deploy.
   *
   * ── WHAT CHANGED, AND WHY IT WAS WORTH A COUPLED DEPLOY ─────────────────────
   * This used to be the generated line unconditionally, with the bio confined to
   * the body — sound, and it made every card on the site read
   * "<Rank> in <Regiment> · N decorations · 0 events attended". A hand-written
   * sentence that exists on no other URL on the internet is both the better
   * search snippet AND the difference between a Discord embed that says
   * something and one that recites a schema. The attendance count is gone from
   * both surfaces entirely (T-0297): it was a number nobody acted on, and "0
   * events attended" made every member look inactive in a channel.
   *
   * The game is named here because this is where it can be: a searcher pairing
   * "Holdfast" with a handle needs the two terms to co-occur in a weighted
   * field, and the description is per-page prose rather than the repeated
   * boilerplate a `<title>` would become.
   */
  private describeProfile(member: PublicMemberDto, regimentName: string): string {
    const standing = member.rank
      ? `${member.rank} in ${regimentName}`
      : `Member of ${regimentName}`;

    const bio = (member.bio || '').replace(/\s+/g, ' ').trim();
    if (bio) {
      return `${cutForSnippet(bio, PROFILE_DESCRIPTION_LIMIT)} — ${standing}, a ${GAME_NAME} regiment.`;
    }

    const parts = [
      standing,
      member.medals.length === 1 ? '1 decoration' : `${member.medals.length} decorations`,
    ];
    if (member.joinedAt) parts.push(`serving since ${this.formatDate(member.joinedAt)}`);
    return `${parts.join(' · ')}. A ${GAME_NAME} regiment.`;
  }

  /**
   * The oEmbed author line for a member — the bold line ABOVE the title on a
   * Discord card (T-0297).
   *
   * Rank and decorations, because those are the two facts that make a roster
   * entry a person with standing rather than a row. They are also exactly what
   * the Slack `twitter:labelN` pair carries, so the two platforms say the same
   * thing in the two different shapes they each provide for it.
   */
  private profileAuthorLine(member: PublicMemberDto): string {
    const decorations =
      member.medals.length === 1 ? '1 decoration' : `${member.medals.length} decorations`;
    return member.rank ? `${member.rank} · ${decorations}` : decorations;
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
      return profile?.name?.trim() || 'Lords Regiment';
    } catch {
      return 'Lords Regiment';
    }
  }

  private siteUrl(): string {
    return (this.config.get('frontend', { infer: true }).url ?? '').replace(/\/$/, '');
  }
}

/**
 * Cut a string to `limit` characters for a meta description, appending `…`.
 *
 * ── WHY THIS IS NOT `slice` (T-0297) ────────────────────────────────────────
 * `String.slice` cuts on UTF-16 CODE UNITS, and an emoji is two of them. A bio
 * whose 159th and 160th units are the halves of one astral character therefore
 * left a LONE HIGH SURROGATE at the end of the string — which serialises as
 * U+FFFD, so the card read "…the left flank holds �…". Member bios are exactly
 * the field that contains emoji.
 *
 * Spreading into an array iterates by code point, so a surrogate pair is one
 * element and can never be split. `trimEnd` after the cut, so a bio broken at a
 * space does not leave one dangling before the ellipsis.
 *
 * ⚠️ Mirrored by `cutForSnippet` in the frontend's `profile.component.ts`. Both
 * surfaces build the same description for the same URL, so a fix on one side
 * alone would REINTRODUCE the divergence rather than fix anything.
 */
export function cutForSnippet(value: string, limit: number): string {
  const points = [...value];
  if (points.length <= limit) return value;
  return `${points
    .slice(0, limit - 1)
    .join('')
    .trimEnd()}…`;
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
