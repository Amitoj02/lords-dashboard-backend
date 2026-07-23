import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ALLOW_WHEN_GATED_KEY } from '../decorators/allow-when-gated.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { GuildMembershipService } from '../guild-membership.service';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';
import { GuildGateGuard } from './guild-gate.guard';

/**
 * LDA-M5: the guild gate must be enforced by the API, not only the Angular router.
 */
describe('GuildGateGuard (LDA-M5)', () => {
  const ctx = (user?: AuthenticatedUser): ExecutionContext =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const build = (opts: { allowWhenGated?: boolean; isPublic?: boolean; gatedOut?: boolean }) => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) =>
        key === ALLOW_WHEN_GATED_KEY
          ? opts.allowWhenGated
          : key === IS_PUBLIC_KEY
            ? opts.isPublic
            : undefined,
      ),
    } as unknown as Reflector;
    const guild = {
      isGatedOut: jest.fn().mockResolvedValue(opts.gatedOut ?? false),
    } as unknown as GuildMembershipService;
    return { guard: new GuildGateGuard(reflector, guild), guild };
  };

  const user: AuthenticatedUser = {
    identityId: 'id-1',
    memberId: 'm-1',
    discordUserId: 'd-1',
    role: 'member' as AuthenticatedUser['role'],
    regimentId: 'r-1',
  };

  it('allows @AllowWhenGated routes without consulting the gate', async () => {
    const { guard, guild } = build({ allowWhenGated: true, gatedOut: true });
    await expect(guard.canActivate(ctx(user))).resolves.toBe(true);
    expect(guild.isGatedOut).not.toHaveBeenCalled();
  });

  it('allows @Public routes', async () => {
    const { guard, guild } = build({ isPublic: true, gatedOut: true });
    await expect(guard.canActivate(ctx(undefined))).resolves.toBe(true);
    expect(guild.isGatedOut).not.toHaveBeenCalled();
  });

  it('allows when there is no authenticated user (JwtAuthGuard handles it)', async () => {
    const { guard } = build({ gatedOut: true });
    await expect(guard.canActivate(ctx(undefined))).resolves.toBe(true);
  });

  it('allows an authenticated caller who is not gated out', async () => {
    const { guard } = build({ gatedOut: false });
    await expect(guard.canActivate(ctx(user))).resolves.toBe(true);
  });

  it('denies a gated-out caller on a normal route', async () => {
    const { guard } = build({ gatedOut: true });
    await expect(guard.canActivate(ctx(user))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
