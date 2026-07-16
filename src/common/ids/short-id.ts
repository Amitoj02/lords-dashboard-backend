import { randomInt } from 'crypto';
import { Matches, ValidationOptions } from 'class-validator';

/**
 * Short-id scheme (T-0081): 12-character base62 identifiers (~71 bits of
 * entropy) replacing uuid v4 primary keys on user-facing entities. Generated
 * in-app via Node's unbiased `crypto.randomInt` (no external dependency, CJS
 * safe). Birthday-collision risk at regiment scale is negligible; the DB PRIMARY
 * KEY constraint is the ultimate backstop.
 *
 * SECURITY-OPAQUE values keep their original long/random form and do NOT use
 * this scheme: storage object keys, discord-sync outbox ids, GDPR self-deletion
 * tokens, OAuth/session material, and the discord_identities primary key (the
 * JWT `sub`). See SCHEMA.md § "Identifier scheme".
 */
export const SHORT_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const SHORT_ID_LENGTH = 12;

/** The exact shape a short id must match (12 base62 chars). */
export const SHORT_ID_REGEX = /^[0-9A-Za-z]{12}$/;

/** Generate a fresh 12-char base62 short id using unbiased randomness. */
export function generateShortId(): string {
  let id = '';
  for (let i = 0; i < SHORT_ID_LENGTH; i += 1) {
    id += SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)];
  }
  return id;
}

/** Runtime guard for the short-id format. */
export function isShortId(value: unknown): value is string {
  return typeof value === 'string' && SHORT_ID_REGEX.test(value);
}

/**
 * class-validator decorator accepting only well-formed short ids. Replaces
 * `@IsUUID()` on entity-id DTO fields (T-0084). Pass `{ each: true }` for arrays.
 */
export function IsShortId(validationOptions?: ValidationOptions): PropertyDecorator {
  return Matches(SHORT_ID_REGEX, {
    message: `$property must be a valid id`,
    ...validationOptions,
  });
}
