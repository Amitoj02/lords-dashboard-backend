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

  describe('out-of-band matrix changes', () => {
    afterEach(() => jest.useRealTimers());

    /**
     * The scenario this defends, observed for real: `seed:prod` back-filled the
     * default grant for a newly added capability directly into the table, in its
     * own process, so nothing could call invalidate(). The long-running API kept
     * serving a matrix loaded before the capability existed.
     *
     * The failure was silent AND self-contradictory — GET /settings/permissions
     * reads the table and showed the capability as GRANTED, while the guard read
     * the stale cache and denied it. Note the regiment id is a fixed seed
     * constant, so even wiping and reseeding the database reuses the same cache
     * key and the stale entry survives.
     */
    it('picks up a grant written straight to the table once the TTL lapses', async () => {
      jest.useFakeTimers();

      await expect(
        service.can(REG, MemberRole.Owner, Capability.ManageRegimentDetails),
      ).resolves.toBe(false);

      // The seeder inserts the row; no invalidate() is possible from there.
      find.mockResolvedValue([
        row(MemberRole.Owner, Capability.ManageSettings),
        row(MemberRole.Owner, Capability.ManageRegimentDetails),
      ]);

      // Still cached, so still denied — the cache is deliberately not per-request.
      await expect(
        service.can(REG, MemberRole.Owner, Capability.ManageRegimentDetails),
      ).resolves.toBe(false);
      expect(find).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(31_000);

      await expect(
        service.can(REG, MemberRole.Owner, Capability.ManageRegimentDetails),
      ).resolves.toBe(true);
      expect(find).toHaveBeenCalledTimes(2);
    });

    it('still serves from cache within the TTL (the hot path stays a memo)', async () => {
      jest.useFakeTimers();

      await service.can(REG, MemberRole.Owner, Capability.ManageSettings);
      jest.advanceTimersByTime(29_000);
      await service.can(REG, MemberRole.Owner, Capability.ManageSettings);

      expect(find).toHaveBeenCalledTimes(1);
    });

    it('invalidate() still propagates an API-side edit immediately, without waiting for the TTL', async () => {
      jest.useFakeTimers();

      await service.can(REG, MemberRole.Owner, Capability.ManageSettings);
      find.mockResolvedValue([row(MemberRole.Owner, Capability.ManageRegimentDetails)]);
      service.invalidate(REG);

      await expect(
        service.can(REG, MemberRole.Owner, Capability.ManageRegimentDetails),
      ).resolves.toBe(true);
      expect(find).toHaveBeenCalledTimes(2);
    });
  });
});
