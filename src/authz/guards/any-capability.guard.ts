import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.interface';
import { Capability } from '../../common/enums';
import { AuthzService } from '../authz.service';

/** Metadata key carrying the capabilities that SATISFY a route (any one of them). */
export const ANY_CAPABILITY_KEY = 'any_required_capabilities';

/**
 * Enforces {@link RequireAnyCapability} — the OR counterpart of
 * {@link CapabilitiesGuard}, which requires every listed capability (AND).
 *
 * ── WHY BOTH EXIST ──────────────────────────────────────────────────────────
 * The AND guard is the right default: a route that touches two concerns should
 * demand both. But some READS serve more than one screen, and gating them on a
 * single capability silently locks out a role that legitimately reaches the
 * feature by another door.
 *
 * The case that forced this (T-0206): `GET /discord/roles` was gated on
 * `edit_ranks_medals` because the rank/medal link pickers were its only
 * consumer. The event authoring form now needs the same list to offer a ping
 * role — and event authoring is `manage_events`, which by default includes
 * Moderator while `edit_ranks_medals` does not. Adding `manage_events` to the
 * AND guard would have made the route require BOTH and locked out the very
 * people it was written for.
 *
 * Deliberately NOT solved with `@RequireRole(...)`: that bypasses the
 * `role_permissions` matrix the regiment actually edits, so a regiment that
 * moved `manage_events` off Moderator would keep handing them the role list.
 * This stays inside the matrix.
 */
@Injectable()
export class AnyCapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthzService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const accepted = this.reflector.getAllAndOverride<Capability[] | undefined>(
      ANY_CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No metadata ⇒ this guard has nothing to say. It never grants on its own;
    // an un-annotated route is still governed by whatever else guards it.
    if (!accepted || accepted.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    for (const capability of accepted) {
      if (await this.authz.can(user.regimentId, user.role, capability)) return true;
    }
    throw new ForbiddenException(`Requires one of: ${accepted.join(', ')}`);
  }
}
