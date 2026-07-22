import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

/**
 * Validates that a string is a timezone the runtime actually knows (T-0162).
 *
 * Without this, a typo'd or non-IANA zone passed the `@MaxLength(40)` check and
 * then silently resolved to UTC in {@link resolveEventInstant} — so an event
 * authored as 21:00 "Amercia/New_York" would be stored four hours early with no
 * error anywhere. Failing at the DTO boundary turns a silent mis-scheduling into
 * an obvious 400.
 *
 * The check delegates to `Intl` rather than shipping a zone list, so it tracks
 * the tzdata the process is actually using — a hard-coded list would drift the
 * first time a zone is added or renamed.
 */
@ValidatorConstraint({ name: 'isIanaTimezone', async: false })
export class IsIanaTimezone implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) {
      return false;
    }
    try {
      // Throws RangeError for an unknown zone; succeeds for every valid one.
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'timezone must be a valid IANA timezone name (e.g. Europe/Berlin)';
  }
}
