import { SetMetadata } from '@nestjs/common';
import { MemberRole } from '../../common/enums';

export const ROLES_KEY = 'roles';

/** Restrict a route to the given roles (coarse check; enforced by RolesGuard). */
export const Roles = (...roles: MemberRole[]) => SetMetadata(ROLES_KEY, roles);
