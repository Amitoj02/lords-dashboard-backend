import { resolveEventInstant } from './event-time';

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
