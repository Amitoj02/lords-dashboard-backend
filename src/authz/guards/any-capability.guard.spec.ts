import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Capability, MemberRole } from '../../common/enums';
import { AuthzService } from '../authz.service';
import { AnyCapabilityGuard } from './any-capability.guard';

const REGIMENT = 'Rgmt00000001';

/** A minimal ExecutionContext carrying `request.user`. */
const contextFor = (user: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  }) as unknown as ExecutionContext;

describe('AnyCapabilityGuard (T-0206)', () => {
  let guard: AnyCapabilityGuard;
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  const authz = { can: jest.fn() };

  const user = { regimentId: REGIMENT, role: MemberRole.Moderator };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AnyCapabilityGuard(reflector, authz as unknown as AuthzService);
  });

  const require = (...caps: Capability[]) =>
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(caps);

  it('admits a caller holding the SECOND capability, not just the first', async () => {
    // The whole point: a Moderator holds manage_events but not edit_ranks_medals,
    // and must still be able to load the role list for the event form.
    require(Capability.EditRanksMedals, Capability.ManageEvents);
    authz.can.mockImplementation((_r: string, _role: string, cap: string) =>
      Promise.resolve(cap === String(Capability.ManageEvents)),
    );

    await expect(guard.canActivate(contextFor(user))).resolves.toBe(true);
  });

  it('short-circuits on the first match instead of checking the rest', async () => {
    require(Capability.EditRanksMedals, Capability.ManageEvents);
    authz.can.mockResolvedValue(true);

    await expect(guard.canActivate(contextFor(user))).resolves.toBe(true);
    expect(authz.can).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller holding NONE of them, naming what would have worked', async () => {
    require(Capability.EditRanksMedals, Capability.ManageEvents);
    authz.can.mockResolvedValue(false);

    await expect(guard.canActivate(contextFor(user))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(contextFor(user))).rejects.toThrow(
      /edit_ranks_medals, manage_events/,
    );
  });

  it('is OR, not AND — one capability is enough even when the other is denied', async () => {
    // Pins the difference from CapabilitiesGuard. If this guard were ever
    // "fixed" to require all of them, this is the case that breaks.
    require(Capability.EditRanksMedals, Capability.ManageEvents);
    authz.can.mockImplementation((_r: string, _role: string, cap: string) =>
      Promise.resolve(cap === String(Capability.EditRanksMedals)),
    );

    await expect(guard.canActivate(contextFor(user))).resolves.toBe(true);
  });

  it('refuses an unauthenticated request outright', async () => {
    require(Capability.ManageEvents);

    await expect(guard.canActivate(contextFor(undefined))).rejects.toThrow(ForbiddenException);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it('stays out of the way when the route carries no metadata', async () => {
    // It must never GRANT on its own — an un-annotated route is still governed
    // by whatever else guards it.
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    await expect(guard.canActivate(contextFor(user))).resolves.toBe(true);

    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([]);
    await expect(guard.canActivate(contextFor(user))).resolves.toBe(true);
    expect(authz.can).not.toHaveBeenCalled();
  });
});
