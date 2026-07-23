import { DateTime } from 'luxon';

/**
 * Resolve a client-supplied ISO timestamp to the instant it actually denotes,
 * anchoring a naive wall-clock string ("2026-07-20T21:57:00") to the event's own
 * IANA zone rather than to the process zone (T-0156). The driver stores DATETIME
 * columns as UTC, so anchoring 21:57 America/New_York to a UTC container wrote
 * the event four hours early — and every downstream consumer (the status sweep,
 * the recurrence anchor, the SPA countdown) inherited that wrong instant.
 *
 * The offset is resolved per DATE, never fixed: the same wall clock yields
 * 01:57Z in July (EDT) and 02:57Z in January (EST). An input that already
 * carries a `Z`/`±HH:MM` designator is a true instant and WINS over `timezone`,
 * so API clients can keep posting exact instants. An unparseable value is passed
 * to `new Date` unchanged (the DTOs' `@IsDateString` makes that unreachable in
 * practice) so a bad payload fails exactly where it failed before.
 */
export function resolveEventInstant(value: string, timezone: string): Date {
  const zone = DateTime.now().setZone(timezone).isValid ? timezone : 'UTC';
  // setZone keeps an explicit offset in the input authoritative; a naive
  // wall-clock string falls through to `zone`.
  const parsed = DateTime.fromISO(value, { zone, setZone: true });
  return parsed.isValid ? parsed.toJSDate() : new Date(value);
}

/** The wall-clock format the re-anchor repair speaks in: naive, second-precision. */
const WALL_CLOCK = "yyyy-MM-dd'T'HH:mm:ss";

/**
 * The wall clock a pre-T-0156 row actually encodes (T-0163). Those rows were
 * written by anchoring the author's naive input to the PROCESS zone, which is
 * UTC in the container — so the typed wall clock is recoverable exactly, as the
 * UTC field-view of the stored instant. Second-precision on purpose: authors
 * type minutes, and the sub-second tail of a `datetime(6)` column must not make
 * the re-anchor guard below unsatisfiable.
 */
export function storedWallClock(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: 'UTC' }).toFormat(WALL_CLOCK);
}

/**
 * Re-anchor a stored instant to `timezone` while keeping its wall clock (T-0163).
 * This is the inverse of the T-0156 bug: the same Y-M-D h:m:s is re-read in the
 * event's own zone, so 21:57 "UTC" becomes 21:57 America/New_York (01:57Z) and
 * 21:57 Europe/Berlin (19:57Z). The offset is resolved per date, so a series
 * spanning a DST boundary shifts by the offset in force on each row's own date —
 * which is why `startsAt` and `endsAt` must each be passed through here rather
 * than sharing one millisecond delta, or the event's duration would silently
 * change across the boundary. A zero-offset zone is a legitimate no-op. An
 * unknown IANA zone degrades to UTC (never throws), mirroring
 * {@link resolveEventInstant}.
 */
export function reanchorInstant(instant: Date, timezone: string): Date {
  const zone = DateTime.now().setZone(timezone).isValid ? timezone : 'UTC';
  return DateTime.fromJSDate(instant, { zone: 'UTC' })
    .setZone(zone, { keepLocalTime: true })
    .toJSDate();
}

/**
 * Whether `expected` names the same wall clock the row currently stores (T-0163).
 * Nothing on an event distinguishes a repaired instant from one that was always
 * right, so the re-anchor action makes the caller state the wall clock it expects
 * to see and refuses when reality disagrees — that is what stops a second run
 * from silently shifting an already-repaired row again. An unparseable value is
 * a mismatch, never a pass.
 */
export function matchesStoredWallClock(instant: Date, expected: string): boolean {
  const parsed = DateTime.fromISO(expected, { zone: 'UTC' });
  return parsed.isValid && parsed.toFormat(WALL_CLOCK) === storedWallClock(instant);
}
