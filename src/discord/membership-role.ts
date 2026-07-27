import { MemberRole } from '../common/enums';
import { Member } from '../members/entities/member.entity';

/**
 * Who carries the regiment's single "Member" Discord role (T-0191).
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * The guild has a role per rank, and hanging channel permissions off twelve
 * rank roles is unmaintainable. The regiment's answer is one flat `Member` role
 * that every enrolled member carries regardless of rank, so permissions are set
 * once. That only works if the role actually MEANS "enrolled" — which is
 * precisely what the old `joinRoleId` did not, because it was handed to every
 * account that walked into the guild.
 *
 * ── THE TWO EXCLUSIONS ──────────────────────────────────────────────────────
 * `Mercenary` — a mercenary fights alongside the regiment without being of it.
 * That distinction is the whole reason the regiment runs a separate enlistment
 * track for them, so the role that says "one of us" is exactly the wrong thing
 * to hand them.
 *
 * `Applicant` — an application in flight is not a membership. An applicant has
 * no member row at all in the normal case (`AuthService` derives the role for a
 * bare identity), but `members.role` DEFAULTS to `Applicant`, so a row written
 * without an explicit role would otherwise be granted membership by omission.
 *
 * A banned member never reaches here: the reconcile returns early on `bannedAt`
 * so a ban strip is not undone. That is deliberately NOT restated as a clause
 * below — a predicate that silently depended on a caller's early return would
 * be wrong the first time someone called it from anywhere else, so it is
 * checked here too.
 */
const MEMBERSHIP_ROLES: readonly MemberRole[] = [
  MemberRole.Owner,
  MemberRole.Admin,
  MemberRole.Moderator,
  MemberRole.Member,
];

/**
 * Whether this roster row is one the Membership role belongs on.
 *
 * An ALLOW-LIST, not a deny-list of the two excluded roles: a role added to
 * {@link MemberRole} later defaults to NOT holding the regiment's membership
 * marker, which is the safe direction to be wrong in.
 */
export function holdsMembershipRole(member: Pick<Member, 'role' | 'bannedAt'>): boolean {
  if (member.bannedAt) return false;
  return MEMBERSHIP_ROLES.includes(member.role);
}
