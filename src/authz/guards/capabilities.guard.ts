import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.interface';
import { Capability } from '../../common/enums';
import { AuthzService } from '../authz.service';

/** Metadata key carrying the capabilities required by a route/controller. */
export const CAPABILITY_KEY = 'required_capabilities';

/**
 * Enforces @RequireCapability(...) against the role_permissions matrix. Runs
 * after the global JwtAuthGuard, so `request.user` is already populated. All
 * listed capabilities must be granted (logical AND).
 */
@Injectable()
export class CapabilitiesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthzService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Capability[] | undefined>(CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    for (const capability of required) {
      const granted = await this.authz.can(user.regimentId, user.role, capability);
      if (!granted) {
        throw new ForbiddenException(`Missing capability: ${capability}`);
      }
    }
    return true;
  }
}
