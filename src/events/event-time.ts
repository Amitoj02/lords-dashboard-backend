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
