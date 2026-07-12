import { DataSource } from 'typeorm';
import { Capability, MemberRole } from '../../common/enums';
import { RolePermission } from '../../authz/entities/role-permission.entity';
import { ensure, REGIMENT_ID } from './seed.util';

const ALL = MemberRole;
const ADMINS = [MemberRole.Owner, MemberRole.Admin];
const STAFF = [MemberRole.Owner, MemberRole.Admin, MemberRole.Moderator];
const ENROLLED = [
  MemberRole.Owner,
  MemberRole.Admin,
  MemberRole.Moderator,
  MemberRole.Member,
  MemberRole.Mercenary,
];

/** capability → the roles that are granted it (the default permission matrix). */
const MATRIX: Record<Capability, MemberRole[]> = {
  [Capability.ManageSettings]: [MemberRole.Owner],
  [Capability.TransferOwnership]: [MemberRole.Owner],
  [Capability.ManageRoles]: [MemberRole.Owner],
  [Capability.ViewAuditLog]: ADMINS,
  [Capability.EditRanksMedals]: ADMINS,
  [Capability.ManageApplications]: STAFF,
  [Capability.ManageEvents]: STAFF,
  [Capability.ModerateGallery]: STAFF,
  [Capability.RevealEventPasswords]: ENROLLED,
  [Capability.SubmitToGallery]: ENROLLED,
  [Capability.RsvpToEvents]: ENROLLED,
  [Capability.ViewMembersDirectory]: ENROLLED,
  [Capability.ApplyToJoin]: [MemberRole.Applicant],
  // Composing field dispatches / announcements (may cross-post to Discord) is an
  // admin action — Owner + Admin only, not Moderator.
  [Capability.ManageNotifications]: ADMINS,
};

export async function seedRolePermissions(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(RolePermission);
  for (const role of Object.values(ALL)) {
    for (const capability of Object.values(Capability)) {
      const granted = MATRIX[capability].includes(role);
      await ensure(repo, { regimentId: REGIMENT_ID, role, capability }, { granted });
    }
  }
}
