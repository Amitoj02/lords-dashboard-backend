import { ForbiddenException } from '@nestjs/common';
import { Capability, MemberRole } from '../common/enums';
import {
  ACTION_CAPABILITY,
  DECORATION_ACTIONS,
  MEMBER_ADMIN_ACTIONS,
  MODERATION_ACTIONS,
  ROLE_PRECEDENCE,
  assertCanActOn,
  canActOn,
  canGrantRole,
  outranks,
  permittedActions,
} from './member-hierarchy';

/**
 * The pure half of the member role hierarchy (T-0176). MembersService proves the
 * guard fires on every action; this pins the RULES themselves, which the service
 * spec can only observe indirectly.
 *
 * Two rules since T-0211, and both are pinned here: the MODERATION actions
 * (role, suspend, ban) keep self + owner + strictly-outranks, while the
 * DECORATION actions (rank, medals, derive) have no target rule at all. Nearly
 * every case below is therefore stated per family — a test that fans over all
 * nine actions is now asserting something about the split itself.
 */
describe('member hierarchy (T-0176)', () => {
  const check = (overrides: {
    actorRole?: MemberRole;
    actorMemberId?: string | null;
    targetId?: string;
    targetRole?: MemberRole;
    ownerMemberId?: string | null;
  }) => ({
    actorRole: overrides.actorRole ?? MemberRole.Admin,
    actorMemberId: overrides.actorMemberId ?? 'actor-1',
    target: {
      id: overrides.targetId ?? 'target-1',
      role: overrides.targetRole ?? MemberRole.Member,
    },
    ownerMemberId: overrides.ownerMemberId ?? 'owner-member',
  });

  describe('outranks', () => {
    it('orders the ladder Owner > Admin > Moderator > Member > Mercenary > Applicant', () => {
      const ladder = [
        MemberRole.Owner,
        MemberRole.Admin,
        MemberRole.Moderator,
        MemberRole.Member,
        MemberRole.Mercenary,
        MemberRole.Applicant,
      ];
      const precedences = ladder.map((role) => ROLE_PRECEDENCE[role]);
      expect(precedences).toEqual([...precedences].sort((a, b) => b - a));
      // Distinct tiers: no two roles may collide, or "strictly outranks" would
      // silently permit a peer action between them.
      expect(new Set(precedences).size).toBe(ladder.length);
    });

    it('is strict, so a peer never outranks a peer', () => {
      expect(outranks(MemberRole.Admin, MemberRole.Admin)).toBe(false);
      expect(outranks(MemberRole.Owner, MemberRole.Admin)).toBe(true);
      expect(outranks(MemberRole.Moderator, MemberRole.Admin)).toBe(false);
      expect(outranks(MemberRole.Member, MemberRole.Mercenary)).toBe(true);
    });

    it('covers every role in the enum (a new role cannot be left off the ladder)', () => {
      for (const role of Object.values(MemberRole)) {
        expect(typeof ROLE_PRECEDENCE[role]).toBe('number');
      }
    });
  });

  describe('canGrantRole (T-0203)', () => {
    it('lets a manage_roles holder appoint their own kind', () => {
      expect(canGrantRole(MemberRole.Admin, MemberRole.Admin)).toBe(true);
      expect(canGrantRole(MemberRole.Moderator, MemberRole.Moderator)).toBe(true);
    });

    it('still refuses a role above the caller’s own', () => {
      expect(canGrantRole(MemberRole.Moderator, MemberRole.Admin)).toBe(false);
      expect(canGrantRole(MemberRole.Admin, MemberRole.Owner)).toBe(false);
      expect(canGrantRole(MemberRole.Member, MemberRole.Moderator)).toBe(false);
    });

    it('permits everything below', () => {
      expect(canGrantRole(MemberRole.Admin, MemberRole.Moderator)).toBe(true);
      expect(canGrantRole(MemberRole.Admin, MemberRole.Applicant)).toBe(true);
      expect(canGrantRole(MemberRole.Owner, MemberRole.Admin)).toBe(true);
    });

    it('is a ceiling no chain of appointments can climb', () => {
      // The property that makes the peer grant safe: an appointee is capped by
      // the same rule, so collusion only ever widens a tier, never raises one.
      for (const actor of Object.values(MemberRole)) {
        for (const granted of Object.values(MemberRole)) {
          if (!canGrantRole(actor, granted)) continue;
          expect(ROLE_PRECEDENCE[granted]).toBeLessThanOrEqual(ROLE_PRECEDENCE[actor]);
        }
      }
    });

    it('is the complement of outranks, so the two can never disagree', () => {
      for (const actor of Object.values(MemberRole)) {
        for (const granted of Object.values(MemberRole)) {
          expect(canGrantRole(actor, granted)).toBe(!outranks(granted, actor));
        }
      }
    });
  });

  describe('the two families', () => {
    it('partitions the nine actions, with nothing left over and nothing in both', () => {
      // Derived by subtraction from MEMBER_ADMIN_ACTIONS, so a tenth action is a
      // MODERATION action until someone declares it a decoration: new actions
      // get the strict rule by default (fail closed).
      expect([...DECORATION_ACTIONS, ...MODERATION_ACTIONS].sort()).toEqual(
        [...MEMBER_ADMIN_ACTIONS].sort(),
      );
      const decorations: readonly string[] = DECORATION_ACTIONS;
      expect(MODERATION_ACTIONS.some((action) => decorations.includes(action))).toBe(false);
    });

    it('puts every rank/medal write on the decoration side and nothing else', () => {
      expect([...DECORATION_ACTIONS].sort()).toEqual(
        ['awardMedal', 'changeRank', 'deriveFromDiscord', 'removeMedal'].sort(),
      );
      // The pairing is what makes the relaxation safe to describe as "the
      // edit_ranks_medals actions": every decoration action draws on that one
      // capability, so nothing was let through on a manage_roles grant.
      for (const action of DECORATION_ACTIONS) {
        expect(ACTION_CAPABILITY[action]).toBe(Capability.EditRanksMedals);
      }
    });
  });

  describe('canActOn', () => {
    it.each(MEMBER_ADMIN_ACTIONS)('permits an actor who strictly outranks the target (%s)', (a) => {
      expect(canActOn(check({ actorRole: MemberRole.Moderator }), a)).toBe(true);
    });

    it.each(MODERATION_ACTIONS)('refuses the caller moderating themselves (%s)', (action) => {
      // T-0150: a seat holder must not be able to remove themselves and hollow
      // out a seat only they occupy.
      expect(canActOn(check({ actorMemberId: 'actor-1', targetId: 'actor-1' }), action)).toBe(
        false,
      );
    });

    it.each(DECORATION_ACTIONS)('but permits decorating YOURSELF (%s)', (action) => {
      // ⚠️ An owner decision (T-0211), and the sharpest edge of it. With the self
      // refusal gone, `deriveFromDiscord` on your own record credits whatever
      // your own Discord roles say you have earned — the trigger for which lives
      // in the guild, outside this application. Nothing in this module bounds it
      // any more; the capability grant is the whole control.
      expect(canActOn(check({ actorMemberId: 'actor-1', targetId: 'actor-1' }), action)).toBe(true);
    });

    it.each(MODERATION_ACTIONS)(
      'refuses anyone moderating the regiment owner pointer, including the Owner role (%s)',
      (action) => {
        // The pointer is authoritative even when the target's ROLE says otherwise
        // — an owner whose role has drifted is still the owner.
        expect(
          canActOn(
            check({
              actorRole: MemberRole.Owner,
              targetId: 'owner-member',
              targetRole: MemberRole.Member,
            }),
            action,
          ),
        ).toBe(false);
      },
    );

    it.each(DECORATION_ACTIONS)(
      'but permits decorating the regiment owner — a rank is not authority (%s)',
      (action) => {
        expect(canActOn(check({ targetId: 'owner-member' }), action)).toBe(true);
      },
    );

    it.each(MODERATION_ACTIONS)('refuses an actor of equal or lower standing (%s)', (action) => {
      expect(
        canActOn(check({ actorRole: MemberRole.Admin, targetRole: MemberRole.Admin }), action),
      ).toBe(false);
      expect(
        canActOn(check({ actorRole: MemberRole.Moderator, targetRole: MemberRole.Owner }), action),
      ).toBe(false);
    });

    it.each(DECORATION_ACTIONS)(
      'but permits decorating a peer or a superior — the headline of T-0211 (%s)',
      (action) => {
        expect(
          canActOn(check({ actorRole: MemberRole.Admin, targetRole: MemberRole.Admin }), action),
        ).toBe(true);
        expect(
          canActOn(
            check({ actorRole: MemberRole.Moderator, targetRole: MemberRole.Admin }),
            action,
          ),
        ).toBe(true);
        expect(
          canActOn(
            check({ actorRole: MemberRole.Moderator, targetRole: MemberRole.Owner }),
            action,
          ),
        ).toBe(true);
      },
    );

    it.each(MODERATION_ACTIONS)('refuses an identity-only caller with no member row (%s)', (a) => {
      expect(canActOn(check({ actorMemberId: null, actorRole: MemberRole.Applicant }), a)).toBe(
        false,
      );
    });

    it('leaves the CAPABILITY as the only gate on the decoration half', () => {
      // ⚠️ Stated as an EXPOSURE, not a reassurance. With no target rule left,
      // this module says yes to every decoration for every caller — an Applicant,
      // an identity-only caller with no member row, anyone. Holding the grant is
      // the whole control, so the assertion that matters is the positive one:
      // edit_ranks_medals alone turns the flag on.
      const applicant = check({ actorMemberId: null, actorRole: MemberRole.Applicant });
      for (const action of DECORATION_ACTIONS) {
        expect(canActOn(applicant, action)).toBe(true);
        expect(permittedActions(applicant, new Set([Capability.EditRanksMedals]))[action]).toBe(
          true,
        );
        expect(permittedActions(applicant, new Set([Capability.ManageRoles]))[action]).toBe(false);
      }
    });
  });

  describe('assertCanActOn', () => {
    it('throws with the self wording preserved from T-0150', () => {
      expect(() => assertCanActOn(check({ targetId: 'actor-1' }), 'ban')).toThrow(
        'You cannot ban your own account',
      );
    });

    it('has no self wording left for the decoration actions — and cannot grow one', () => {
      // SELF_REFUSALS is keyed on ModerationAction, so there is no sentence to
      // print for these four and the type system is what keeps it that way.
      for (const action of DECORATION_ACTIONS) {
        expect(() => assertCanActOn(check({ targetId: 'actor-1' }), action)).not.toThrow();
      }
    });

    it('names the owner when the owner pointer is the reason', () => {
      expect(() => assertCanActOn(check({ targetId: 'owner-member' }), 'suspend')).toThrow(
        ForbiddenException,
      );
    });

    it('says nothing about the owner on a decoration action — there is nothing to say', () => {
      // The wording cannot drift out of step with the rule: OWNER_REFUSALS is
      // keyed on ModerationAction, so a decoration action has no owner sentence
      // to print and the type system is what keeps it that way.
      for (const action of DECORATION_ACTIONS) {
        expect(() => assertCanActOn(check({ targetId: 'owner-member' }), action)).not.toThrow();
      }
    });

    it('is silent when the action is permitted', () => {
      expect(() => assertCanActOn(check({}), 'changeRank')).not.toThrow();
    });
  });

  describe('permittedActions', () => {
    it('requires BOTH the hierarchy and the action’s capability', () => {
      const held = new Set<string>([Capability.EditRanksMedals]);
      const flags = permittedActions(check({}), held);

      // edit_ranks_medals only ⇒ the four manage_roles actions stay false even
      // though the hierarchy would allow them.
      expect(flags.changeRank).toBe(true);
      expect(flags.awardMedal).toBe(true);
      expect(flags.removeMedal).toBe(true);
      expect(flags.changeRole).toBe(false);
      expect(flags.suspend).toBe(false);
      expect(flags.ban).toBe(false);
      expect(flags.unban).toBe(false);
      expect(flags.unsuspend).toBe(false);
    });

    it('splits the block per action against a superior — moderation false, decoration true', () => {
      const held = new Set<string>([Capability.ManageRoles, Capability.EditRanksMedals]);
      const flags = permittedActions(check({ targetRole: MemberRole.Owner }), held);

      // The shape T-0211 introduced, and the one the client had never seen: a
      // single target whose block genuinely mixes true and false.
      for (const action of MODERATION_ACTIONS)
        expect(`${action}=${flags[action]}`).toBe(`${action}=false`);
      for (const action of DECORATION_ACTIONS)
        expect(`${action}=${flags[action]}`).toBe(`${action}=true`);
    });

    it('splits the block on your OWN record too — decorations on, moderation off', () => {
      const held = new Set<string>([Capability.ManageRoles, Capability.EditRanksMedals]);
      const flags = permittedActions(check({ actorMemberId: 'me', targetId: 'me' }), held);

      // Your own row now offers the rank and medal controls (T-0211) while still
      // withholding the moderation ones — which is the state T-0246's
      // disabled-and-explained self treatment was written for, reachable at last.
      for (const action of MODERATION_ACTIONS)
        expect(`self.${action}=${flags[action]}`).toBe(`self.${action}=false`);
      for (const action of DECORATION_ACTIONS)
        expect(`self.${action}=${flags[action]}`).toBe(`self.${action}=true`);
    });

    it('is all-false on the owner pointer when the caller holds only manage_roles', () => {
      const flags = permittedActions(
        check({ targetId: 'owner-member' }),
        new Set([Capability.ManageRoles]),
      );

      expect(Object.values(flags).some(Boolean)).toBe(false);
    });

    it('exposes exactly the nine actions, each mapped to the capability its route requires', () => {
      const flags = permittedActions(check({}), new Set<string>());

      expect(Object.keys(flags).sort()).toEqual([...MEMBER_ADMIN_ACTIONS].sort());
      // The pairing the controller decorators declare (T-0177).
      expect(ACTION_CAPABILITY.changeRole).toBe(Capability.ManageRoles);
      expect(ACTION_CAPABILITY.changeRank).toBe(Capability.EditRanksMedals);
    });
  });
});
