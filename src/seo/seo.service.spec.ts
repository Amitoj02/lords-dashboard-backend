import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { MemberRole } from '../common/enums';
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
});

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
