import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.interface';
import { Capability, MemberRole } from '../../common/enums';
import { AuthzService } from '../authz.service';
import { CapabilitiesGuard } from './capabilities.guard';

const contextFor = (user: Partial<AuthenticatedUser> | undefined): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  }) as unknown as ExecutionContext;

const user: AuthenticatedUser = {
  identityId: 'id-1',
  memberId: 'mem-1',
  discordUserId: '123',
  role: MemberRole.Admin,
  regimentId: 'reg-1',
};

describe('CapabilitiesGuard', () => {
  const build = (required: Capability[] | undefined, can: boolean) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
    const authz = { can: jest.fn().mockResolvedValue(can) } as unknown as AuthzService;
    return { guard: new CapabilitiesGuard(reflector, authz), authz };
  };

  it('allows when no capability metadata is present', async () => {
    const { guard, authz } = build(undefined, false);
    await expect(guard.canActivate(contextFor(user))).resolves.toBe(true);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it('allows when the matrix grants the capability', async () => {
    const { guard, authz } = build([Capability.ViewAuditLog], true);
    await expect(guard.canActivate(contextFor(user))).resolves.toBe(true);
    expect(authz.can).toHaveBeenCalledWith('reg-1', MemberRole.Admin, Capability.ViewAuditLog);
  });

  it('forbids when the matrix denies the capability', async () => {
    const { guard } = build([Capability.ManageSettings], false);
    await expect(guard.canActivate(contextFor(user))).rejects.toThrow(ForbiddenException);
  });

  it('forbids when there is no authenticated user', async () => {
    const { guard } = build([Capability.ViewAuditLog], true);
    await expect(guard.canActivate(contextFor(undefined))).rejects.toThrow(ForbiddenException);
  });
});
