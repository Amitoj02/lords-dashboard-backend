import { DataSource } from 'typeorm';
import { Capability, MemberRole } from '../../common/enums';
import { RolePermission } from '../../authz/entities/role-permission.entity';
import { provision, REGIMENT_ID } from './seed.util';

const ALL = MemberRole;
const ADMINS = [MemberRole.Owner, MemberRole.Admin];
const STAFF = [MemberRole.Owner, MemberRole.Admin, MemberRole.Moderator];
// Enrolled roster members excluding Mercenary (e.g. gallery submission).
const MEMBERS = [MemberRole.Owner, MemberRole.Admin, MemberRole.Moderator, MemberRole.Member];
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
  // Gallery archive view: all enrolled roster members incl. Mercenary.
  [Capability.ViewGallery]: ENROLLED,
  [Capability.ModerateGallery]: STAFF,
  [Capability.RevealEventPasswords]: ENROLLED,
  // Submitting to the gallery is members-only (Mercenary excluded).
  [Capability.SubmitToGallery]: MEMBERS,
  [Capability.RsvpToEvents]: ENROLLED,
  [Capability.ViewMembersDirectory]: ENROLLED,
  [Capability.ApplyToJoin]: [MemberRole.Applicant],
};

/**
 * Writes the DEFAULT matrix, one row per (role, capability).
 *
 * Insert-only, because this matrix is editable in the admin UI via the
 * ManageRoles capability — merging would hand the defaults back on every deploy
 * and silently discard the admin's changes. Keying on the two enum values is
 * safe (unlike a rank name, an enum member cannot be renamed by a user), so a
 * capability added in a later release still receives its default grant here on
 * an already-provisioned database.
 */
export async function seedRolePermissions(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(RolePermission);
  for (const role of Object.values(ALL)) {
    for (const capability of Object.values(Capability)) {
      const granted = MATRIX[capability].includes(role);
      await provision(repo, { regimentId: REGIMENT_ID, role, capability }, { granted });
    }
  }
}
