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
 * a rank or a medal get the self refusal and nothing else. See
 * {@link DECORATION_ACTIONS}.
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
 * That is why these four answer to their CAPABILITY alone (plus the self
 * refusal below). Holding `edit_ranks_medals` is the regiment saying "this
 * person keeps the service record"; a record-keeper who cannot enter an Admin's
 * promotion, or pin a medal on the Owner, cannot keep the record. Before this
 * the whole set sat behind the moderation rule, so a Moderator with the
 * capability was refused against every peer and superior on the roster.
 *
 * `deriveFromDiscord` belongs here because it writes exactly a rank and medal
 * awards — the same two things, read off the guild instead of typed by hand.
 * Its self refusal is the load-bearing one and is unaffected: deriving your own
 * record is a self-promotion available to anyone who can get a role added to
 * their own account in the guild.
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
 * The SELF refusal, per action — "You cannot …" completed (the phrasing the
 * self-guard has used since T-0150). Every action has one: nobody moderates
 * themselves, and nobody decorates themselves either.
 *
 * ⚠️ For `deriveFromDiscord` this is the load-bearing refusal (LDA-H1). A derive
 * hands out whatever rank and medals the target's Discord roles say they have
 * earned — so on your own record it is a self-promotion, available to anyone who
 * can get a role added to their own account in the guild. Nobody derives
 * themselves, the Owner included; another admin does it for them.
 */
const SELF_REFUSALS: Record<MemberAdminAction, string> = {
  changeRole: 'change your own role',
  changeRank: 'change your own rank',
  awardMedal: 'award yourself a medal',
  removeMedal: 'remove your own medal',
  suspend: 'suspend your own account',
  unsuspend: 'lift your own suspension',
  ban: 'ban your own account',
  unban: 'lift your own ban',
  deriveFromDiscord: 'derive your own rank and medals from Discord',
};

/**
 * The OWNER refusal, per action. Keyed on {@link ModerationAction}, so it holds
 * an entry for exactly the actions that can reach it — a decoration action is
 * cleared before the owner check, and TypeScript will not let one be given
 * wording it can never show (T-0211).
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
 * The single rule, as the sentence it refuses with (null = permitted). The
 * message is built here rather than by the caller because only here is it known
 * which refusals an action can even reach.
 *
 * Order is the rule, not just the wording:
 *
 *  1. SELF, for everything. Self and owner would both also be caught by the rank
 *     comparison below (an actor never strictly outranks their own role, and the
 *     owner holds the top tier), but each deserves its own explanation — and for
 *     a decoration action this is now the ONLY thing standing between the caller
 *     and their own record.
 *  2. DECORATIONS STOP HERE (T-0211). Rank and medals are not authority, so past
 *     the self refusal they answer to the capability alone — see
 *     {@link DECORATION_ACTIONS}.
 *  3. OWNER, for the rest: the regiment owner pointer is the stricter,
 *     authoritative guard — it holds even if the owner's ROLE has drifted from
 *     the pointer, and it protects them from a same-tier Owner too.
 *  4. STANDING, for the rest: strictly outranking, so peers cannot moderate each
 *     other.
 */
function denyReason(
  { actorRole, actorMemberId, target, ownerMemberId }: ActOnCheck,
  action: MemberAdminAction,
): string | null {
  if (actorMemberId && actorMemberId === target.id) {
    return `You cannot ${SELF_REFUSALS[action]}`;
  }
  if (isDecorationAction(action)) return null;
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
