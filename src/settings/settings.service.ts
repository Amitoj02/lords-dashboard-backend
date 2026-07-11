import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuthzService } from '../authz/authz.service';
import { RolePermission } from '../authz/entities/role-permission.entity';
import { AuditSeverity, Capability, MemberRole } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { PermissionsMatrixDto } from './dto/permissions-matrix.dto';
import { SettingsDto } from './dto/settings.dto';
import { TransferDiscordDto, TransferOwnershipDto } from './dto/settings-actions.dto';
import { UpdatePermissionsDto } from './dto/update-permissions.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/** Editable keys that live on the regiment row (identity/branding/Discord invite). */
const REGIMENT_KEYS = [
  'name',
  'shortTag',
  'missionStatement',
  'accentTone',
  'crestUrl',
  'bannerUrl',
  'establishedYear',
  'discordInviteUrl',
  'discordServerName',
] as const;

/** Editable keys that live on the 1—1 regiment_settings row. */
const SETTINGS_KEYS = [
  'publicRoster',
  'publicGallery',
  'publicEvents',
  'publicStats',
  'openRecruitment',
  'showOfficersMessOnLanding',
  'allowMercenaries',
  'autoApproveTrustedMembers',
  'galleryMaxImageSizeMb',
  'galleryMaxVideoSizeMb',
  'galleryMaxItemsPerSubmission',
  'galleryAllowedImageTypes',
  'galleryAllowedVideoTypes',
  'eventDefaultTimezone',
  'eventDefaultStartTime',
  'eventDefaultNotifyBefore',
  'auditRetentionMonths',
] as const;

/**
 * Regiment control panel: profile + settings read/patch, the authorization
 * matrix (capability × role) with a governance "floor guard", and the three
 * high-consequence lifecycle actions (ownership transfer, Discord rebind,
 * dissolution). Every read/write is scoped to the caller's regiment and every
 * mutation is audited. The permission matrix is the source of truth behind
 * CapabilitiesGuard, so any change invalidates the AuthzService cache.
 */
@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(RegimentSettings)
    private readonly settings: Repository<RegimentSettings>,
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
    @InjectRepository(RolePermission)
    private readonly permissions: Repository<RolePermission>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  /** The merged profile + settings panel. Materialises defaults when no row exists. */
  async get(user: AuthenticatedUser): Promise<SettingsDto> {
    const regiment = await this.loadRegiment(user.regimentId);
    const settings =
      (await this.settings.findOne({ where: { regimentId: user.regimentId } })) ??
      this.defaultSettings(user.regimentId);
    return SettingsDto.from(regiment, settings);
  }

  /**
   * Apply the provided (whitelisted) keys to the regiment and/or its settings
   * row, saving only what changed and auditing the before/after of the changed
   * keys only. A missing settings row is created lazily the first time a settings
   * key is written.
   */
  async update(
    user: AuthenticatedUser,
    dto: UpdateSettingsDto,
    ip: string | null,
  ): Promise<SettingsDto> {
    const regiment = await this.loadRegiment(user.regimentId);
    const existing = await this.settings.findOne({ where: { regimentId: user.regimentId } });
    const settings = existing ?? this.settings.create(this.defaultSettings(user.regimentId));

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const dtoRec = dto as Record<string, unknown>;

    const regRec = regiment as unknown as Record<string, unknown>;
    for (const key of REGIMENT_KEYS) {
      if (dtoRec[key] !== undefined && dtoRec[key] !== regRec[key]) {
        before[key] = regRec[key];
        regRec[key] = dtoRec[key];
        after[key] = dtoRec[key];
      }
    }

    const setRec = settings as unknown as Record<string, unknown>;
    for (const key of SETTINGS_KEYS) {
      if (dtoRec[key] !== undefined && dtoRec[key] !== setRec[key]) {
        before[key] = setRec[key];
        setRec[key] = dtoRec[key];
        after[key] = dtoRec[key];
      }
    }

    if (REGIMENT_KEYS.some((key) => key in after)) {
      await this.regiments.save(regiment);
    }
    if (SETTINGS_KEYS.some((key) => key in after)) {
      await this.settings.save(settings);
    }

    if (Object.keys(after).length > 0) {
      await this.audit.record({
        regimentId: user.regimentId,
        action: 'settings.update',
        actor: AuditService.actorFromUser(user, ip),
        target: { type: 'regiment', id: regiment.id, label: regiment.name },
        before,
        after,
      });
    }

    return SettingsDto.from(regiment, settings);
  }

  /** The full capability × role matrix for the caller's regiment. */
  async getPermissions(user: AuthenticatedUser): Promise<PermissionsMatrixDto> {
    const rows = await this.permissions.find({ where: { regimentId: user.regimentId } });
    return PermissionsMatrixDto.from(this.buildMatrix(rows));
  }

  /**
   * Batch-edit the authorization matrix. Each change is validated (known role +
   * capability), applied to an in-memory copy, then checked by the FLOOR GUARD —
   * the regiment must remain governable: the Owner keeps ManageSettings,
   * TransferOwnership and ManageRoles, and at least one role retains
   * ManageSettings. Only then are the changed cells persisted, the authz cache
   * invalidated, and the edit audited.
   */
  async updatePermissions(
    user: AuthenticatedUser,
    dto: UpdatePermissionsDto,
    ip: string | null,
  ): Promise<PermissionsMatrixDto> {
    const roleValues = Object.values(MemberRole) as string[];
    const capabilityValues = Object.values(Capability) as string[];
    for (const change of dto.changes) {
      if (!roleValues.includes(change.role)) {
        throw new BadRequestException(`Unknown role: ${change.role}`);
      }
      if (!capabilityValues.includes(change.capability)) {
        throw new BadRequestException(`Unknown capability: ${change.capability}`);
      }
    }

    const rows = await this.permissions.find({ where: { regimentId: user.regimentId } });
    const matrix = this.buildMatrix(rows);
    for (const change of dto.changes) {
      matrix[change.role][change.capability] = change.granted;
    }

    this.assertGovernable(matrix);

    for (const change of dto.changes) {
      const existing = rows.find(
        (row) => row.role === change.role && row.capability === change.capability,
      );
      if (existing) {
        existing.granted = change.granted;
        await this.permissions.save(existing);
      } else {
        await this.permissions.save(
          this.permissions.create({
            regimentId: user.regimentId,
            role: change.role,
            capability: change.capability,
            granted: change.granted,
          }),
        );
      }
    }

    this.authz.invalidate(user.regimentId);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'settings.permissions.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'settings', label: 'permissions' },
      detail: dto.changes
        .map((change) => `${change.role}:${change.capability}=${change.granted}`)
        .join(', '),
    });

    return this.getPermissions(user);
  }

  /**
   * Transfer ownership to another member. `confirm` must be true. The target must
   * exist in the regiment (not soft-deleted) and not already be the owner. In one
   * transaction the regiment's owner pointer is repointed, the target becomes
   * Owner, and the previous owner is demoted to Admin. Audited.
   */
  async transferOwnership(
    user: AuthenticatedUser,
    dto: TransferOwnershipDto,
    ip: string | null,
  ): Promise<{ ownerMemberId: string }> {
    if (dto.confirm !== true) {
      throw new BadRequestException('Ownership transfer must be confirmed');
    }

    const regiment = await this.loadRegiment(user.regimentId);
    const target = await this.members.findOne({
      where: { id: dto.toMemberId, regimentId: user.regimentId },
    });
    if (!target) {
      throw new NotFoundException('Target member not found');
    }
    if (regiment.ownerMemberId === target.id) {
      throw new ConflictException('Member is already the regiment owner');
    }

    const previousOwnerId = regiment.ownerMemberId;

    await this.dataSource.transaction(async (manager) => {
      const regimentRepo = manager.getRepository(Regiment);
      const memberRepo = manager.getRepository(Member);
      await regimentRepo.update({ id: regiment.id }, { ownerMemberId: target.id });
      await memberRepo.update(
        { id: target.id, regimentId: user.regimentId },
        { role: MemberRole.Owner },
      );
      if (previousOwnerId && previousOwnerId !== target.id) {
        await memberRepo.update(
          { id: previousOwnerId, regimentId: user.regimentId },
          { role: MemberRole.Admin },
        );
      }
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'settings.transfer_ownership',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'member', id: target.id, memberId: target.id, label: target.name },
      before: { ownerMemberId: previousOwnerId },
      after: { ownerMemberId: target.id },
    });

    return { ownerMemberId: target.id };
  }

  /** Rebind the regiment to a Discord guild. Audited. */
  async transferDiscord(
    user: AuthenticatedUser,
    dto: TransferDiscordDto,
    ip: string | null,
  ): Promise<{ discordServerId: string | null; discordServerName: string | null }> {
    const regiment = await this.loadRegiment(user.regimentId);
    const before = {
      discordServerId: regiment.discordServerId,
      discordServerName: regiment.discordServerName,
    };

    regiment.discordServerId = dto.discordServerId;
    if (dto.discordServerName !== undefined) {
      regiment.discordServerName = dto.discordServerName;
    }
    const saved = await this.regiments.save(regiment);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'settings.transfer_discord',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'regiment', id: saved.id, label: saved.name },
      before,
      after: {
        discordServerId: saved.discordServerId,
        discordServerName: saved.discordServerName,
      },
    });

    return { discordServerId: saved.discordServerId, discordServerName: saved.discordServerName };
  }

  /**
   * ⚠️ DESTRUCTIVE — dissolve (soft-delete) the regiment. The system is
   * single-tenant, so this tears down THE regiment: `confirmName` must exactly
   * equal the regiment name, and the row is soft-deleted (dissolvedAt set) rather
   * than hard-deleted so the data can be recovered/audited. Recorded at `err`
   * severity.
   */
  async dissolve(
    user: AuthenticatedUser,
    confirmName: string,
    ip: string | null,
  ): Promise<{ dissolved: true }> {
    const regiment = await this.loadRegiment(user.regimentId);
    if (confirmName !== regiment.name) {
      throw new BadRequestException('Confirmation name does not match the regiment name');
    }

    await this.regiments.softDelete({ id: regiment.id });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'settings.dissolve',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'regiment', id: regiment.id, label: regiment.name },
      severity: AuditSeverity.Error,
      detail: `Regiment "${regiment.name}" dissolved`,
    });

    return { dissolved: true };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /** Load the caller's regiment (single-tenant) or throw 404. */
  private async loadRegiment(regimentId: string): Promise<Regiment> {
    const regiment = await this.regiments.findOne({ where: { id: regimentId } });
    if (!regiment) {
      throw new NotFoundException('Regiment not found');
    }
    return regiment;
  }

  /**
   * A fully-populated (all roles × all capabilities, defaulting false) matrix
   * with each stored grant applied. Rows for unknown roles/capabilities are
   * ignored so a stale seed never widens the axes.
   */
  private buildMatrix(rows: RolePermission[]): Record<string, Record<string, boolean>> {
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of Object.values(MemberRole)) {
      matrix[role] = {};
      for (const capability of Object.values(Capability)) {
        matrix[role][capability] = false;
      }
    }
    for (const row of rows) {
      if (matrix[row.role] && row.capability in matrix[row.role]) {
        matrix[row.role][row.capability] = row.granted;
      }
    }
    return matrix;
  }

  /**
   * Floor guard: reject any matrix that would leave the regiment ungovernable —
   * the Owner must retain the core trio (ManageSettings, TransferOwnership,
   * ManageRoles) and at least one role must keep ManageSettings.
   */
  private assertGovernable(matrix: Record<string, Record<string, boolean>>): void {
    const owner = matrix[MemberRole.Owner] ?? {};
    const ownerRetainsCore =
      owner[Capability.ManageSettings] === true &&
      owner[Capability.TransferOwnership] === true &&
      owner[Capability.ManageRoles] === true;
    const someoneManagesSettings = Object.values(MemberRole).some(
      (role) => matrix[role]?.[Capability.ManageSettings] === true,
    );

    if (!ownerRetainsCore || !someoneManagesSettings) {
      throw new ForbiddenException('Cannot remove core Owner capabilities');
    }
  }

  /** A RegimentSettings shaped with the entity's documented column defaults. */
  private defaultSettings(regimentId: string): RegimentSettings {
    const settings = new RegimentSettings();
    settings.regimentId = regimentId;
    settings.publicRoster = true;
    settings.publicGallery = true;
    settings.publicEvents = true;
    settings.publicStats = true;
    settings.openRecruitment = true;
    settings.showOfficersMessOnLanding = true;
    settings.allowMercenaries = true;
    settings.autoApproveTrustedMembers = false;
    settings.galleryMaxImageSizeMb = 12;
    settings.galleryMaxVideoSizeMb = 80;
    settings.galleryMaxItemsPerSubmission = 10;
    settings.galleryAllowedImageTypes = null;
    settings.galleryAllowedVideoTypes = null;
    settings.eventDefaultTimezone = 'UTC';
    settings.eventDefaultStartTime = null;
    settings.eventDefaultNotifyBefore = null;
    settings.auditRetentionMonths = 12;
    return settings;
  }
}
