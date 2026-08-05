import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { PublicMemberDto } from '../members/dto/public-member.dto';
import { PublicMemberQueryDto } from '../members/public/public-member-query.dto';
import { PublicMembersService } from '../members/public/public-members.service';
import { RegimentsService } from '../regiments/regiments.service';
import { renderPageShell, ShellLink } from './html/page-shell';

/** How many roster rows the crawler shell lists per page. */
const ROSTER_PAGE_SIZE = 50;

/**
 * Renders the public pages as crawlable HTML (T-0215).
 *
 * ── THE EQUIVALENCE RULE ────────────────────────────────────────────────────
 * Every method here answers from {@link PublicMembersService} — the same
 * service, the same exclusion predicate and the same DTO the SPA's own fetch
 * uses. That is not tidiness, it is the thing that keeps this out of cloaking
 * territory: a crawler and a human are looking at one source of truth rendered
 * twice, so they cannot disagree about who is on the roster or what a profile
 * says. If the predicate ever changes, both surfaces change together.
 */
@Injectable()
export class SeoService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly members: PublicMembersService,
    private readonly regiments: RegimentsService,
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
      title:
        safePage === 1
          ? `Regimental Roster — ${regimentName}`
          : `Regimental Roster (page ${safePage}) — ${regimentName}`,
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
      ogType: 'profile',
      title: `${name} — ${regimentName}`,
      description: this.describeProfile(dto, regimentName),
      heading: name,
      subheading: [dto.rank, dto.role].filter(Boolean).join(' · ') || null,
      imageUrl: dto.avatarUrl ? `${this.siteUrl()}${dto.avatarUrl}` : null,
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
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        url: canonicalUrl,
        dateModified: new Date().toISOString(),
        mainEntity: {
          '@type': 'Person',
          name,
          alternateName: handleLabel ?? dto.inGameName,
          identifier: dto.id,
          url: canonicalUrl,
          ...(dto.avatarUrl ? { image: `${this.siteUrl()}${dto.avatarUrl}` } : {}),
          ...(dto.rank ? { jobTitle: dto.rank } : {}),
          memberOf: { '@type': 'Organization', name: regimentName, url: this.siteUrl() },
          ...(dto.medals.length ? { award: dto.medals.map((medal) => medal.title) } : {}),
        },
      },
    });
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

    const urls: { loc: string; lastmod?: string; priority: string }[] = [
      { loc: `${site}/`, priority: '1.0' },
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
      canonicalUrl: this.siteUrl(),
      siteName: regimentName,
      title: regimentName,
      description: 'Roster, events and gallery for a Holdfast: Nations at War regiment.',
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
