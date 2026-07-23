import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuthzService } from '../authz/authz.service';
import { RolePermission } from '../authz/entities/role-permission.entity';
import { AuditSeverity, Capability, MemberRole, RegimentDocumentSlug } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { RegimentDocument } from '../regiments/entities/regiment-document.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { StorageService } from '../storage/storage.service';
import { SettingsService } from './settings.service';

const REGIMENT = 'regiment-1';

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  identityId: 'identity-1',
  memberId: 'member-1',
  discordUserId: 'discord-1',
  role: MemberRole.Owner,
  regimentId: REGIMENT,
  ...overrides,
});

const buildRegiment = (overrides: Partial<Regiment> = {}): Regiment => ({
  id: REGIMENT,
  name: 'Lords',
  missionStatement: null,
  accentTone: 'brass',
  crestUrl: null,
  bannerUrl: null,
  establishedYear: 2018,
  establishedAt: null,
  discordInviteUrl: null,
  discordServerId: null,
  discordServerName: null,
  setupStep: 1,
  setupComplete: true,
  ownerMemberId: 'member-1',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  dissolvedAt: null,
  ...overrides,
});

const buildSettings = (overrides: Partial<RegimentSettings> = {}): RegimentSettings => ({
  regimentId: REGIMENT,
  publicGallery: true,
  publicEvents: true,
  publicStats: true,
  openRecruitment: true,
  showOfficersMessOnLanding: true,
  allowMercenaries: true,
  autoApproveTrustedMembers: false,
  galleryMaxImageSizeMb: 12,
  galleryMaxVideoSizeMb: 80,
  galleryMaxItemsPerSubmission: 10,
  galleryAllowedImageTypes: null,
  galleryAllowedVideoTypes: null,
  eventDefaultTimezone: 'UTC',
  eventDefaultStartTime: null,
  eventDefaultNotifyBefore: null,
  auditRetentionMonths: 12,
  // Presentation (T-0146): unset means "render the shipped copy".
  heroBannerUrl: null,
  loginBannerUrl: null,
  charterQuote: null,
  charterQuoteAttribution: null,
  loginQuote: null,
  loginQuoteAttribution: null,
  heroOverlayDensity: null,
  loginOverlayDensity: null,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  ...overrides,
});

/**
 * Owner granted the governance-critical core PAIR — the whole floor the guard
 * defends since T-0170 retired TransferOwnership. Deliberately no third row: a
 * matrix carrying a retired capability would let the floor test pass without
 * ever exercising the two clauses that are actually left.
 */
const ownerCoreRows = (): RolePermission[] =>
  [
    { role: MemberRole.Owner, capability: Capability.ManageSettings, granted: true },
    { role: MemberRole.Owner, capability: Capability.ManageRoles, granted: true },
  ].map((row, i) => ({ id: `perm-${i}`, regimentId: REGIMENT, ...row }));

describe('SettingsService', () => {
  let service: SettingsService;

  const settingsRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
  const regimentRepo = { findOne: jest.fn(), save: jest.fn(), softDelete: jest.fn() };
  const permissionRepo = { find: jest.fn(), create: jest.fn(), save: jest.fn() };
  const memberRepo = { findOne: jest.fn() };
  const documentRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    create: jest.fn((data: Partial<RegimentDocument>) => ({ ...data })),
    save: jest.fn((doc: RegimentDocument) => Promise.resolve(doc)),
  };
  // Mirrors the real namespace check: a key outside the target's prefix throws,
  // which is what stops an arbitrary URL being published as the public hero.
  const storage = {
    resolveKeyToPublicUrl: jest.fn((_user: unknown, key: string) => `https://cdn.example/${key}`),
  };
  const authz = { invalidate: jest.fn() };
  const audit = { record: jest.fn() };
  const dataSource = { transaction: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    settingsRepo.create.mockImplementation((data: Partial<RegimentSettings>) => ({ ...data }));
    settingsRepo.save.mockImplementation((s: RegimentSettings) => Promise.resolve(s));
    regimentRepo.save.mockImplementation((r: Regiment) => Promise.resolve(r));
    regimentRepo.softDelete.mockResolvedValue({ affected: 1 });
    permissionRepo.create.mockImplementation((data: Partial<RolePermission>) => ({ ...data }));
    permissionRepo.save.mockImplementation((p: RolePermission) => Promise.resolve(p));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: getRepositoryToken(RegimentSettings), useValue: settingsRepo },
        { provide: getRepositoryToken(Regiment), useValue: regimentRepo },
        { provide: getRepositoryToken(RolePermission), useValue: permissionRepo },
        { provide: getRepositoryToken(Member), useValue: memberRepo },
        { provide: getRepositoryToken(RegimentDocument), useValue: documentRepo },
        { provide: StorageService, useValue: storage },
        { provide: AuthzService, useValue: authz },
        { provide: AuditService, useValue: audit },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(SettingsService);
  });

  describe('get', () => {
    it('returns entity-shaped defaults when no settings row exists', async () => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment());
      settingsRepo.findOne.mockResolvedValue(null);

      const dto = await service.get(user());

      expect(dto.name).toBe('Lords');
      expect(dto.establishedYear).toBe(2018);
      expect(dto.establishedAt).toBeNull();
      expect(dto.autoApproveTrustedMembers).toBe(false);
      expect(dto.galleryMaxImageSizeMb).toBe(12);
      expect(dto.eventDefaultTimezone).toBe('UTC');
      expect(dto.auditRetentionMonths).toBe(12);
    });
  });

  describe('update', () => {
    it('applies only the changed keys across both tables and audits them', async () => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment());
      settingsRepo.findOne.mockResolvedValue(buildSettings());

      const dto = await service.update(
        user(),
        { name: 'Lords Regiment', establishedAt: '2023-11-20', publicEvents: false },
        null,
      );

      expect(regimentRepo.save).toHaveBeenCalledTimes(1);
      expect(settingsRepo.save).toHaveBeenCalledTimes(1);
      expect(dto.name).toBe('Lords Regiment');
      expect(dto.establishedAt).toBe('2023-11-20');
      expect(dto.publicEvents).toBe(false);

      const recorded = audit.record.mock.calls[0][0];
      expect(recorded.action).toBe('settings.update');
      expect(recorded.before).toEqual({
        name: 'Lords',
        establishedAt: null,
        publicEvents: true,
      });
      expect(recorded.after).toEqual({
        name: 'Lords Regiment',
        establishedAt: '2023-11-20',
        publicEvents: false,
      });
    });

    it('is a no-op (no save, no audit) when nothing actually changes', async () => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment());
      settingsRepo.findOne.mockResolvedValue(buildSettings());

      await service.update(user(), { name: 'Lords', publicEvents: true }, null);

      expect(regimentRepo.save).not.toHaveBeenCalled();
      expect(settingsRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('updatePresentation (T-0147)', () => {
    beforeEach(() => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment());
      settingsRepo.findOne.mockResolvedValue(buildSettings());
    });

    it('resolves a banner KEY through the namespace validator, never a raw URL', async () => {
      const dto = await service.updatePresentation(
        user(),
        { heroBannerKey: 'regiments/regiment-1/hero/abc.png' },
        null,
      );

      // The whole point of accepting a key rather than a URL: the caller cannot
      // publish an arbitrary origin as the regiment's public background.
      expect(storage.resolveKeyToPublicUrl).toHaveBeenCalledWith(
        expect.anything(),
        'regiments/regiment-1/hero/abc.png',
        'regiment-hero-banner',
      );
      expect(dto.heroBannerUrl).toBe('https://cdn.example/regiments/regiment-1/hero/abc.png');
    });

    it('propagates the namespace rejection instead of persisting a foreign key', async () => {
      storage.resolveKeyToPublicUrl.mockImplementationOnce(() => {
        throw new BadRequestException('Uploaded key is outside the expected namespace');
      });

      await expect(
        service.updatePresentation(user(), { heroBannerKey: 'gallery/regiment-1/m/x.png' }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(settingsRepo.save).not.toHaveBeenCalled();
    });

    it('clears a banner when the key is explicitly null', async () => {
      settingsRepo.findOne.mockResolvedValue(
        buildSettings({ heroBannerUrl: 'https://cdn/old.png' }),
      );

      const dto = await service.updatePresentation(user(), { heroBannerKey: null }, null);

      expect(dto.heroBannerUrl).toBeNull();
      expect(storage.resolveKeyToPublicUrl).not.toHaveBeenCalled();
    });

    it('writes an overlay density of 0, which a truthiness check would drop', async () => {
      // 0 is a meaningful value (a fully transparent scrim). The production
      // guard is deliberately `!== undefined`, not a truthiness test.
      const dto = await service.updatePresentation(user(), { heroOverlayDensity: 0 }, null);

      expect(dto.heroOverlayDensity).toBe(0);
      expect(settingsRepo.save).toHaveBeenCalled();
    });

    it('normalises a blank quote to null so "cleared" and "never set" are one state', async () => {
      settingsRepo.findOne.mockResolvedValue(buildSettings({ charterQuote: 'Old words' }));

      const dto = await service.updatePresentation(user(), { charterQuote: '' }, null);

      // The client then has exactly one fallback branch instead of two.
      expect(dto.charterQuote).toBeNull();
    });

    it('leaves untouched keys alone and skips the save + audit when nothing changed', async () => {
      await service.updatePresentation(user(), {}, null);

      expect(settingsRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('audits only the changed presentation keys', async () => {
      await service.updatePresentation(user(), { loginQuote: 'Stand fast.' }, null);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'regiment.presentation.update',
          before: { loginQuote: null },
          after: { loginQuote: 'Stand fast.' },
        }),
      );
    });
  });

  describe('updateDocument (T-0149)', () => {
    beforeEach(() => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment());
      documentRepo.findOne.mockResolvedValue(null);
    });

    it('stores a blank body as NULL so the public page falls back to shipped copy', async () => {
      // A live site must never serve an empty privacy policy.
      const dto = await service.updateDocument(
        user(),
        RegimentDocumentSlug.Privacy,
        { body: '   ' },
        null,
      );

      expect(dto.body).toBeNull();
    });

    it('audits the body LENGTH, not the body', async () => {
      await service.updateDocument(user(), RegimentDocumentSlug.Terms, { body: 'abcde' }, null);

      // A 60k before/after pair on every save would bloat the ledger — and the
      // Discord mirror of it — for no diagnostic gain.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'regiment.document.update',
          before: { length: 0 },
          after: { length: 5 },
        }),
      );
    });

    it('records who saved the document', async () => {
      memberRepo.findOne.mockResolvedValue({ id: 'member-1', inGameName: 'Jane' });

      const dto = await service.updateDocument(
        user(),
        RegimentDocumentSlug.Guidelines,
        { body: '# Rules' },
        null,
      );

      expect(dto.updatedByName).toBe('Jane');
    });
  });

  describe('completeSetup', () => {
    it('flips setupComplete false → true, saves, and audits', async () => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment({ setupComplete: false }));
      settingsRepo.findOne.mockResolvedValue(buildSettings());

      const dto = await service.completeSetup(user(), null);

      expect(regimentRepo.save).toHaveBeenCalledTimes(1);
      const saved = regimentRepo.save.mock.calls[0][0] as Regiment;
      expect(saved.setupComplete).toBe(true);
      expect(dto.setupComplete).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'settings.update', after: { setupComplete: true } }),
      );
    });

    it('is a no-op (no save, no audit) when setup is already complete', async () => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment({ setupComplete: true }));
      settingsRepo.findOne.mockResolvedValue(buildSettings());

      const dto = await service.completeSetup(user(), null);

      expect(regimentRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(dto.setupComplete).toBe(true);
    });
  });

  describe('getPermissions', () => {
    it('projects a full matrix, defaulting absent cells to false', async () => {
      permissionRepo.find.mockResolvedValue(ownerCoreRows());

      const dto = await service.getPermissions(user());

      expect(dto.roles).toContain(MemberRole.Owner);
      expect(dto.capabilities).toContain(Capability.ManageSettings);
      expect(dto.matrix[MemberRole.Owner][Capability.ManageSettings]).toBe(true);
      expect(dto.matrix[MemberRole.Member][Capability.ManageSettings]).toBe(false);
      expect(dto.matrix[MemberRole.Member][Capability.ModerateGallery]).toBe(false);
    });
  });

  describe('updatePermissions', () => {
    it('REJECTS removing ManageSettings from the Owner (floor guard)', async () => {
      permissionRepo.find.mockResolvedValue(ownerCoreRows());

      await expect(
        service.updatePermissions(
          user(),
          {
            changes: [
              { role: MemberRole.Owner, capability: Capability.ManageSettings, granted: false },
            ],
          },
          null,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(permissionRepo.save).not.toHaveBeenCalled();
      expect(authz.invalidate).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('ALLOWS a benign grant (ModerateGallery → Member): persists, invalidates, audits', async () => {
      permissionRepo.find.mockResolvedValue(ownerCoreRows());
      // The write runs inside a transaction; wire the manager repo so we can
      // assert the new cell is created + saved exactly once.
      const permTxRepo = {
        update: jest.fn(),
        create: jest.fn((data: Partial<RolePermission>) => ({ ...data })),
        save: jest.fn(),
      };
      dataSource.transaction.mockImplementation((cb: (m: unknown) => unknown) =>
        cb({ getRepository: () => permTxRepo }),
      );

      await service.updatePermissions(
        user(),
        {
          changes: [
            { role: MemberRole.Member, capability: Capability.ModerateGallery, granted: true },
          ],
        },
        null,
      );

      expect(permTxRepo.create).toHaveBeenCalledWith({
        regimentId: REGIMENT,
        role: MemberRole.Member,
        capability: Capability.ModerateGallery,
        granted: true,
      });
      expect(permTxRepo.save).toHaveBeenCalledTimes(1);
      expect(authz.invalidate).toHaveBeenCalledWith(REGIMENT);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'settings.permissions.update' }),
      );
    });

    it('collapses duplicate cells in one batch so a new cell is written exactly once', async () => {
      permissionRepo.find.mockResolvedValue(ownerCoreRows());
      const permTxRepo = {
        update: jest.fn(),
        create: jest.fn((data: Partial<RolePermission>) => ({ ...data })),
        save: jest.fn(),
      };
      dataSource.transaction.mockImplementation((cb: (m: unknown) => unknown) =>
        cb({ getRepository: () => permTxRepo }),
      );

      await service.updatePermissions(
        user(),
        {
          changes: [
            { role: MemberRole.Member, capability: Capability.ModerateGallery, granted: true },
            { role: MemberRole.Member, capability: Capability.ModerateGallery, granted: true },
          ],
        },
        null,
      );

      // A single INSERT for the deduped new cell — not two (which would violate
      // the UNIQUE(regiment_id, role, capability) index and 500 mid-batch).
      expect(permTxRepo.save).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown capability before touching the matrix', async () => {
      await expect(
        service.updatePermissions(
          user(),
          { changes: [{ role: MemberRole.Owner, capability: 'not_a_cap', granted: true }] },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(permissionRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('retired transfer_ownership capability (T-0170)', () => {
    it('rejects a matrix edit naming the retired capability', async () => {
      // The capability axis is derived from the enum, so deleting the member is
      // what makes this a 400 — this pins that the retirement is enforced, not
      // merely undocumented.
      await expect(
        service.updatePermissions(
          user(),
          {
            changes: [{ role: MemberRole.Owner, capability: 'transfer_ownership', granted: true }],
          },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(permissionRepo.save).not.toHaveBeenCalled();
    });

    it('does not project the retired capability onto the matrix', async () => {
      permissionRepo.find.mockResolvedValue(ownerCoreRows());

      const dto = await service.getPermissions(user());

      expect(dto.capabilities).not.toContain('transfer_ownership');
      expect(dto.matrix[MemberRole.Owner]).not.toHaveProperty('transfer_ownership');
    });

    it('keeps the floor guard on the remaining pair: ManageRoles is still undroppable', async () => {
      // The guard lost a clause with the capability; it must not have lost its
      // teeth. Stripping the OTHER core capability still has to 403.
      permissionRepo.find.mockResolvedValue(ownerCoreRows());

      await expect(
        service.updatePermissions(
          user(),
          {
            changes: [
              { role: MemberRole.Owner, capability: Capability.ManageRoles, granted: false },
            ],
          },
          null,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(authz.invalidate).not.toHaveBeenCalled();
    });
  });

  describe('dissolve', () => {
    it('rejects a mismatched confirmation name', async () => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment({ name: 'Lords' }));

      await expect(service.dissolve(user(), 'Wrong', null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(regimentRepo.softDelete).not.toHaveBeenCalled();
    });

    it('soft-deletes and audits at err severity on an exact name match', async () => {
      regimentRepo.findOne.mockResolvedValue(buildRegiment({ name: 'Lords' }));

      const result = await service.dissolve(user(), 'Lords', null);

      expect(result).toEqual({ dissolved: true });
      expect(regimentRepo.softDelete).toHaveBeenCalledWith({ id: REGIMENT });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'settings.dissolve', severity: AuditSeverity.Error }),
      );
    });
  });
});
