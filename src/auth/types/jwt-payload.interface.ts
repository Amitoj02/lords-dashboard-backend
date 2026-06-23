import { MemberRole } from '../../common/enums';

/** Claims encoded in the JWT we issue after a successful Discord sign-in. */
export interface JwtPayload {
  /** discord_identities.id — the account record */
  sub: string;
  /** members.id, or null when the identity has no roster member yet */
  mid: string | null;
  /** Discord user id (snowflake) */
  did: string;
  role: MemberRole;
  /** regiment id (single-tenant today) */
  rid: string;
}
