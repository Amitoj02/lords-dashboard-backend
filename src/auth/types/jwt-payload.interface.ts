/**
 * Claims encoded in the JWT we issue after a successful Discord sign-in.
 *
 * The payload is deliberately SLIM (T-0047): it carries only stable identity
 * claims. Role, regiment and member id are NO LONGER embedded — they go stale
 * (e.g. `mid` the moment an approved applicant becomes a member) and are now
 * resolved fresh from the database on every request by SessionContextService
 * (T-0046). `iat`/`exp` are added automatically by the JWT layer; `iat` also
 * drives per-identity session invalidation (T-0048).
 */
export interface JwtPayload {
  /** discord_identities.id — the account record */
  sub: string;
  /** Discord user id (snowflake) */
  did: string;
  /** issued-at, epoch seconds (added by the JWT layer; read for the iat cutoff) */
  iat?: number;
  /** expiry, epoch seconds (added by the JWT layer) */
  exp?: number;
}
