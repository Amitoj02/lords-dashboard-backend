import { MemberSocialPlatform } from '../common/enums';
import {
  MEMBER_SOCIAL_PLATFORMS,
  MEMBER_SOCIAL_PLATFORM_KEYS,
  isSupportedSocialPlatform,
  isValidSocialHandle,
  normalizeSocialHandle,
  socialPlatformLabel,
  socialPlatformPrecedence,
  socialProfileUrl,
} from './social-platforms';

/**
 * The registry is the only thing standing between "a member typed something"
 * and "our crawlable profile page links to it", so these tests are deliberately
 * exhaustive about the boundaries rather than sampling them.
 */
describe('member social platforms (T-0216)', () => {
  describe('normalizeSocialHandle', () => {
    it('trims the whitespace a double-click drags along', () => {
      expect(normalizeSocialHandle('  LordPanda  ')).toBe('LordPanda');
    });

    it('strips a leading @, which is what people paste from an overlay', () => {
      expect(normalizeSocialHandle('@LordPanda')).toBe('LordPanda');
    });

    it('strips a trailing /, which is what people paste from a URL', () => {
      expect(normalizeSocialHandle('LordPanda/')).toBe('LordPanda');
    });

    it('handles both artefacts at once, with the whitespace outside them', () => {
      expect(normalizeSocialHandle(' @LordPanda/ ')).toBe('LordPanda');
    });

    it('strips exactly ONE leading @ — @@panda is a wrong handle, not a paste artefact', () => {
      // Repairing it would silently point the member at someone else's account.
      expect(normalizeSocialHandle('@@panda')).toBe('@panda');
      expect(
        isValidSocialHandle(MemberSocialPlatform.Twitch, normalizeSocialHandle('@@panda')),
      ).toBe(false);
    });

    it('strips exactly ONE trailing /', () => {
      expect(normalizeSocialHandle('panda//')).toBe('panda/');
    });

    it('PRESERVES case — the networks display handles as typed', () => {
      expect(normalizeSocialHandle('LoRdPaNdA')).toBe('LoRdPaNdA');
    });

    it('survives an empty or whitespace-only handle without throwing', () => {
      expect(normalizeSocialHandle('   ')).toBe('');
      expect(normalizeSocialHandle('@')).toBe('');
    });
  });

  describe('the registry and the enum cannot drift apart', () => {
    // A platform added to one and not the other is the exact failure this pair
    // of tests exists to catch: an enum member with no rules would validate
    // nothing, and a spec with no enum member could never be requested.
    it.each(Object.values(MemberSocialPlatform))('enum member %s has a registry entry', (value) => {
      expect(MEMBER_SOCIAL_PLATFORMS.some((spec) => spec.platform === value)).toBe(true);
      expect(isSupportedSocialPlatform(value)).toBe(true);
    });

    it.each(MEMBER_SOCIAL_PLATFORMS)('registry entry $platform is a member of the enum', (spec) => {
      expect(Object.values(MemberSocialPlatform)).toContain(spec.platform);
    });

    it('lists every platform exactly once, in the documented display order', () => {
      expect(MEMBER_SOCIAL_PLATFORM_KEYS).toEqual([
        'twitch',
        'youtube',
        'instagram',
        'tiktok',
        'x',
        'steam',
        'medal',
      ]);
      expect(new Set(MEMBER_SOCIAL_PLATFORM_KEYS).size).toBe(MEMBER_SOCIAL_PLATFORMS.length);
      expect(MEMBER_SOCIAL_PLATFORMS).toHaveLength(Object.values(MemberSocialPlatform).length);
    });

    it('does NOT include discord — that identity is OAuth-proven and members-only', () => {
      expect(isSupportedSocialPlatform('discord')).toBe(false);
      expect(MEMBER_SOCIAL_PLATFORM_KEYS).not.toContain('discord');
    });

    it('gives every entry a human label distinct from its key', () => {
      for (const spec of MEMBER_SOCIAL_PLATFORMS) {
        expect(spec.label.length).toBeGreaterThan(0);
        expect(socialPlatformLabel(spec.platform)).toBe(spec.label);
      }
      expect(socialPlatformLabel(MemberSocialPlatform.MedalTv)).toBe('Medal.tv');
      expect(socialPlatformLabel(MemberSocialPlatform.X)).toBe('X');
    });

    it('orders precedence by the display order, with unknowns last', () => {
      expect(socialPlatformPrecedence(MemberSocialPlatform.Twitch)).toBe(0);
      expect(socialPlatformPrecedence(MemberSocialPlatform.MedalTv)).toBe(6);
      expect(socialPlatformPrecedence('myspace')).toBe(MEMBER_SOCIAL_PLATFORMS.length);
    });
  });

  describe('isValidSocialHandle', () => {
    it.each([
      // [platform, handle, why]
      [MemberSocialPlatform.Twitch, 'ninja', 'ordinary login'],
      [MemberSocialPlatform.Twitch, 'abcd', 'the 4-character floor'],
      [MemberSocialPlatform.Twitch, 'a'.repeat(25), 'the 25-character ceiling'],
      [MemberSocialPlatform.Twitch, 'Lord_Panda_01', 'mixed case, digits and underscore'],
      [MemberSocialPlatform.YouTube, 'abc', 'the 3-character floor'],
      [MemberSocialPlatform.YouTube, 'a'.repeat(30), 'the 30-character ceiling'],
      [MemberSocialPlatform.YouTube, 'lord.panda-01_x', 'dots, hyphens and underscores are legal'],
      [MemberSocialPlatform.Instagram, 'a', 'the 1-character floor'],
      [MemberSocialPlatform.Instagram, 'a'.repeat(30), 'the 30-character ceiling'],
      [MemberSocialPlatform.Instagram, 'lord.panda_01', 'dots and underscores'],
      [MemberSocialPlatform.TikTok, 'ab', 'the 2-character floor'],
      [MemberSocialPlatform.TikTok, 'a'.repeat(24), 'the 24-character ceiling'],
      [MemberSocialPlatform.TikTok, 'lord.panda_01', 'dots and underscores'],
      [MemberSocialPlatform.X, 'a', 'the 1-character floor'],
      [MemberSocialPlatform.X, 'a'.repeat(15), 'the 15-character ceiling'],
      [MemberSocialPlatform.X, 'Lord_Panda', 'mixed case and underscore'],
      [MemberSocialPlatform.Steam, 'ab', 'the 2-character floor'],
      [MemberSocialPlatform.Steam, 'a'.repeat(32), 'the 32-character ceiling'],
      [MemberSocialPlatform.Steam, 'lord-panda_01', 'hyphens and underscores'],
      [MemberSocialPlatform.Steam, '76561198012345678', 'a 17-digit steamID64'],
      [MemberSocialPlatform.MedalTv, 'ab', 'the 2-character floor'],
      [MemberSocialPlatform.MedalTv, 'a'.repeat(32), 'the 32-character ceiling'],
      [MemberSocialPlatform.MedalTv, 'lord-panda_01', 'hyphens and underscores'],
    ])('%s accepts "%s" (%s)', (platform, handle) => {
      expect(isValidSocialHandle(platform, handle)).toBe(true);
    });

    it.each([
      [MemberSocialPlatform.Twitch, 'abc', 'one under the 4-character floor'],
      [MemberSocialPlatform.Twitch, 'a'.repeat(26), 'one over the 25-character ceiling'],
      [MemberSocialPlatform.Twitch, 'lord.panda', 'a dot — not a Twitch login character'],
      [MemberSocialPlatform.Twitch, 'lord-panda', 'a hyphen — same'],
      [MemberSocialPlatform.YouTube, 'ab', 'one under the 3-character floor'],
      [MemberSocialPlatform.YouTube, 'a'.repeat(31), 'one over the 30-character ceiling'],
      [MemberSocialPlatform.YouTube, 'lord panda', 'a space'],
      [MemberSocialPlatform.Instagram, '', 'empty'],
      [MemberSocialPlatform.Instagram, 'a'.repeat(31), 'one over the 30-character ceiling'],
      [MemberSocialPlatform.Instagram, 'lord-panda', 'a hyphen — not an Instagram character'],
      [MemberSocialPlatform.TikTok, 'a', 'one under the 2-character floor'],
      [MemberSocialPlatform.TikTok, 'a'.repeat(25), 'one over the 24-character ceiling'],
      [MemberSocialPlatform.TikTok, 'lord-panda', 'a hyphen'],
      [MemberSocialPlatform.X, '', 'empty'],
      [MemberSocialPlatform.X, 'a'.repeat(16), 'one over the 15-character ceiling'],
      [MemberSocialPlatform.X, 'lord.panda', 'a dot'],
      [MemberSocialPlatform.Steam, 'a', 'one under the 2-character floor'],
      [MemberSocialPlatform.Steam, 'a'.repeat(33), 'one over the 32-character ceiling'],
      [MemberSocialPlatform.Steam, 'lord.panda', 'a dot'],
      [MemberSocialPlatform.MedalTv, 'a', 'one under the 2-character floor'],
      [MemberSocialPlatform.MedalTv, 'a'.repeat(33), 'one over the 32-character ceiling'],
      [MemberSocialPlatform.MedalTv, 'lord.panda', 'a dot'],
    ])('%s rejects "%s" (%s)', (platform, handle) => {
      expect(isValidSocialHandle(platform, handle)).toBe(false);
    });

    it.each(Object.values(MemberSocialPlatform))(
      '%s rejects the shapes that would escape the path segment',
      (platform) => {
        // None of these can reach a builder, and that is the point: the URL is
        // composed from a hardcoded origin plus THIS string.
        for (const hostile of [
          '../../evil',
          'panda/../evil',
          'panda?next=https://evil.example',
          'panda#frag',
          'evil.example/panda',
          'https://evil.example',
          'javascript:alert(1)',
          'lord panda',
          'panda%2f',
        ]) {
          expect(isValidSocialHandle(platform, hostile)).toBe(false);
        }
      },
    );

    it('rejects a platform that is not in the registry', () => {
      // `member_social_links.platform` is a varchar open set, so an unknown
      // value is a state the code must survive, not an impossible one.
      expect(isValidSocialHandle('discord', 'LordPanda')).toBe(false);
      expect(isValidSocialHandle('myspace', 'LordPanda')).toBe(false);
    });
  });

  describe('socialProfileUrl', () => {
    it.each([
      [MemberSocialPlatform.Twitch, 'LordPanda', 'https://www.twitch.tv/LordPanda'],
      [MemberSocialPlatform.YouTube, 'LordPanda', 'https://www.youtube.com/@LordPanda'],
      [MemberSocialPlatform.Instagram, 'lord.panda', 'https://www.instagram.com/lord.panda'],
      [MemberSocialPlatform.TikTok, 'lord.panda', 'https://www.tiktok.com/@lord.panda'],
      [MemberSocialPlatform.X, 'LordPanda', 'https://x.com/LordPanda'],
      [MemberSocialPlatform.MedalTv, 'lord-panda', 'https://medal.tv/u/lord-panda'],
    ])('builds the %s URL from the handle alone', (platform, handle, expected) => {
      expect(socialProfileUrl(platform, handle)).toBe(expected);
    });

    it('sends a 17-digit steamID64 to /profiles/', () => {
      expect(socialProfileUrl(MemberSocialPlatform.Steam, '76561198012345678')).toBe(
        'https://steamcommunity.com/profiles/76561198012345678',
      );
    });

    it('sends a vanity Steam id to /id/', () => {
      expect(socialProfileUrl(MemberSocialPlatform.Steam, 'lord-panda')).toBe(
        'https://steamcommunity.com/id/lord-panda',
      );
      // 16 digits is NOT a steamID64 — it must not take the /profiles/ branch.
      expect(socialProfileUrl(MemberSocialPlatform.Steam, '7656119801234567')).toBe(
        'https://steamcommunity.com/id/7656119801234567',
      );
    });

    it('preserves the case the member typed', () => {
      expect(socialProfileUrl(MemberSocialPlatform.Twitch, 'LoRdPaNdA')).toBe(
        'https://www.twitch.tv/LoRdPaNdA',
      );
    });

    it.each(MEMBER_SOCIAL_PLATFORMS)(
      '$platform always yields an https:// URL with no whitespace',
      (spec) => {
        for (const handle of ['lordpanda', 'LordPanda', 'ab_cd']) {
          if (!isValidSocialHandle(spec.platform, handle)) {
            continue;
          }
          const url = socialProfileUrl(spec.platform, handle);
          expect(url.startsWith('https://')).toBe(true);
          expect(url).not.toMatch(/\s/);
          // The origin is hardcoded here; the handle only ever lands in the path.
          expect(new URL(url).pathname).toContain(handle);
        }
      },
    );

    it('percent-encodes rather than trusting an unvalidated handle', () => {
      // Defence in depth: this input can never pass isValidSocialHandle, but if
      // it ever reached the builder it must not break out of the path segment.
      const url = socialProfileUrl(MemberSocialPlatform.X, 'a b/../evil');
      expect(url).toBe('https://x.com/a%20b%2F..%2Fevil');
      expect(new URL(url).host).toBe('x.com');
      expect(url).not.toMatch(/\s/);
    });

    it('THROWS for an unknown platform rather than inventing a URL', () => {
      // There is no safe fallback: echoing an unexplained value into a link is
      // exactly the arbitrary-outbound-link hazard the registry prevents.
      expect(() => socialProfileUrl('myspace', 'LordPanda')).toThrow(/Unsupported social platform/);
    });
  });

  describe('normalise → validate → build, end to end', () => {
    it('accepts what a member actually pastes', () => {
      const handle = normalizeSocialHandle(' @LordPanda/ ');
      expect(isValidSocialHandle(MemberSocialPlatform.Twitch, handle)).toBe(true);
      expect(socialProfileUrl(MemberSocialPlatform.Twitch, handle)).toBe(
        'https://www.twitch.tv/LordPanda',
      );
    });

    it('still refuses a full URL, because that is not a handle', () => {
      const handle = normalizeSocialHandle('https://www.twitch.tv/LordPanda/');
      expect(isValidSocialHandle(MemberSocialPlatform.Twitch, handle)).toBe(false);
    });
  });
});
