import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { MemberRole } from '../../common/enums';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from './roles.decorator';

/**
 * Gate a route (or controller) on coarse role membership. Applies the @Roles
 * metadata, wires the {@link RolesGuard} and documents the 403 in Swagger in one
 * shot — the role-level parallel to @RequireCapability:
 *
 *   @RequireRole(MemberRole.Owner, MemberRole.Admin, MemberRole.Moderator)
 *   @Get('status')
 *   status() { ... }
 *
 * Use this for STAFF-only surfaces that don't map to a single capability. Runs
 * after the global JwtAuthGuard, so request.user is already populated.
 */
export const RequireRole = (...roles: MemberRole[]) =>
  applyDecorators(
    Roles(...roles),
    UseGuards(RolesGuard),
    ApiForbiddenResponse({ description: `Requires role: ${roles.join(', ')}` }),
  );
