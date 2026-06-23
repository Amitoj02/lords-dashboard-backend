import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MemberRole } from '../../common/enums';
import { AuthenticatedUser } from '../types/authenticated-user.interface';
import { RolesGuard } from './roles.guard';

const contextFor = (user: Partial<AuthenticatedUser> | undefined): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  }) as unknown as ExecutionContext;

describe('RolesGuard', () => {
  const guardWith = (required: MemberRole[] | undefined) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
    return new RolesGuard(reflector);
  };

  it('allows when no roles are required', () => {
    expect(guardWith(undefined).canActivate(contextFor({ role: MemberRole.Member }))).toBe(true);
  });

  it('allows when the user has a required role', () => {
    expect(guardWith([MemberRole.Admin]).canActivate(contextFor({ role: MemberRole.Admin }))).toBe(
      true,
    );
  });

  it('forbids when the user lacks the required role', () => {
    expect(() =>
      guardWith([MemberRole.Owner]).canActivate(contextFor({ role: MemberRole.Member })),
    ).toThrow(ForbiddenException);
  });

  it('forbids when there is no authenticated user', () => {
    expect(() => guardWith([MemberRole.Member]).canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
