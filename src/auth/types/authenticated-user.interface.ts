import { MemberRole } from '../../common/enums';

/** The `request.user` shape attached by JwtStrategy after validation. */
export interface AuthenticatedUser {
  identityId: string;
  memberId: string | null;
  discordUserId: string;
  role: MemberRole;
  regimentId: string;
}
