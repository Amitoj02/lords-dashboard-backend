import { ForbiddenException } from '@nestjs/common';
import { Capability, MemberRole } from '../common/enums';
import {
  ACTION_CAPABILITY,
  MEMBER_ADMIN_ACTIONS,
  ROLE_PRECEDENCE,
  assertCanActOn,
  canActOn,
  outranks,
  permittedActions,
} from './member-hierarchy';

/**
 * The pure half of the member role hierarchy (T-0176). MembersService proves the
 * guard fires on every action; this pins the RULE itself, which the service
 * spec can only observe indirectly.
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

  describe('canActOn', () => {
    it('permits an actor who strictly outranks the target', () => {
      expect(canActOn(check({ actorRole: MemberRole.Moderator }))).toBe(true);
    });

    it('refuses the caller acting on themselves', () => {
      expect(canActOn(check({ actorMemberId: 'actor-1', targetId: 'actor-1' }))).toBe(false);
    });

    it('refuses anyone acting on the regiment owner pointer, including the Owner role', () => {
      // The pointer is authoritative even when the target's ROLE says otherwise
      // — an owner whose role has drifted is still the owner.
      expect(
        canActOn(
          check({
            actorRole: MemberRole.Owner,
            targetId: 'owner-member',
            targetRole: MemberRole.Member,
          }),
        ),
      ).toBe(false);
    });

    it('refuses an actor of equal or lower standing', () => {
      expect(canActOn(check({ actorRole: MemberRole.Admin, targetRole: MemberRole.Admin }))).toBe(
        false,
      );
      expect(
        canActOn(check({ actorRole: MemberRole.Moderator, targetRole: MemberRole.Owner })),
      ).toBe(false);
    });

    it('refuses an identity-only caller with no member row', () => {
      expect(canActOn(check({ actorMemberId: null, actorRole: MemberRole.Applicant }))).toBe(false);
    });
  });

  describe('assertCanActOn', () => {
    it('throws with the self wording preserved from T-0150', () => {
      expect(() => assertCanActOn(check({ targetId: 'actor-1' }), 'ban')).toThrow(
        'You cannot ban your own account',
      );
    });

    it('names the owner when the owner pointer is the reason', () => {
      expect(() => assertCanActOn(check({ targetId: 'owner-member' }), 'suspend')).toThrow(
        ForbiddenException,
      );
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

    it('is all-false whenever the hierarchy refuses, whatever the caller holds', () => {
      const held = new Set<string>([Capability.ManageRoles, Capability.EditRanksMedals]);
      const flags = permittedActions(check({ targetRole: MemberRole.Owner }), held);

      expect(Object.values(flags).some(Boolean)).toBe(false);
    });

    it('exposes exactly the eight actions, each mapped to the capability its route requires', () => {
      const flags = permittedActions(check({}), new Set<string>());

      expect(Object.keys(flags).sort()).toEqual([...MEMBER_ADMIN_ACTIONS].sort());
      // The pairing the controller decorators declare (T-0177).
      expect(ACTION_CAPABILITY.changeRole).toBe(Capability.ManageRoles);
      expect(ACTION_CAPABILITY.changeRank).toBe(Capability.EditRanksMedals);
    });
  });
});
