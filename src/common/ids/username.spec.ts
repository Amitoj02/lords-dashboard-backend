import {
  RESERVED_USERNAMES,
  isReservedUsername,
  isUsername,
  normalizeUsername,
  parseProfileHandle,
  profilePathFor,
} from './username';

describe('username', () => {
  describe('normalizeUsername', () => {
    it('lowercases and trims, because the collation would collide on them anyway', () => {
      // utf8mb4_unicode_ci is case-insensitive AND PAD SPACE, so 'Panda' and
      // 'panda ' would both raise ER_DUP_ENTRY against an existing 'panda'.
      // Normalising first turns a baffling 409 into a successful no-op claim.
      expect(normalizeUsername('  Panda ')).toBe('panda');
      expect(normalizeUsername('LORD_PANDA')).toBe('lord_panda');
    });
  });

  describe('isUsername', () => {
    it.each(['pan', 'panda', 'lord_panda', 'p4nd4', 'a'.repeat(20)])('accepts %s', (value) => {
      expect(isUsername(value)).toBe(true);
    });

    it.each([
      ['pa', 'shorter than 3 — 1-2 chars are pure land-grab'],
      ['a'.repeat(21), 'longer than 20 — the roster column has a fixed width'],
      ['Panda', 'uppercase — storage is canonical lowercase'],
      ['lord.panda', 'a dot — lets lord.panda and lordpanda impersonate each other'],
      ['lord-panda', 'a hyphen — same reason'],
      ['lord panda', 'a space'],
      ['раnda', 'Cyrillic homograph'],
      ['', 'empty'],
    ])('rejects %s (%s)', (value) => {
      expect(isUsername(value)).toBe(false);
    });
  });

  describe('reserved handles', () => {
    it('blocks routing-surface and authority-implying handles', () => {
      expect(isReservedUsername('admin')).toBe(true);
      expect(isReservedUsername('roster')).toBe(true);
      expect(isReservedUsername('moderator')).toBe(true);
      expect(isReservedUsername('panda')).toBe(false);
    });

    it('normalises before matching, so ADMIN is refused too', () => {
      expect(isReservedUsername('  ADMIN ')).toBe(true);
    });

    it('contains only handles that are themselves claimable shapes', () => {
      // A reserved word that could never pass isUsername is dead weight and
      // hides a typo — every entry must be a handle someone could really try.
      for (const reserved of RESERVED_USERNAMES) {
        expect(isUsername(reserved)).toBe(true);
      }
    });
  });

  describe('parseProfileHandle', () => {
    it('reads a vanity handle only with the @ sigil', () => {
      expect(parseProfileHandle('@panda')).toEqual({ username: 'panda' });
    });

    it('reads a 12-char short id without a sigil', () => {
      expect(parseProfileHandle('aB3x9KqLm2Zt')).toEqual({ shortId: 'aB3x9KqLm2Zt' });
    });

    it('KEEPS THE TWO NAMESPACES DISJOINT — a 12-char handle is not a short id', () => {
      // This is the whole reason the sigil is mandatory. Without it,
      // `/u/lordpandaxy` (12 chars, a legal handle) would be indistinguishable
      // from a short id, and the resolver would have to guess.
      expect(parseProfileHandle('@lordpandaxy')).toEqual({ username: 'lordpandaxy' });
      expect(parseProfileHandle('lordpandaxy')).toBeNull(); // 11 chars, neither
      expect(parseProfileHandle('lordpandaxyz')).toEqual({ shortId: 'lordpandaxyz' });
    });

    it('accepts the percent-encoded sigil some clients send', () => {
      expect(parseProfileHandle('%40panda')).toEqual({ username: 'panda' });
    });

    it('returns null for anything that is neither', () => {
      expect(parseProfileHandle('@ab')).toBeNull(); // too short to be a handle
      expect(parseProfileHandle('@Panda!')).toBeNull();
      expect(parseProfileHandle('short')).toBeNull();
      expect(parseProfileHandle('')).toBeNull();
    });

    it('normalises a mixed-case handle rather than rejecting it', () => {
      expect(parseProfileHandle('@Panda')).toEqual({ username: 'panda' });
    });
  });

  describe('profilePathFor', () => {
    it('prefers the vanity path — it is what rel=canonical and the sitemap use', () => {
      expect(profilePathFor({ id: 'aB3x9KqLm2Zt', username: 'panda' })).toBe('/u/@panda');
    });

    it('falls back to the short id when no handle is claimed', () => {
      expect(profilePathFor({ id: 'aB3x9KqLm2Zt', username: null })).toBe('/u/aB3x9KqLm2Zt');
      expect(profilePathFor({ id: 'aB3x9KqLm2Zt' })).toBe('/u/aB3x9KqLm2Zt');
    });
  });
});
