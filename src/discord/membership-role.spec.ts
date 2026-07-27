import { MemberRole } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { holdsMembershipRole } from './membership-role';

/**
 * T-0191. The Membership role is the one Discord role the regiment hangs its
 * channel permissions off, so "who holds it" is a security answer, not a
 * cosmetic one. These pin the two exclusions and the allow-list shape.
 */
describe('holdsMembershipRole', () => {
  const member = (overrides: Partial<Member> = {}) =>
    ({ role: MemberRole.Member, bannedAt: null, ...overrides }) as Member;

  it.each([[MemberRole.Owner], [MemberRole.Admin], [MemberRole.Moderator], [MemberRole.Member]])(
    'grants it to %s',
    (role) => {
      expect(holdsMembershipRole(member({ role }))).toBe(true);
    },
  );

  it('withholds it from a Mercenary — they fight alongside the regiment, not in it', () => {
    expect(holdsMembershipRole(member({ role: MemberRole.Mercenary }))).toBe(false);
  });

  it('withholds it from an Applicant — an application in flight is not a membership', () => {
    // `members.role` DEFAULTS to Applicant, so a row written without an explicit
    // role must not be granted membership by omission.
    expect(holdsMembershipRole(member({ role: MemberRole.Applicant }))).toBe(false);
  });

  it('withholds it from a BANNED member, whatever their role says', () => {
    // Checked here rather than relying on the reconcile's early return — a
    // predicate that silently depended on its caller would be wrong the first
    // time it was called from anywhere else.
    expect(holdsMembershipRole(member({ role: MemberRole.Admin, bannedAt: new Date() }))).toBe(
      false,
    );
  });

  it('is an ALLOW-list: an unknown role does not hold it', () => {
    // A role added to MemberRole later must default to NOT carrying the
    // regiment's membership marker. That is the safe direction to be wrong in.
    expect(holdsMembershipRole(member({ role: 'Quartermaster' as MemberRole }))).toBe(false);
  });
});
