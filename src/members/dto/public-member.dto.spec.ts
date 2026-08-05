import { MemberRole, MemberStatus } from '../../common/enums';
import { Member } from '../entities/member.entity';
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
});
