import { ForbiddenException } from '@nestjs/common';
import { Capability, MemberRole } from '../common/enums';

/**
 * The target-scoped member admin actions (T-0176). Every one of them moderates
 * ANOTHER member, so every one of them is subject to the hierarchy rule below —
 * unlike the self-service profile edit or the GDPR endpoints, where the actor
 * and the target are the same person by construction.
 *
 * The list is also the key set of `MemberDto.permittedActions` (T-0177): the
 * flags the client reads and the guard the service enforces are derived from
 * this one array, so a new action cannot be added to one and forgotten in the
 * other.
 */
export const MEMBER_ADMIN_ACTIONS = [
  'changeRole',
  'changeRank',
  'awardMedal',
  'removeMedal',
  'suspend',
  'unsuspend',
  'ban',
  'unban',
] as const;

/** One of the eight target-scoped member admin actions. */
export type MemberAdminAction = (typeof MEMBER_ADMIN_ACTIONS)[number];

/** Which admin actions a caller may perform against one specific member. */
export type PermittedActions = Record<MemberAdminAction, boolean>;

/**
 * The capability each action's route requires. Mirrors the `@RequireCapability`
 * decorators on MembersController — it exists so the permitted-action flags can
 * account for the capability gate as well as the hierarchy, and must be kept in
 * step with the controller (the specs pin the pairing).
 */
export const ACTION_CAPABILITY: Record<MemberAdminAction, Capability> = {
  changeRole: Capability.ManageRoles,
  changeRank: Capability.EditRanksMedals,
  awardMedal: Capability.EditRanksMedals,
  removeMedal: Capability.EditRanksMedals,
  suspend: Capability.ManageRoles,
  unsuspend: Capability.ManageRoles,
  ban: Capability.ManageRoles,
  unban: Capability.ManageRoles,
};

/**
 * The distinct capabilities the eight actions draw on, so a caller resolving
 * the flags for a whole roster page asks the authz matrix twice rather than
 * once per row per action (T-0177: no extra query on the list endpoint).
 */
export const MEMBER_ADMIN_CAPABILITIES: readonly Capability[] = [
  Capability.ManageRoles,
  Capability.EditRanksMedals,
];

/**
 * The role ladder, most senior first. The values are opaque — only their
 * ORDER is meaningful — and they are spaced so a tier can be inserted without
 * renumbering. `MemberRole`'s declaration order already reads this way, but
 * nothing enforces that an enum stays declared in precedence order, so the
 * ladder is stated explicitly here rather than inferred from `Object.values`.
 *
 * Mercenary sits strictly BELOW Member: a mercenary rides along with the
 * regiment but is not one of its members (the seeded matrix already treats them
 * that way — they are excluded from gallery submission).
 */
export const ROLE_PRECEDENCE: Record<MemberRole, number> = {
  [MemberRole.Owner]: 50,
  [MemberRole.Admin]: 40,
  [MemberRole.Moderator]: 30,
  [MemberRole.Member]: 20,
  [MemberRole.Mercenary]: 10,
  [MemberRole.Applicant]: 0,
};

/**
 * True when `actorRole` sits STRICTLY above `targetRole`. Strictly, so peers
 * cannot moderate each other: an Admin may not demote or ban another Admin —
 * only the Owner can. That mirrors the self-action ban (T-0150), which exists
 * for the same reason: a seat holder must not be able to remove an equal (or
 * themselves) and hollow out the regiment's command from the inside.
 */
export function outranks(actorRole: MemberRole, targetRole: MemberRole): boolean {
  return ROLE_PRECEDENCE[actorRole] > ROLE_PRECEDENCE[targetRole];
}

/**
 * True when `actorRole` may hand out `grantedRole` — at or below their own tier
 * (T-0203).
 *
 * NOT strict, unlike {@link outranks}: holding `manage_roles` is exactly what
 * makes a role able to appoint its own kind, so an Admin who holds it may
 * appoint another Admin and a Moderator who holds it may appoint another
 * Moderator. What stays shut is ESCALATION — nobody mints a role above their
 * own, and no chain of appointments can either, because every appointee is
 * capped by this same ceiling. (Owner never reaches here: `changeRole` refuses
 * it outright, since no API path assigns ownership.)
 *
 * The asymmetry with {@link canActOn} is deliberate. Appointing a peer is
 * additive; moderating one is not. So an Admin may raise a Member to Admin, but
 * still cannot demote, suspend or ban that Admin afterwards — only the Owner
 * can. A seat holder can widen the command, never hollow it out.
 */
export function canGrantRole(actorRole: MemberRole, grantedRole: MemberRole): boolean {
  return ROLE_PRECEDENCE[grantedRole] <= ROLE_PRECEDENCE[actorRole];
}

/** The minimum a moderation target must expose for the hierarchy check. */
export interface HierarchyTarget {
  id: string;
  role: MemberRole;
}

/** Everything the hierarchy rule needs — no repository, no I/O. */
export interface ActOnCheck {
  /** The caller's role, as resolved onto their session context. */
  actorRole: MemberRole;
  /** The caller's member id — null for an identity-only (unenrolled) caller. */
  actorMemberId: string | null;
  /** The member being acted on. */
  target: HierarchyTarget;
  /** `regiments.owner_member_id` — the authoritative owner pointer, or null. */
  ownerMemberId: string | null;
}

/** Why an action was refused, or null when the hierarchy permits it. */
type Denial = 'self' | 'owner' | 'rank';

/**
 * The single rule. Order matters only for the error message: self and owner are
 * both also caught by the rank comparison (an actor never strictly outranks
 * their own role, and the owner holds the top tier), but each deserves its own
 * explanation.
 */
function denyReason({
  actorRole,
  actorMemberId,
  target,
  ownerMemberId,
}: ActOnCheck): Denial | null {
  if (actorMemberId && actorMemberId === target.id) return 'self';
  // The regiment owner pointer is the stricter, authoritative guard: it holds
  // even if the owner's ROLE has drifted from the pointer, and it protects them
  // from a same-tier Owner too. Nobody moderates the owner.
  if (ownerMemberId && ownerMemberId === target.id) return 'owner';
  if (!outranks(actorRole, target.role)) return 'rank';
  return null;
}

/**
 * Pure, synchronous: may this caller perform a target-scoped admin action on
 * this member? Says nothing about CAPABILITY — the caller still has to hold the
 * action's capability (the controller guard enforces that, and
 * {@link permittedActions} folds it in for the projection).
 */
export function canActOn(check: ActOnCheck): boolean {
  return denyReason(check) === null;
}

/**
 * Per-action wording. `self` completes "You cannot …" (preserving the phrasing
 * the self-guard has used since T-0150); `target` completes "You cannot … the
 * regiment owner" / "… a member of equal or higher standing".
 */
const ACTION_LABELS: Record<MemberAdminAction, { self: string; target: string }> = {
  changeRole: { self: 'change your own role', target: "change the regiment owner's role" },
  changeRank: { self: 'change your own rank', target: "change the regiment owner's rank" },
  awardMedal: { self: 'award yourself a medal', target: 'award the regiment owner a medal' },
  removeMedal: { self: 'remove your own medal', target: "remove the regiment owner's medal" },
  suspend: { self: 'suspend your own account', target: 'suspend the regiment owner' },
  unsuspend: { self: 'lift your own suspension', target: "lift the regiment owner's suspension" },
  ban: { self: 'ban your own account', target: 'ban the regiment owner' },
  unban: { self: 'lift your own ban', target: "lift the regiment owner's ban" },
};

/**
 * Throwing form of {@link canActOn} (T-0176). Call it BEFORE any write, so a
 * rejected action leaves no audit row, no service-record entry, no Discord sync
 * job and no session invalidation — the ordering invariant the self-guard
 * established in T-0150.
 */
export function assertCanActOn(check: ActOnCheck, action: MemberAdminAction): void {
  const reason = denyReason(check);
  if (!reason) return;
  const labels = ACTION_LABELS[action];
  if (reason === 'self') {
    throw new ForbiddenException(`You cannot ${labels.self}`);
  }
  if (reason === 'owner') {
    throw new ForbiddenException(`You cannot ${labels.target}`);
  }
  throw new ForbiddenException(
    'You cannot moderate a member whose role equals or outranks your own',
  );
}

/**
 * The `permittedActions` block for one target (T-0177), derived from the SAME
 * predicate the endpoints enforce so the UI can never drift from the server
 * rule: a flag is true only when BOTH the hierarchy allows the action and the
 * caller holds the capability its route requires.
 *
 * @param heldCapabilities the capability keys the caller holds — resolve it once
 *   per request (see MEMBER_ADMIN_CAPABILITIES), never once per row.
 */
export function permittedActions(
  check: ActOnCheck,
  heldCapabilities: ReadonlySet<string>,
): PermittedActions {
  const allowed = canActOn(check);
  const flags = {} as PermittedActions;
  for (const action of MEMBER_ADMIN_ACTIONS) {
    flags[action] = allowed && heldCapabilities.has(ACTION_CAPABILITY[action]);
  }
  return flags;
}
