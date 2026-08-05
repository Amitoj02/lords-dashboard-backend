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
    it('is deliberately NOT rebuilt from the bio — the SPA builds that string too', async () => {
      // Changing this without the frontend's `describe()` changing in the same
      // deploy would give one URL two different descriptions across the two
      // rendering passes, which is the disagreement that reads as cloaking.
      const html = await render(profile({ bio: 'I mostly play the drum.' }));

      expect(html).toContain(
        '<meta name="description" content="Colonel in Lords Regiment · 0 decorations · ' +
          '42 events attended · serving since 5 January 2026." />',
      );
      expect(html).not.toContain('<meta name="description" content="I mostly play the drum');
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
    it('uses the BANNER and asks for the wide card when the member has one', async () => {
      const html = await render(profile({ bannerUrl: 'https://cdn.example/banner.png' }));

      expect(html).toContain(
        '<meta property="og:image" content="https://cdn.example/banner.png" />',
      );
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    });

    it('uses the avatar and asks for the SMALL card when there is no banner', async () => {
      const html = await render(profile({ avatarUrl: '/api/public/members/abc123XYZ456/avatar' }));

      // The avatar is a path on THIS origin (the proxy that keeps a member's
      // Discord snowflake out of the markup), so it has to be made absolute —
      // an unfurler will not resolve a relative one.
      expect(html).toContain(
        `<meta property="og:image" content="${SITE}/api/public/members/abc123XYZ456/avatar" />`,
      );
      expect(html).toContain('<meta name="twitter:card" content="summary" />');
    });

    it('still shows the site banner for a member with neither', async () => {
      const html = await render(profile({ avatarUrl: null, bannerUrl: null }));

      expect(html).toContain(
        `<meta property="og:image" content="${SITE}/assets/images/banner.png" />`,
      );
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
      expect(ld.organizer).toEqual({
        '@type': 'Organization',
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
