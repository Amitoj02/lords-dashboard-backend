import { ForbiddenException } from '@nestjs/common';
import { Capability, MemberRole } from '../common/enums';

/**
 * The target-scoped member admin actions (T-0176). Every one of them acts on
 * ANOTHER member, so every one of them is subject to a target-scoped rule —
 * unlike the self-service profile edit or the GDPR endpoints, where the actor
 * and the target are the same person by construction.
 *
 * They are NOT all subject to the same rule. The set splits in two (T-0211):
 * the ones that move authority get the full hierarchy, the ones that only write
 * a rank or a medal get no target rule at all. See {@link DECORATION_ACTIONS}.
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
  'deriveFromDiscord',
] as const;

/** One of the target-scoped member admin actions. */
export type MemberAdminAction = (typeof MEMBER_ADMIN_ACTIONS)[number];

/**
 * The DECORATION half (T-0211): the actions that write a rank and medal awards
 * and nothing else. No authority moves, no access is revoked, no session is
 * invalidated — a rank and a medal are a record of what a member has done, not
 * a statement of what they may do.
 *
 * These four have NO target-scoped rule at all. They answer to their capability
 * and stop: `edit_ranks_medals` is the regiment saying "this person keeps the
 * service record", and it is kept for the whole roster — peers, seniors, the
 * regiment owner, and the record-keeper's own row. Before T-0211 the whole set
 * sat behind the moderation rule, so a Moderator trusted with the capability
 * was refused against most of the people whose promotions are worth recording.
 *
 * `deriveFromDiscord` belongs here because it writes exactly a rank and medal
 * awards — the same two things, read off the guild instead of typed by hand.
 *
 * ⚠️ SELF IS PERMITTED HERE, INCLUDING FOR THE DERIVE — an owner decision, taken
 * with the consequence stated. The self refusal on these four was the last
 * defence of LDA-H1: a derive hands out whatever the target's Discord roles say
 * they have earned, so on your own record it is a self-promotion reachable by
 * anyone who can get a role added to their own account in the guild, outside
 * this application entirely. What still bounds it: the capability itself (not
 * granted below Admin by default), the promotion-only floor and additive-only
 * medal diff in the derive path, `DiscordRolePolicyService`'s refusal to bind a
 * role the bot cannot manage, and the audit row every write leaves. What does
 * NOT bound it is this module. Granting `edit_ranks_medals` now means granting
 * the holder their own rank.
 */
export const DECORATION_ACTIONS = [
  'changeRank',
  'awardMedal',
  'removeMedal',
  'deriveFromDiscord',
] as const satisfies readonly MemberAdminAction[];

/** One of the rank/medal actions. */
export type DecorationAction = (typeof DECORATION_ACTIONS)[number];

/**
 * Everything else: the actions that move authority or access — role, suspension,
 * ban. These keep the full rule (not yourself, not the owner, only strictly
 * below you), and the split is derived rather than listed twice, so a new entry
 * in {@link MEMBER_ADMIN_ACTIONS} is a moderation action until it is explicitly
 * declared a decoration. New actions fail CLOSED.
 */
export type ModerationAction = Exclude<MemberAdminAction, DecorationAction>;

const DECORATION_ACTION_SET: ReadonlySet<string> = new Set<string>(DECORATION_ACTIONS);

/** True for the rank/medal actions — see {@link DECORATION_ACTIONS}. */
export function isDecorationAction(action: MemberAdminAction): action is DecorationAction {
  return DECORATION_ACTION_SET.has(action);
}

/**
 * {@link ModerationAction} as a value, for the callers that need to WALK the
 * moderation half (the specs fan over it). Derived by subtraction from the same
 * two lists the type is, so the value and the type cannot disagree and a new
 * action lands here without being added anywhere.
 */
export const MODERATION_ACTIONS: readonly ModerationAction[] = MEMBER_ADMIN_ACTIONS.filter(
  (action): action is ModerationAction => !isDecorationAction(action),
);

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
  // Deriving writes a rank and medal awards, so it draws on the capability that
  // gates writing them by hand — no third capability for the same effect.
  deriveFromDiscord: Capability.EditRanksMedals,
};

/**
 * The distinct capabilities the actions draw on, so a caller resolving the flags
 * for a whole roster page asks the authz matrix twice rather than once per row
 * per action (T-0177: no extra query on the list endpoint).
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
 *
 * Scoped to the moderation actions since T-0211 — a rank or a medal is not a
 * seat, so awarding one to a peer takes nothing away from anyone.
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

/** The minimum a target must expose for the check (`role` is read by the moderation half only). */
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

/**
 * The SELF refusal — "You cannot …" completed (the phrasing the self-guard has
 * used since T-0150). Nobody moderates themselves: otherwise a non-owner Admin
 * holding `manage_roles` could demote or ban their own account and lock the
 * regiment out of a seat only they occupy.
 *
 * Keyed on {@link ModerationAction}, because that is now the whole of it — the
 * rank/medal actions carry no self refusal (T-0211), and the type is what keeps
 * one from being written for an action that would never show it.
 */
const SELF_REFUSALS: Record<ModerationAction, string> = {
  changeRole: 'change your own role',
  suspend: 'suspend your own account',
  unsuspend: 'lift your own suspension',
  ban: 'ban your own account',
  unban: 'lift your own ban',
};

/**
 * The OWNER refusal, per action. Keyed on {@link ModerationAction} for the same
 * reason — a decoration action is cleared before this check is reached, and
 * TypeScript will not let one be given wording it can never show (T-0211).
 */
const OWNER_REFUSALS: Record<ModerationAction, string> = {
  changeRole: "change the regiment owner's role",
  suspend: 'suspend the regiment owner',
  unsuspend: "lift the regiment owner's suspension",
  ban: 'ban the regiment owner',
  unban: "lift the regiment owner's ban",
};

/** The standing refusal, shared by every moderation action. */
const RANK_REFUSAL = 'You cannot moderate a member whose role equals or outranks your own';

/**
 * The rule, as the sentence it refuses with (null = permitted). The message is
 * built here rather than by the caller because only here is it known which
 * refusals an action can even reach.
 *
 *  1. DECORATIONS ARE NOT ASKED (T-0211). Rank and medals answer to the
 *     capability alone — no self refusal, no owner refusal, no standing
 *     comparison. See {@link DECORATION_ACTIONS} for what that gives away and
 *     what still bounds it.
 *  2. SELF, for the moderation actions. Self and owner would both also be caught
 *     by the standing comparison below (an actor never strictly outranks their
 *     own role, and the owner holds the top tier), but each deserves its own
 *     explanation.
 *  3. OWNER: the regiment owner pointer is the stricter, authoritative guard —
 *     it holds even if the owner's ROLE has drifted from the pointer, and it
 *     protects them from a same-tier Owner too.
 *  4. STANDING: strictly outranking, so peers cannot moderate each other.
 *
 * The early return on line one is the whole of T-0211. Everything below it is
 * the rule exactly as T-0176 wrote it.
 */
function denyReason(
  { actorRole, actorMemberId, target, ownerMemberId }: ActOnCheck,
  action: MemberAdminAction,
): string | null {
  if (isDecorationAction(action)) return null;
  if (actorMemberId && actorMemberId === target.id) {
    return `You cannot ${SELF_REFUSALS[action]}`;
  }
  if (ownerMemberId && ownerMemberId === target.id) {
    return `You cannot ${OWNER_REFUSALS[action]}`;
  }
  if (!outranks(actorRole, target.role)) return RANK_REFUSAL;
  return null;
}

/**
 * Pure, synchronous: may this caller perform THIS target-scoped admin action on
 * this member? The action is part of the question (T-0211) — a rank change and a
 * ban are not asked the same thing. Says nothing about CAPABILITY: the caller
 * still has to hold the action's capability (the controller guard enforces that,
 * and {@link permittedActions} folds it in for the projection).
 */
export function canActOn(check: ActOnCheck, action: MemberAdminAction): boolean {
  return denyReason(check, action) === null;
}

/**
 * Throwing form of {@link canActOn} (T-0176). Call it BEFORE any write, so a
 * rejected action leaves no audit row, no service-record entry, no Discord sync
 * job and no session invalidation — the ordering invariant the self-guard
 * established in T-0150.
 */
export function assertCanActOn(check: ActOnCheck, action: MemberAdminAction): void {
  const message = denyReason(check, action);
  if (message) throw new ForbiddenException(message);
}

/**
 * The `permittedActions` block for one target (T-0177), derived from the SAME
 * predicate the endpoints enforce so the UI can never drift from the server
 * rule: a flag is true only when BOTH the hierarchy allows the action and the
 * caller holds the capability its route requires.
 *
 * Asked PER ACTION since T-0211 — the verdict is no longer one answer for the
 * whole block, so a peer Admin now reports `changeRank: true, ban: false` and
 * the dialog can offer the half that is real.
 *
 * @param heldCapabilities the capability keys the caller holds — resolve it once
 *   per request (see MEMBER_ADMIN_CAPABILITIES), never once per row.
 */
export function permittedActions(
  check: ActOnCheck,
  heldCapabilities: ReadonlySet<string>,
): PermittedActions {
  const flags = {} as PermittedActions;
  for (const action of MEMBER_ADMIN_ACTIONS) {
    flags[action] = canActOn(check, action) && heldCapabilities.has(ACTION_CAPABILITY[action]);
  }
  return flags;
}
