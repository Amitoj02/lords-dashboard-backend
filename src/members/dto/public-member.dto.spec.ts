import { MemberRole, MemberStatus } from '../../common/enums';
import { MemberSocialLink } from '../entities/member-social-link.entity';
import { Member } from '../entities/member.entity';
import { MemberSocialLinkDto } from './member-social-link.dto';
import { MemberMedalSummary } from './member.dto';
import { PublicMemberDto } from './public-member.dto';

/**
 * A member row carrying EVERY sensitive field populated, so a leak shows up as
 * a real value rather than as an incidental undefined.
 */
function member(overrides: Partial<Member> = {}): Member {
  return {
    id: 'aB3x9KqLm2Zt',
    regimentId: 'Rgmt00000001',
    discordIdentityId: 'ident-1',
    discordIdentity: {
      discordTag: '@panda',
      avatarUrl: 'https://cdn.discordapp.com/avatars/123456789012345678/abc.png',
    },
    rankId: 'rank-1',
    rank: { name: 'Colonel', imageUrl: 'https://cdn.example/col.png', precedence: 3 },
    inGameName: 'Amitoj',
    username: 'panda',
    usernameChangedAt: new Date('2026-01-01T00:00:00Z'),
    role: MemberRole.Owner,
    status: MemberStatus.Active,
    discordLinked: true,
    publicProfile: true,
    avatarUrl: null,
    bannerUrl: 'https://cdn.example/banner.png',
    bio: 'Line infantry since 2024. Flank anchor, occasional drummer.',
    standing: 'Good Order',
    joinedAt: new Date('2024-03-04T00:00:00Z'),
    lastSeenAt: new Date('2026-08-04T10:00:00Z'),
    suspendedUntil: new Date('2026-09-01T00:00:00Z'),
    bannedAt: new Date('2026-07-01T00:00:00Z'),
    createdAt: new Date('2024-03-04T00:00:00Z'),
    updatedAt: new Date('2026-08-04T10:00:00Z'),
    deletedAt: null,
    ...overrides,
  } as unknown as Member;
}

const medal: MemberMedalSummary = {
  id: 'award-1',
  medalId: 'medal-1',
  title: 'Valour Cross',
  glyph: 'VC',
  imageUrl: 'https://cdn.example/vc.png',
  description: 'Awarded for conspicuous gallantry in a line battle.',
  detail: 'Held the left flank at Ligny after Sgt Nyx fell. Recommended by Cpl Kestrel.',
  awardedAt: '2025-03-12T00:00:00.000Z',
};

/** A stored `member_social_links` row, as the service hands it to the mapper. */
function link(overrides: Partial<MemberSocialLink> = {}): MemberSocialLink {
  return {
    id: 'lnk000000001',
    memberId: 'aB3x9KqLm2Zt',
    platform: 'twitch',
    handle: 'LordPanda',
    precedence: 0,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

describe('PublicMemberDto', () => {
  it('carries the fields a public profile is FOR', () => {
    const dto = PublicMemberDto.from(member(), { eventsAttended: 42 }, [medal], '/api/avatar');

    expect(dto.id).toBe('aB3x9KqLm2Zt');
    expect(dto.username).toBe('panda');
    expect(dto.inGameName).toBe('Amitoj');
    expect(dto.role).toBe(MemberRole.Owner);
    expect(dto.rank).toBe('Colonel');
    expect(dto.rankPrecedence).toBe(3);
    expect(dto.bannerUrl).toBe('https://cdn.example/banner.png');
    expect(dto.joinedAt).toBe('2024-03-04T00:00:00.000Z');
    expect(dto.eventsAttended).toBe(42);
    expect(dto.canonicalPath).toBe('/u/@panda');
  });

  /**
   * bio and socialLinks are the member-AUTHORED half of the profile, and the
   * only two published fields the member writes themselves — see the class doc
   * for why that distinction is what makes them safe to publish (T-0216).
   */
  it('publishes the member-authored half of the profile', () => {
    // Deliberately submitted out of registry order — the projection re-sorts.
    const links = [link({ platform: 'x', handle: 'panda' }), link()];
    const dto = PublicMemberDto.from(member(), { eventsAttended: 0 }, [], null, links);

    expect(dto.bio).toBe('Line infantry since 2024. Flank anchor, occasional drummer.');
    expect(dto.socialLinks).toEqual([
      {
        platform: 'twitch',
        label: 'Twitch',
        handle: 'LordPanda',
        url: 'https://www.twitch.tv/LordPanda',
      },
      { platform: 'x', label: 'X', handle: 'panda', url: 'https://x.com/panda' },
    ]);
  });

  it('emits an empty array, never undefined, when the member has published no links', () => {
    const dto = PublicMemberDto.from(member({ bio: null }), { eventsAttended: 0 }, [], null);

    expect(dto.bio).toBeNull();
    expect(JSON.parse(JSON.stringify(dto)).socialLinks).toEqual([]);
  });

  /**
   * The point of the whole DTO. Asserted against the SERIALIZED object, because
   * that is what crosses the wire — this tsconfig defines declared class fields
   * even when unassigned, so an in-memory `toHaveProperty` would be testing the
   * compiler rather than the contract.
   */
  it.each([
    ['discordTag', 'resolves an in-game handle to a real, DM-able Discord account'],
    ['discordLinked', 'no public use'],
    ['status', 'Pending means an application is under review'],
    ['standing', 'a disciplinary-sounding label'],
    ['lastSeenAt', 'bumped on every request — a live presence timeline, not a last login'],
    ['suspendedUntil', 'disciplinary state about a named person'],
    ['bannedAt', 'disciplinary state about a named person'],
    ['permittedActions', 'derived from the CALLER — the one field that breaks edge caching'],
    ['publicProfile', 'an internal flag'],
  ])('NEVER emits %s (%s)', (field) => {
    const dto = PublicMemberDto.from(member(), { eventsAttended: 1 }, [medal], '/api/avatar');
    const wire = JSON.parse(JSON.stringify(dto));

    expect(wire).not.toHaveProperty(field);
  });

  it('NEVER emits a medal citation — that is officer-authored prose about a person', () => {
    const dto = PublicMemberDto.from(member(), { eventsAttended: 1 }, [medal], '/api/avatar');
    const wire = JSON.parse(JSON.stringify(dto));

    expect(wire.medals[0]).not.toHaveProperty('detail');
    // The CATALOGUE description is public — it is what the medal is awarded for,
    // identical for every holder, and it is the substance of the page.
    expect(wire.medals[0].description).toBe('Awarded for conspicuous gallantry in a line battle.');
    expect(JSON.stringify(wire)).not.toContain('Held the left flank');
  });

  it('NEVER emits the Discord CDN avatar — the URL embeds the member snowflake', () => {
    const dto = PublicMemberDto.from(member(), { eventsAttended: 1 }, [], '/api/avatar');

    expect(dto.avatarUrl).toBe('/api/avatar');
    expect(JSON.stringify(dto)).not.toContain('cdn.discordapp.com');
    expect(JSON.stringify(dto)).not.toContain('123456789012345678');
  });

  it('emits a null avatar when the member has none, so the client keeps its initials tile', () => {
    const dto = PublicMemberDto.from(member(), { eventsAttended: 0 }, [], null);

    expect(dto.avatarUrl).toBeNull();
  });

  it('falls back to the short-id path when no handle is claimed', () => {
    const dto = PublicMemberDto.from(member({ username: null }), { eventsAttended: 0 }, [], null);

    expect(dto.username).toBeNull();
    expect(dto.canonicalPath).toBe('/u/aB3x9KqLm2Zt');
  });

  it('copies medals field-by-field, so widening MemberMedalSummary cannot leak', () => {
    // A spread would carry any new field straight onto the wire. This asserts
    // the allowlist shape rather than the current field set.
    const widened = { ...medal, internalNote: 'staff only' } as MemberMedalSummary;
    const dto = PublicMemberDto.from(member(), { eventsAttended: 0 }, [widened], null);

    expect(Object.keys(dto.medals[0]).sort()).toEqual([
      'awardedAt',
      'description',
      'glyph',
      'id',
      'imageUrl',
      'medalId',
      'title',
    ]);
  });

  it('copies social links field-by-field, so widening the shared DTO cannot leak', () => {
    // MemberSocialLinkDto is shared with the AUTHENTICATED projection, so a
    // field added there for a signed-in screen would ride a spread onto this
    // anonymous, crawlable page. Simulated by widening what the shared mapper
    // returns — the assertion is on the allowlist shape, not on today's fields.
    const widened = {
      ...MemberSocialLinkDto.from(link()),
      verifiedByStaff: true,
    } as MemberSocialLinkDto;
    const spy = jest.spyOn(MemberSocialLinkDto, 'from').mockReturnValue(widened);
    try {
      const dto = PublicMemberDto.from(member(), { eventsAttended: 0 }, [], null, [link()]);

      expect(Object.keys(dto.socialLinks[0]).sort()).toEqual([
        'handle',
        'label',
        'platform',
        'url',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The point of storing handles instead of URLs. A member profile is crawlable
   * and carries the regiment's name, so a member who could publish an arbitrary
   * outbound link could point our reputation at anything. The host is not
   * validated out of a submitted URL — it is never submitted at all, and the
   * only origins reachable are the ones hardcoded in the registry.
   */
  it.each([
    ['evil.example.com', 'a bare foreign host'],
    ['//evil.example.com', 'a protocol-relative URL'],
    ['..%2F..%2Fevil', 'pre-encoded path traversal'],
    ['a/../../evil.example.com', 'path traversal'],
    ['a?next=https://evil.example.com', 'a query-string smuggle'],
    ['a#@evil.example.com', 'a fragment/userinfo smuggle'],
  ])('builds the URL server-side, so the handle %s (%s) cannot change the origin', (handle) => {
    const dto = PublicMemberDto.from(member(), { eventsAttended: 0 }, [], null, [link({ handle })]);

    // The hostile text survives in `handle` — it is a display string, escaped at
    // render time like every other member-authored value. What must NOT survive
    // is any influence over the origin the link points at.
    expect(new URL(dto.socialLinks[0].url).origin).toBe('https://www.twitch.tv');
    expect(new URL(dto.socialLinks[0].url).hostname).toBe('www.twitch.tv');
    expect(dto.socialLinks[0].url.startsWith('https://www.twitch.tv/')).toBe(true);
  });

  it('drops a stored platform the registry can no longer explain', () => {
    // `platform` is an open varchar set, so a row can outlive its registry
    // entry. There is no safe fallback URL for one — dropping it is the only
    // answer that cannot invent an origin.
    const dto = PublicMemberDto.from(member(), { eventsAttended: 0 }, [], null, [
      link({ platform: 'myspace', handle: 'panda' }),
      link({ platform: 'steam', handle: '76561198000000000' }),
    ]);

    expect(dto.socialLinks).toHaveLength(1);
    expect(dto.socialLinks[0].url).toBe('https://steamcommunity.com/profiles/76561198000000000');
  });

  /**
   * The whole-shape allowlist, and the reason a new field on this class is a
   * deliberate act: adding one to PublicMemberDto fails HERE until someone
   * writes it into the list, which is the moment the "should an anonymous
   * visitor see this?" question gets asked. Asserted on the class rather than on
   * the serialized wire because this tsconfig defines declared fields even when
   * unassigned — so a field that is declared but never populated (the shape a
   * future leak most likely arrives in) still shows up.
   */
  it('emits exactly the allowlisted public fields, and nothing else', () => {
    const dto = PublicMemberDto.from(member(), { eventsAttended: 1 }, [medal], '/api/avatar', [
      link(),
    ]);

    expect(Object.keys(dto).sort()).toEqual([
      'avatarUrl',
      'bannerUrl',
      'bio',
      'canonicalPath',
      'eventsAttended',
      'id',
      'inGameName',
      'joinedAt',
      'medals',
      'rank',
      'rankImageUrl',
      'rankPrecedence',
      'role',
      'socialLinks',
      'username',
    ]);
  });
});
