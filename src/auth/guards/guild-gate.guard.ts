import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_WHEN_GATED_KEY } from '../decorators/allow-when-gated.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { GuildMembershipService } from '../guild-membership.service';
import { AuthenticatedUser } from '../types/authenticated-user.interface';

/**
 * Server-side enforcement of the guild-membership gate (LDA-M5). The gate used to
 * be UX-only: `guildGateEnabled`/`guildMember` were read solely to build the
 * /auth/me DTO, and enforcement lived entirely in the Angular router — so a gated
 * user's valid JWT was still accepted by every API endpoint.
 *
 * This guard runs AFTER JwtAuthGuard (so `request.user` is set) and denies a
 * gate-enabled, non-exempt, confirmed-non-member caller on every route except:
 *  - @Public() routes (no session to gate), and
 *  - @AllowWhenGated() routes (the auth endpoints a gated user needs to escape).
 *
 * It reads only the STORED verdict (GuildMembershipService.isGatedOut never probes
 * the bot), so it stays off the Discord call path and fails OPEN on uncertainty.
 */
@Injectable()
export class GuildGateGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly guild: GuildMembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(ALLOW_WHEN_GATED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    // No user means JwtAuthGuard has not authenticated this request — either it is
    // public (already returned) or JwtAuthGuard will reject it. Nothing to gate.
    if (!user) return true;

    if (await this.guild.isGatedOut(user)) {
      throw new ForbiddenException(
        'You are not a member of the regiment Discord guild. Join the guild to regain access.',
      );
    }
    return true;
  }
}
