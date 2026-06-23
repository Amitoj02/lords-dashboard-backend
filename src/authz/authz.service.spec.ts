import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Capability, MemberRole } from '../common/enums';
import { AuthzService } from './authz.service';
import { RolePermission } from './entities/role-permission.entity';

const REG = 'regiment-1';

const row = (role: MemberRole, capability: Capability): Partial<RolePermission> => ({
  role,
  capability,
  granted: true,
});

describe('AuthzService', () => {
  let service: AuthzService;
  const find = jest.fn();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthzService,
        { provide: getRepositoryToken(RolePermission), useValue: { find } },
      ],
    }).compile();
    service = module.get(AuthzService);
    jest.clearAllMocks();
    find.mockResolvedValue([
      row(MemberRole.Owner, Capability.ManageSettings),
      row(MemberRole.Admin, Capability.ViewAuditLog),
      row(MemberRole.Moderator, Capability.ManageApplications),
    ]);
  });

  it('grants a capability present in the matrix', async () => {
    await expect(service.can(REG, MemberRole.Admin, Capability.ViewAuditLog)).resolves.toBe(true);
  });

  it('denies a capability not granted to the role', async () => {
    await expect(service.can(REG, MemberRole.Moderator, Capability.ViewAuditLog)).resolves.toBe(
      false,
    );
  });

  it('denies a role with no rows at all', async () => {
    await expect(service.can(REG, MemberRole.Applicant, Capability.ApplyToJoin)).resolves.toBe(
      false,
    );
  });

  it('caches the matrix per regiment (one DB load for repeated checks)', async () => {
    await service.can(REG, MemberRole.Owner, Capability.ManageSettings);
    await service.can(REG, MemberRole.Admin, Capability.ViewAuditLog);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('reloads after invalidate()', async () => {
    await service.can(REG, MemberRole.Owner, Capability.ManageSettings);
    service.invalidate(REG);
    await service.can(REG, MemberRole.Owner, Capability.ManageSettings);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('lists the granted capabilities for a role', async () => {
    await expect(service.grantedCapabilities(REG, MemberRole.Owner)).resolves.toEqual([
      Capability.ManageSettings,
    ]);
  });
});
