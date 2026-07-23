import {
  matchesStoredWallClock,
  reanchorInstant,
  resolveEventInstant,
  storedWallClock,
} from './event-time';

/** Run `fn` as if the process ran in `tz` (Node re-reads process.env.TZ per call). */
const inProcessZone = <T>(tz: string, fn: () => T): T => {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = original;
  }
};

describe('resolveEventInstant (T-0156)', () => {
  it('reads a naive wall clock in the event zone, not the process zone', () => {
    // 21:57 in New York on 2026-07-20 is 01:57Z the next day.
    expect(resolveEventInstant('2026-07-20T21:57:00', 'America/New_York').toISOString()).toBe(
      '2026-07-21T01:57:00.000Z',
    );
  });

  it('resolves the offset per date rather than fixing one (EDT vs EST)', () => {
    // Same wall clock, six months apart: -04:00 in July, -05:00 in January. A
    // hard-coded offset would produce the same UTC hour for both.
    expect(resolveEventInstant('2026-07-20T21:57:00', 'America/New_York').toISOString()).toBe(
      '2026-07-21T01:57:00.000Z',
    );
    expect(resolveEventInstant('2026-01-20T21:57:00', 'America/New_York').toISOString()).toBe(
      '2026-01-21T02:57:00.000Z',
    );
  });

  it('lets an offset-qualified input win over the timezone argument', () => {
    // API clients must keep the ability to post a true instant; the zone is then
    // only a display hint and must not shift what was sent.
    expect(resolveEventInstant('2026-07-20T21:57:00Z', 'America/New_York').toISOString()).toBe(
      '2026-07-20T21:57:00.000Z',
    );
    expect(resolveEventInstant('2026-07-20T21:57:00+05:30', 'America/New_York').toISOString()).toBe(
      '2026-07-20T16:27:00.000Z',
    );
  });

  it('produces the same instant whichever zone the container runs in', () => {
    // The container runs UTC in production and a developer machine rarely does;
    // the stored instant must not depend on that.
    const zones = ['UTC', 'Europe/Berlin', 'Pacific/Kiritimati'];
    const naive = zones.map((tz) =>
      inProcessZone(tz, () => resolveEventInstant('2026-07-20T21:57:00', 'America/New_York')),
    );
    const qualified = zones.map((tz) =>
      inProcessZone(tz, () => resolveEventInstant('2026-07-20T21:57:00Z', 'America/New_York')),
    );

    expect(naive.map((d) => d.toISOString())).toEqual([
      '2026-07-21T01:57:00.000Z',
      '2026-07-21T01:57:00.000Z',
      '2026-07-21T01:57:00.000Z',
    ]);
    expect(qualified.map((d) => d.toISOString())).toEqual([
      '2026-07-20T21:57:00.000Z',
      '2026-07-20T21:57:00.000Z',
      '2026-07-20T21:57:00.000Z',
    ]);
  });

  it('falls back to UTC for an unknown IANA zone instead of throwing', () => {
    // Mirrors the recurrence scheduler: a bad stored zone degrades, never 500s.
    expect(resolveEventInstant('2026-07-20T21:57:00', 'Mars/Olympus').toISOString()).toBe(
      '2026-07-20T21:57:00.000Z',
    );
  });

  it('anchors a date-only value to midnight in the event zone', () => {
    // @IsDateString accepts a bare date; it must not become midnight UTC.
    expect(resolveEventInstant('2026-07-20', 'America/New_York').toISOString()).toBe(
      '2026-07-20T04:00:00.000Z',
    );
  });
});

describe('reanchorInstant (T-0163)', () => {
  it('keeps the wall clock and moves the instant for a zone west of UTC', () => {
    // A pre-T-0156 row stored the typed 21:57 as if it were UTC. The repair
    // re-reads that same wall clock in New York: 21:57 EDT = 01:57Z next day.
    expect(reanchorInstant(new Date('2026-07-20T21:57:00.000Z'), 'America/New_York')).toEqual(
      new Date('2026-07-21T01:57:00.000Z'),
    );
  });

  it('moves the instant the other way for a zone east of UTC', () => {
    // Same wall clock, Berlin (CEST +02:00) — the instant moves EARLIER, so the
    // repair cannot be expressed as "always add the offset".
    expect(reanchorInstant(new Date('2026-07-20T21:57:00.000Z'), 'Europe/Berlin')).toEqual(
      new Date('2026-07-20T19:57:00.000Z'),
    );
  });

  it('is a no-op for a zero-offset zone', () => {
    // Reykjavik is UTC+0 year-round, and London is UTC+0 in winter: the stored
    // instant was already right, so the repair must not nudge it.
    expect(reanchorInstant(new Date('2026-07-20T21:57:00.000Z'), 'Atlantic/Reykjavik')).toEqual(
      new Date('2026-07-20T21:57:00.000Z'),
    );
    expect(reanchorInstant(new Date('2026-01-20T21:57:00.000Z'), 'Europe/London')).toEqual(
      new Date('2026-01-20T21:57:00.000Z'),
    );
    // …but the same zone in summer is +01:00 and does shift.
    expect(reanchorInstant(new Date('2026-07-20T21:57:00.000Z'), 'Europe/London')).toEqual(
      new Date('2026-07-20T20:57:00.000Z'),
    );
  });

  it('preserves the wall-clock duration across a DST boundary', () => {
    // Why startsAt and endsAt are re-derived INDEPENDENTLY instead of sharing one
    // millisecond delta: this event spans the 2026-03-08 spring-forward, so its
    // 24 calendar hours are only 23 real hours once anchored to New York. A fixed
    // delta would have silently kept 24h and moved the end an hour late.
    const start = reanchorInstant(new Date('2026-03-07T12:00:00.000Z'), 'America/New_York');
    const end = reanchorInstant(new Date('2026-03-08T12:00:00.000Z'), 'America/New_York');

    expect(start).toEqual(new Date('2026-03-07T17:00:00.000Z')); // 12:00 EST (-05:00)
    expect(end).toEqual(new Date('2026-03-08T16:00:00.000Z')); // 12:00 EDT (-04:00)
    expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000);
  });

  it('falls back to UTC for an unknown IANA zone instead of throwing', () => {
    // Mirrors resolveEventInstant: a bad stored zone degrades, never 500s.
    expect(reanchorInstant(new Date('2026-07-20T21:57:00.000Z'), 'Mars/Olympus')).toEqual(
      new Date('2026-07-20T21:57:00.000Z'),
    );
  });

  it('shifts AGAIN when applied twice — which is why the caller must assert the wall clock', () => {
    const once = reanchorInstant(new Date('2026-07-20T21:57:00.000Z'), 'America/New_York');
    const twice = reanchorInstant(once, 'America/New_York');

    expect(twice).toEqual(new Date('2026-07-21T05:57:00.000Z'));
    expect(twice.getTime()).not.toBe(once.getTime());
  });
});

describe('storedWallClock / matchesStoredWallClock (T-0163)', () => {
  it('reads the wall clock a pre-T-0156 row encodes, at second precision', () => {
    expect(storedWallClock(new Date('2026-07-20T21:57:00.000Z'))).toBe('2026-07-20T21:57:00');
    // Sub-second precision from the datetime(6) column is dropped, so a caller
    // typing minutes can still satisfy the guard.
    expect(storedWallClock(new Date('2026-07-20T21:57:00.123Z'))).toBe('2026-07-20T21:57:00');
  });

  it('accepts the expected wall clock however precisely the caller writes it', () => {
    const stored = new Date('2026-07-20T21:57:00.000Z');
    expect(matchesStoredWallClock(stored, '2026-07-20T21:57:00')).toBe(true);
    expect(matchesStoredWallClock(stored, '2026-07-20T21:57')).toBe(true);
    expect(matchesStoredWallClock(stored, '2026-07-20T21:57:00.000')).toBe(true);
  });

  it('rejects the wall clock a re-anchored row would show, so a second run cannot pass', () => {
    const repaired = reanchorInstant(new Date('2026-07-20T21:57:00.000Z'), 'America/New_York');
    expect(matchesStoredWallClock(repaired, '2026-07-20T21:57:00')).toBe(false);
  });

  it('treats an unparseable expectation as a mismatch, never a pass', () => {
    expect(matchesStoredWallClock(new Date('2026-07-20T21:57:00.000Z'), 'yesterday')).toBe(false);
  });
});
