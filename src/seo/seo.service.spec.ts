import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { MemberRole } from '../common/enums';
import { EventDto } from '../events/dto/event.dto';
import { EventsService } from '../events/events.service';
import { GalleryService } from '../gallery/gallery.service';
import { GalleryShareService } from '../gallery/share/gallery-share.service';
import { PublicMemberDto } from '../members/dto/public-member.dto';
import { PublicMembersService } from '../members/public/public-members.service';
import { socialProfileUrl } from '../members/social-platforms';
import { RegimentsService } from '../regiments/regiments.service';
import { SeoService } from './seo.service';

const SITE = 'https://lordsofholdfast.com';

/**
 * The crawler shell for a member profile, for the two things a member now
 * authors on it: a bio and a set of social links (T-0216).
 *
 * ── WHAT THESE TESTS ARE ACTUALLY DEFENDING ─────────────────────────────────
 * Two properties, and both of them fail silently rather than loudly:
 *
 *  1. EQUIVALENCE. The SPA renders the bio as a paragraph under the name and
 *     the links as a row of chips. Googlebot renders that second pass and diffs
 *     it against this document. A field present on one surface and missing on
 *     the other is not a cosmetic bug — it is the shape of cloaking, and the
 *     penalty is a manual action rather than a stack trace.
 *  2. CONTAINMENT. Both values are member-authored and land in HTML served from
 *     the apex domain. The bio must be escaped; the link href must be provably
 *     unable to leave the seven origins the social-platform registry allows,
 *     whatever a member types into a handle field.
 */
describe('SeoService — member-authored content on the profile shell (T-0216)', () => {
  let service: SeoService;
  const members = { findByHandle: jest.fn(), list: jest.fn(), listForSitemap: jest.fn() };
  const regiments = { getProfile: jest.fn() };
  // The three collaborators the widened module took on (T-0293). None of them is
  // touched by a profile render, so they are here purely to satisfy the
  // injector — a spec that stubbed them with behaviour would be asserting
  // something this file does not test.
  const events = { listPublic: jest.fn(), getPublic: jest.fn() };
  const galleryShare = { renderItem: jest.fn(), renderIndex: jest.fn(), renderFallback: jest.fn() };
  const gallery = { findPublic: jest.fn() };

  /**
   * A public profile, built as a literal rather than through
   * `PublicMemberDto.from(...)` so this file stays a test of the SHELL — the DTO
   * has its own spec, including the exact-key allowlist that decides what is
   * publishable at all. It is deliberately NOT cast: the literal is checked
   * against the real DTO, so a field added or renamed there fails here rather
   * than quietly rendering nothing.
   */
  const profile = (overrides: Partial<PublicMemberDto> = {}): PublicMemberDto => ({
    id: 'abc123XYZ456',
    username: 'panda',
    inGameName: 'Amitoj',
    role: MemberRole.Member,
    rank: 'Colonel',
    rankImageUrl: null,
    rankPrecedence: 1,
    avatarUrl: null,
    bannerUrl: null,
    bio: null,
    joinedAt: '2026-01-05T00:00:00.000Z',
    eventsAttended: 42,
    medals: [],
    socialLinks: [],
    canonicalPath: '/u/@panda',
    ...overrides,
  });

  /**
   * A public event projection. `as EventDto` because `listPublic`/`getPublic`
   * leave every member-only field undefined, so a structurally complete literal
   * would assert a shape the shell never actually receives.
   */
  const eventDto = (overrides: Record<string, unknown> = {}): EventDto =>
    ({
      id: 'ccc333DDD444',
      title: 'Drill night',
      description: 'Formation drill.',
      bannerUrl: null,
      startsAt: '2026-09-12T19:00:00.000Z',
      endsAt: null,
      timezone: 'UTC',
      status: 'upcoming',
      isRecurring: false,
      outcome: null,
      twitchUrl: null,
      platforms: [],
      tags: [],
      hasServerName: false,
      hasServerPassword: false,
      // Public since T-0298 — always projected, null when nothing is bound.
      serverName: null,
      serverRegion: null,
      ...overrides,
    }) as EventDto;

  const link = (platform: string, label: string, handle: string) => ({
    platform,
    label,
    handle,
    // Built exactly the way the DTO builds it — from the registry, server-side.
    url: socialProfileUrl(platform, handle),
  });

  const render = async (dto: PublicMemberDto): Promise<string> => {
    members.findByHandle.mockResolvedValue({ dto, member: {} });
    return service.renderProfile('@panda');
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    regiments.getProfile.mockResolvedValue({ name: 'Lords Regiment' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeoService,
        { provide: PublicMembersService, useValue: members },
        { provide: RegimentsService, useValue: regiments },
        { provide: EventsService, useValue: events },
        { provide: GalleryShareService, useValue: galleryShare },
        { provide: GalleryService, useValue: gallery },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => (key === 'frontend' ? { url: SITE } : 'api')) },
        },
      ],
    }).compile();
    service = module.get(SeoService);
  });

  describe('the bio', () => {
    it('renders as real body copy — the answer to the thin-doorway-page problem', async () => {
      const html = await render(
        profile({ bio: 'Line infantry since the 2024 season. I mostly play the drum.' }),
      );

      expect(html).toContain('<p>Line infantry since the 2024 season. I mostly play the drum.</p>');
      // …and it leads, because that is where the SPA puts it: directly under the
      // name, above the generated sentence.
      expect(html.indexOf('Line infantry')).toBeLessThan(html.indexOf('serves with'));
    });

    it('is ESCAPED — a bio is member-authored HTML on the apex domain', async () => {
      const html = await render(
        profile({ bio: '"><script>alert(1)</script> tea & biscuits <b>bold</b>' }),
      );

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<b>bold</b>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('tea &amp; biscuits');
    });

    it('leaves no empty paragraph behind when there is no bio', async () => {
      const withBio = await render(profile({ bio: 'A sentence.' }));
      const without = await render(profile({ bio: null }));

      expect(without).not.toContain('<p></p>');
      // One paragraph fewer, not one empty one: the generated sentence and the
      // footer link are the whole of a bio-less profile's prose.
      expect(count(without, '<p>')).toBe(count(withBio, '<p>') - 1);
    });

    it('treats a whitespace-only bio as no bio', async () => {
      const html = await render(profile({ bio: '   \n  ' }));

      expect(html).not.toContain('<p></p>');
      expect(count(html, '<p>')).toBe(count(await render(profile({ bio: null })), '<p>'));
    });
  });

  describe('the social links', () => {
    it('render as nofollow ugc anchors on the SERVER-BUILT url', async () => {
      const html = await render(
        profile({
          socialLinks: [
            link('twitch', 'Twitch', 'panda_HD'),
            link('steam', 'Steam', '76561198000000000'),
          ],
        }),
      );

      expect(html).toContain('<h2>Elsewhere</h2>');
      expect(html).toContain(
        '<a href="https://www.twitch.tv/panda_HD" rel="nofollow ugc">Twitch — panda_HD</a>',
      );
      // The steamID64 branch: a 17-digit handle is a /profiles/ URL, not /id/.
      expect(html).toContain(
        '<a href="https://steamcommunity.com/profiles/76561198000000000" rel="nofollow ugc">' +
          'Steam — 76561198000000000</a>',
      );
    });

    it('renders NO Elsewhere section for a member with none', async () => {
      const html = await render(profile({ socialLinks: [] }));

      expect(html).not.toContain('Elsewhere');
      // And no bare heading either — the shell drops an empty section whole.
      expect(html).toContain('<h2>Regiment</h2>');
    });

    it('cannot be made to emit an href off the registry origins, whatever the handle', async () => {
      // A handle like this never passes validation, so it cannot be stored —
      // this asserts the second line of defence: even if one reached the
      // builder, the URL is composed from a HARDCODED origin and the handle is
      // percent-encoded into a single path segment, so the emitted href stays
      // on twitch.tv and cannot break out of the attribute either.
      const hostile = '"><script>alert(1)</script>';
      const html = await render(profile({ socialLinks: [link('twitch', 'Twitch', hostile)] }));

      const hrefs = [...html.matchAll(/<a href="([^"]*)"/g)].map((match) => match[1]);
      const elsewhere = hrefs.filter((href) => !href.startsWith(SITE));

      expect(elsewhere).toHaveLength(1);
      expect(new URL(unescapeHtml(elsewhere[0])).origin).toBe('https://www.twitch.tv');
      expect(html).not.toContain('<script>alert(1)</script>');
    });
  });

  describe('the meta description', () => {
    it('leads with the bio, then says who this is (T-0297)', async () => {
      // The frontend's `describe()` builds this identical string in the same
      // deploy. One URL with two different descriptions across the two rendering
      // passes is the disagreement that reads as cloaking, and a description is
      // the worst place for it: a single short string where a diff is
      // unambiguous.
      const html = await render(profile({ bio: 'I mostly play the drum.' }));

      expect(html).toContain(
        '<meta name="description" content="I mostly play the drum. — Colonel in ' +
          'Lords Regiment, a Holdfast: Nations at War regiment." />',
      );
    });

    it('falls back to rank and decorations when the member wrote no bio', async () => {
      const html = await render(profile({ bio: null }));

      expect(html).toContain(
        '<meta name="description" content="Colonel in Lords Regiment · 0 decorations · ' +
          'serving since 5 January 2026. A Holdfast: Nations at War regiment." />',
      );
    });

    it('never mentions attendance, on either branch (T-0297)', async () => {
      // The count came out of the roster table, the profile particulars and both
      // descriptions together. "0 events attended" made every member of a
      // regiment that does not track attendance look like a dead account, in the
      // one string a Discord card is guaranteed to show.
      const withBio = await render(profile({ bio: 'Drummer.' }));
      const without = await render(profile({ bio: null }));

      expect(withBio).not.toContain('events attended');
      expect(without).not.toContain('events attended');
      expect(without).not.toContain('Events attended');
    });

    it('cuts a long bio at the shared limit rather than letting it run', async () => {
      const html = await render(profile({ bio: 'x'.repeat(400) }));

      expect(html).toContain(`<meta name="description" content="${'x'.repeat(159)}… — Colonel`);
    });

    it('never splits an emoji in half at the cut (T-0297)', async () => {
      // `String.slice` cuts on UTF-16 CODE UNITS and an emoji is two of them, so
      // a bio whose 159th and 160th units are the halves of one astral character
      // left a LONE HIGH SURROGATE before the `…` — U+FFFD once serialised, so
      // the card read "…holds �…". A bio is exactly the field people put emoji
      // in. `cutForSnippet` iterates by code point, so a pair cannot split.
      const bio = `${'x'.repeat(158)}🎺${'y'.repeat(50)}`;
      const html = await render(profile({ bio }));

      const match = html.match(/<meta name="description" content="([^"]*)"/);
      expect(match).not.toBeNull();
      const description = match![1];
      // No unpaired surrogate anywhere in the emitted string.
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(description),
      ).toBe(false);
      expect(description).not.toContain('�');
      // 159 code points of content, then the ellipsis. The trumpet is the 159th
      // and survives INTACT — the old `slice` kept only its high surrogate.
      expect(description.startsWith(`${'x'.repeat(158)}🎺…`)).toBe(true);
      expect([...description.split(' — ')[0]]).toHaveLength(160);
    });
  });

  /**
   * T-0293. The card a member's profile turns into when it is pasted somewhere.
   *
   * The image choice is the whole of it: Discord inspects the real file, so a
   * square avatar asked to fill a wide card is demoted to a thumbnail anyway
   * and the result reads as broken. Declaring the layout the asset can actually
   * fill is the difference between a deliberate card and a failed one.
   */
  describe('the profile card', () => {
    it('uses the AVATAR and asks for the small card, even when a banner exists (T-0297)', async () => {
      // The banner used to win here, because a landscape image fills the wide
      // card. That optimised the card's SIZE at the cost of what it is about:
      // half the roster shared their profile and got a picture of a battlefield.
      const html = await render(
        profile({
          avatarUrl: '/api/public/members/abc123XYZ456/avatar',
          bannerUrl: 'https://cdn.example/banner.png',
        }),
      );

      // The avatar is a path on THIS origin (the proxy that keeps a member's
      // Discord snowflake out of the markup), so it has to be made absolute —
      // an unfurler will not resolve a relative one.
      expect(html).toContain(
        `<meta property="og:image" content="${SITE}/api/public/members/abc123XYZ456/avatar" />`,
      );
      // `summary` is DECLARED, not suffered: Discord inspects the real file and
      // demotes a square image regardless, so a page that asked for the wide
      // card and lost renders as broken rather than as small.
      expect(html).toContain('<meta name="twitter:card" content="summary" />');
    });

    it('renders the banner in the BODY, so it is not simply discarded', async () => {
      const html = await render(
        profile({
          avatarUrl: '/api/public/members/abc123XYZ456/avatar',
          bannerUrl: 'https://cdn.example/banner.png',
        }),
      );

      expect(html).toContain('<img src="https://cdn.example/banner.png"');
    });

    it('falls back to the banner as the card when the member has no avatar', async () => {
      const html = await render(
        profile({ avatarUrl: null, bannerUrl: 'https://cdn.example/b.png' }),
      );

      expect(html).toContain('<meta property="og:image" content="https://cdn.example/b.png" />');
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    });

    it('still shows the site banner for a member with neither', async () => {
      const html = await render(profile({ avatarUrl: null, bannerUrl: null }));

      expect(html).toContain(
        `<meta property="og:image" content="${SITE}/assets/images/banner.png" />`,
      );
    });

    it('declares the handle as profile:username on the profile vertical (T-0297)', async () => {
      const html = await render(profile());

      // `og:type: profile` has been claimed since T-0293 with none of the
      // vertical's own properties populated. This is the machine-readable
      // statement tying the page to the string a person types into a search box.
      expect(html).toContain('<meta property="og:type" content="profile" />');
      expect(html).toContain('<meta property="profile:username" content="panda" />');
    });

    it('points at an oEmbed endpoint carrying the rank as the author line (T-0297)', async () => {
      // The bold line ABOVE the title on a Discord card. No Open Graph tag
      // produces it — oEmbed `author_name` is the only source — and discovery is
      // via this <link> only: Discord does not honour the `Link:` header form.
      const html = await render(profile({ rank: 'Colonel' }));

      const match = html.match(
        /<link rel="alternate" type="application\/json\+oembed" href="([^"]+)"/,
      );
      expect(match).not.toBeNull();
      const href = new URL(unescapeHtml(match![1]));
      expect(href.pathname).toBe('/api/oembed');
      expect(href.searchParams.get('author')).toBe('Colonel · 0 decorations');
      expect(href.searchParams.get('author_url')).toBe(`${SITE}/u/@panda`);
      expect(href.searchParams.get('provider')).toBe('Lords Regiment');
    });

    it('paints the Discord embed stripe and titles itself the way the SPA does', async () => {
      const html = await render(profile());

      expect(html).toContain('<meta name="theme-color" content="#c69a45" />');
      // `|`, not an em dash: `SeoService.apply()` in the SPA builds the same
      // string, and two titles for one URL is the divergence to avoid.
      expect(html).toContain('<title>Amitoj (@panda) | Lords Regiment</title>');
    });
  });

  /**
   * T-0293. The pages that had no shell at all until now — which is to say, the
   * pages a regiment actually shares.
   */
  describe('the pages added in T-0293', () => {
    it('renders the landing page from the LIVE regiment profile', async () => {
      regiments.getProfile.mockResolvedValue({
        name: 'The Lords',
        missionStatement: 'Discipline, honour, and the line.',
        crestUrl: 'https://cdn.example/crest.png',
        bannerUrl: null,
        establishedYear: 2023,
        memberCount: 48,
        discordInviteUrl: 'https://discord.gg/abc',
        presentation: { heroBannerUrl: 'https://cdn.example/hero.png' },
      });

      const html = await service.renderHome();
      const ld = jsonLdAll(html);

      expect(html).toContain('<title>The Lords</title>');
      expect(html).toContain(
        '<meta name="description" content="Discipline, honour, and the line." />',
      );
      // `/home`, not `/`: the router redirects the root there, so that is the
      // URL both surfaces declare canonical.
      expect(html).toContain(`<link rel="canonical" href="${SITE}/home" />`);
      expect(html).toContain('<meta property="og:image" content="https://cdn.example/hero.png" />');
      expect(html).toContain('<dt>Members</dt><dd>48</dd>');
      expect(ld[0]['@type']).toBe('Organization');
      expect(ld[0].logo).toBe('https://cdn.example/crest.png');
      // The regiment's OWN published account — unlike a member's social handle,
      // which nothing verifies and which therefore never becomes a sameAs.
      expect(ld[0].sameAs).toEqual(['https://discord.gg/abc']);
    });

    it('survives a regiment row that does not exist yet', async () => {
      regiments.getProfile.mockRejectedValue(new Error('no regiment'));

      const html = await service.renderHome();

      expect(html).toContain('<title>Lords Regiment</title>');
      expect(html).toContain(
        `<meta property="og:image" content="${SITE}/assets/images/banner.png" />`,
      );
    });

    it('gives the calendar the NEXT event’s banner as its card', async () => {
      events.listPublic.mockResolvedValue({
        data: [
          eventDto({ id: 'aaa111BBB222', status: 'previous', bannerUrl: 'https://cdn/old.png' }),
          eventDto({ id: 'ccc333DDD444', status: 'upcoming', bannerUrl: 'https://cdn/next.png' }),
        ],
        meta: { page: 1, limit: 50, total: 2, totalPages: 1, hasNext: false, hasPrev: false },
      });

      const html = await service.renderEvents(1);

      expect(html).toContain('<meta property="og:image" content="https://cdn/next.png" />');
      expect(html).toContain(`<a href="${SITE}/events/ccc333DDD444">Drill night</a>`);
      expect(html).toContain('<title>Events &amp; Orders | Lords Regiment</title>');
    });

    it('renders one event with its banner, its own timezone and Event structured data', async () => {
      events.getPublic.mockResolvedValue(
        eventDto({
          id: 'ccc333DDD444',
          title: 'Rhine crossing',
          description: 'Massed line battle, 64 per side.',
          bannerUrl: 'https://cdn.example/rhine.png',
          startsAt: '2026-09-12T19:00:00.000Z',
          endsAt: '2026-09-12T22:00:00.000Z',
          timezone: 'Europe/London',
          tags: ['line-battle'],
        }),
      );

      const html = await service.renderEvent('ccc333DDD444');
      const ld = jsonLdAll(html)[0];

      expect(html).toContain('<title>Rhine crossing | Lords Regiment</title>');
      expect(html).toContain(
        '<meta name="description" content="Massed line battle, 64 per side." />',
      );
      expect(html).toContain(
        '<meta property="og:image" content="https://cdn.example/rhine.png" />',
      );
      // 19:00Z is 20:00 in London in September, and the zone is NAMED so the
      // reader cannot mistake it for their own.
      expect(html).toContain('<dt>Starts</dt><dd>12 September 2026 at 20:00 BST</dd>');
      expect(ld['@type']).toBe('Event');
      // The absolute instant, never the rendered wall clock.
      expect(ld.startDate).toBe('2026-09-12T19:00:00.000Z');
      // A REFERENCE to the node `/home` defines, not a fourth inline copy of it
      // (T-0297). Without the shared `@id` the graph held one unlinked
      // organisation per event and per profile, all merely sharing a name.
      // The `@id` merges this with the node `/home` defines, so the graph holds
      // ONE regiment rather than an unlinked organisation per event and per
      // profile. The name and url ride along because a JSON-LD `@id` resolves
      // within a document's OWN graph, and that node lives in a different
      // document — a bare reference would dangle for anyone reading this page
      // alone.
      expect(ld.organizer).toEqual({
        '@type': 'Organization',
        '@id': `${SITE}/#organization`,
        name: 'Lords Regiment',
        url: SITE,
      });
    });

    it('falls back to a generated line naming the date when an event has no description', async () => {
      events.getPublic.mockResolvedValue(
        eventDto({ description: null, startsAt: '2026-09-12T19:00:00.000Z', timezone: 'UTC' }),
      );

      expect(await service.renderEvent('ccc333DDD444')).toContain(
        '<meta name="description" content="Drill night — a Lords Regiment operation on ' +
          '12 September 2026." />',
      );
    });

    it('lists every event and gallery item in the sitemap', async () => {
      members.listForSitemap.mockResolvedValue([]);
      events.listPublic.mockResolvedValue({
        data: [eventDto({ id: 'ccc333DDD444' })],
        meta: { page: 1, limit: 100, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
      });
      gallery.findPublic.mockResolvedValue({
        data: [{ id: 'eee555FFF666' }],
        meta: { page: 1, limit: 100, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
      });

      const xml = await service.renderSitemap();

      expect(xml).toContain(`<loc>${SITE}/events/ccc333DDD444</loc>`);
      expect(xml).toContain(`<loc>${SITE}/gallery/eee555FFF666</loc>`);
      // `/home`, not `/` — submitting a URL that immediately redirects is a
      // wasted entry.
      expect(xml).toContain(`<loc>${SITE}/home</loc>`);
      expect(xml).not.toContain(`<loc>${SITE}/</loc>`);
    });

    it('drops a section it cannot read rather than failing the whole sitemap', async () => {
      members.listForSitemap.mockResolvedValue([]);
      events.listPublic.mockRejectedValue(new Error('Events are private'));
      gallery.findPublic.mockRejectedValue(new Error('The gallery is private'));

      const xml = await service.renderSitemap();

      expect(xml).toContain(`<loc>${SITE}/roster</loc>`);
      expect(xml).not.toContain('/events/');
    });

    it('emits no <priority> or <changefreq> — Google documents that it ignores both', async () => {
      members.listForSitemap.mockResolvedValue([]);
      events.listPublic.mockRejectedValue(new Error('nope'));
      gallery.findPublic.mockRejectedValue(new Error('nope'));

      const xml = await service.renderSitemap();

      // A document full of fields nothing consumes is a document nobody audits.
      expect(xml).not.toContain('<priority>');
      expect(xml).not.toContain('<changefreq>');
    });
  });

  /**
   * The roster shell (T-0297).
   *
   * Two of these defend properties that were BROKEN in production, silently, and
   * neither would have surfaced as an error: a page-size that disagreed with the
   * SPA, and a list page from which no member past the first page had a single
   * internal link pointing at them.
   */
  describe('the roster shell', () => {
    const rosterOf = (total: number) => {
      members.list.mockImplementation((query: { page: number; limit: number }) => {
        const start = (query.page - 1) * query.limit;
        const data = Array.from({ length: Math.min(query.limit, total - start) }, (_, i) => ({
          ...profile(),
          id: `m${start + i}`,
          username: `member${start + i}`,
          canonicalPath: `/u/@member${start + i}`,
        }));
        return Promise.resolve({
          data,
          meta: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
            hasNext: start + query.limit < total,
            hasPrev: query.page > 1,
          },
        });
      });
    };

    it('asks for the SAME page size the SPA does', async () => {
      // 50 here against the SPA's 25 meant `/roster?page=2` served members
      // 51–100 to a crawler and 26–50 to Googlebot's render pass — one URL, two
      // different member sets, and `ItemList` positions that disagreed. That is
      // the divergence this whole module exists to prevent, and it was live.
      rosterOf(120);

      await service.renderRoster(1);

      expect(members.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
    });

    it('renders a real anchor per roster page, not just rel=prev/next', async () => {
      // Google dropped `rel=next/prev` as an indexing signal in 2019 and the SPA
      // paginates with `<button (click)>`, so between them every member past the
      // first page had NO internal link anywhere on the site pointing at their
      // profile — discoverable only from the sitemap, the weakest signal there
      // is.
      rosterOf(120);

      const html = await service.renderRoster(1);

      expect(html).toContain(`<a href="${SITE}/roster?page=2">Page 2</a>`);
      expect(html).toContain(`<a href="${SITE}/roster?page=5">Page 5</a>`);
      expect(html).not.toContain('page=6');
    });

    it('omits the page list entirely for a roster that fits on one page', async () => {
      rosterOf(4);

      const html = await service.renderRoster(1);

      expect(html).not.toContain('Roster pages');
    });

    it('links back out to the rest of the site instead of being a link sink', async () => {
      rosterOf(4);

      const html = await service.renderRoster(1);

      expect(html).toContain(`<a href="${SITE}/home">Lords Regiment</a>`);
      expect(html).toContain(`<a href="${SITE}/events">Events</a>`);
      expect(html).toContain(`<a href="${SITE}/gallery">Gallery</a>`);
    });

    it("uses the regiment's own banner rather than the shipped brand asset", async () => {
      rosterOf(4);
      regiments.getProfile.mockResolvedValue({
        name: 'Lords Regiment',
        bannerUrl: 'https://cdn.example/regiment.png',
      });

      const html = await service.renderRoster(1);

      expect(html).toContain(
        '<meta property="og:image" content="https://cdn.example/regiment.png" />',
      );
    });
  });
});

/** Every ld+json block in the document, parsed. */
function jsonLdAll(html: string): Record<string, unknown>[] {
  const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  if (!match) throw new Error('no ld+json block in the rendered shell');
  const parsed: unknown = JSON.parse(match[1].replace(/\\u003c/g, '<'));
  return (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Only ever fed our own escaped output, to parse an href back into a URL. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
