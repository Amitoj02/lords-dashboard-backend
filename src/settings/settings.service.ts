import {
  BadRequestException,
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
import {
  AuditSeverity,
  Capability,
  MemberRole,
  RegimentDocumentSlug,
  StorageTarget,
} from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { RegimentDocument } from '../regiments/entities/regiment-document.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { StorageService } from '../storage/storage.service';
import { PermissionsMatrixDto } from './dto/permissions-matrix.dto';
import { PresentationDto, UpdatePresentationDto } from './dto/presentation.dto';
import { AdminRegimentDocumentDto, UpdateRegimentDocumentDto } from './dto/regiment-document.dto';
import { SettingsDto } from './dto/settings.dto';
import { UpdatePermissionsDto } from './dto/update-permissions.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * Capabilities too sensitive to ever grant to the Applicant role (LDA-M17):
 * management, moderation, and secret-reveal powers. Applicant is the implicit
 * role of every authenticated identity-only session, so granting one of these to
 * it would hand the power to every signed-in Discord user.
 *
 * Deliberately EXCLUDED: the participation / read capabilities (apply, RSVP,
 * submit/view gallery, view directory) AND `manage_regiment_details` — the last
 * one is public-copy/legal-document authoring that T-0145 split out of
 * `manage_settings` precisely so it can be delegated (e.g. to a copy writer)
 * without handing over the control panel. Delegating any of these to Applicant is
 * a policy choice, not a privilege escalation.
 */
const PRIVILEGED_CAPABILITIES: ReadonlySet<Capability> = new Set([
  Capability.ManageSettings,
  Capability.ManageRoles,
  Capability.ViewAuditLog,
  Capability.EditRanksMedals,
  Capability.ManageApplications,
  Capability.ManageEvents,
  Capability.ModerateGallery,
  Capability.RevealEventPasswords,
]);

/** Editable keys that live on the regiment row (identity/branding/Discord invite). */
const REGIMENT_KEYS = [
  'name',
  'missionStatement',
  'accentTone',
  'crestUrl',
  'bannerUrl',
  'establishedYear',
  'establishedAt',
  'discordInviteUrl',
  'discordServerName',
] as const;

/**
 * Public-presentation keys that copy straight across from the DTO (T-0147).
 * Held SEPARATE from SETTINGS_KEYS on purpose: they live on the same row but
 * behind a different capability (ManageRegimentDetails), so PATCH
 * /api/settings must never be able to write them and PATCH
 * /api/settings/presentation must never be able to write anything else.
 *
 * The two banners are NOT here — they arrive as storage keys and are resolved
 * through the namespace validator first (see `applyBanner`).
 */
const PRESENTATION_KEYS = [
  'charterQuote',
  'charterQuoteAttribution',
  'loginQuote',
  'loginQuoteAttribution',
  'heroOverlayDensity',
  'loginOverlayDensity',
] as const;

/** DTO key -> (entity column, storage target) for the two banner uploads. */
const PRESENTATION_BANNERS = [
  ['heroBannerKey', 'heroBannerUrl', StorageTarget.RegimentHeroBanner],
  ['loginBannerKey', 'loginBannerUrl', StorageTarget.RegimentLoginBanner],
] as const;

/** Editable keys that live on the 1—1 regiment_settings row. */
const SETTINGS_KEYS = [
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
 * matrix (capability × role) with a governance "floor guard", and the one
 * remaining high-consequence lifecycle action, dissolution. Ownership transfer
 * and the Discord rebind both went in T-0170 — the guild binding now lives
 * solely behind POST /api/discord/bind, which is a strict superset. Every
 * read/write is scoped to the caller's regiment and every mutation is audited.
 * The permission matrix is the source of truth behind CapabilitiesGuard, so any
 * change invalidates the AuthzService cache.
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
    @InjectRepository(RegimentDocument)
    private readonly documents: Repository<RegimentDocument>,
    private readonly storage: StorageService,
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

  // ── Public presentation + legal documents (T-0147 / T-0149) ────────────────
  // These sit behind ManageRegimentDetails, NOT ManageSettings. Editing the copy
  // the whole internet sees is a publishing right, not an ownership right, so it
  // can be delegated to whoever writes it without also handing over ownership
  // transfer, the permission matrix or the Discord binding. Keeping them on
  // their own routes is what makes the split enforceable: a ManageSettings
  // holder cannot reach these, and a ManageRegimentDetails holder cannot reach
  // PATCH /api/settings.

  /** The presentation slice, for the admin editor. */
  async getPresentation(user: AuthenticatedUser): Promise<PresentationDto> {
    const settings = await this.settings.findOne({ where: { regimentId: user.regimentId } });
    return PresentationDto.from(settings);
  }

  /**
   * Apply only the provided presentation keys and audit the diff. An explicit
   * `null` CLEARS a field back to the shipped default, so the guard is
   * `!== undefined` rather than a truthiness test — otherwise a meaningful
   * `0` overlay density would be silently unwritable.
   */
  async updatePresentation(
    user: AuthenticatedUser,
    dto: UpdatePresentationDto,
    ip: string | null,
  ): Promise<PresentationDto> {
    const regiment = await this.loadRegiment(user.regimentId);
    const existing = await this.settings.findOne({ where: { regimentId: user.regimentId } });
    const settings = existing ?? this.settings.create(this.defaultSettings(user.regimentId));

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const dtoRec = dto as Record<string, unknown>;
    const setRec = settings as unknown as Record<string, unknown>;

    for (const key of PRESENTATION_KEYS) {
      if (dtoRec[key] === undefined) {
        continue;
      }
      // Normalise blank to null so "cleared in the editor" and "never set" are
      // one state, and the client needs exactly one fallback branch.
      const value = dtoRec[key] === '' ? null : dtoRec[key];
      if (value === setRec[key]) {
        continue;
      }
      before[key] = setRec[key];
      setRec[key] = value;
      after[key] = value;
    }

    // Banners arrive as storage keys. Resolving through the namespace validator
    // is what stops a caller from publishing an arbitrary URL — or another
    // target's key — as the regiment's public background.
    for (const [dtoKey, column, target] of PRESENTATION_BANNERS) {
      const submitted = dtoRec[dtoKey];
      if (submitted === undefined) {
        continue;
      }
      const url =
        typeof submitted === 'string' && submitted.length > 0
          ? this.storage.resolveKeyToPublicUrl(user, submitted, target)
          : null;
      if (url === setRec[column]) {
        continue;
      }
      before[column] = setRec[column];
      setRec[column] = url;
      after[column] = url;
    }

    if (Object.keys(after).length > 0) {
      await this.settings.save(settings);
      await this.audit.record({
        regimentId: user.regimentId,
        action: 'regiment.presentation.update',
        actor: AuditService.actorFromUser(user, ip),
        target: { type: 'regiment', id: regiment.id, label: regiment.name },
        before,
        after,
      });
    }

    return PresentationDto.from(settings);
  }

  /**
   * All three legal documents for the admin editor, including who last saved
   * each. Always returns one entry per slug — a slug with no row yet projects as
   * `body: null`, which the editor shows as "not yet written" and the public
   * page renders as its shipped fallback.
   */
  async getDocuments(user: AuthenticatedUser): Promise<AdminRegimentDocumentDto[]> {
    const rows = await this.documents.find({
      where: { regimentId: user.regimentId },
      relations: { updatedByMember: true },
    });
    return Object.values(RegimentDocumentSlug).map((slug) =>
      AdminRegimentDocumentDto.fromAdmin(slug, rows.find((row) => row.slug === slug) ?? null),
    );
  }

  /**
   * Upsert one legal document. A blank body is stored as NULL rather than an
   * empty string, so clearing the editor restores the shipped fallback instead
   * of publishing an empty privacy policy.
   *
   * The audit entry records the slug and the body LENGTH, not the bodies
   * themselves: a 60,000-character before/after pair on every save would bloat
   * the ledger — and the Discord mirror of it — for no diagnostic gain.
   */
  async updateDocument(
    user: AuthenticatedUser,
    slug: RegimentDocumentSlug,
    dto: UpdateRegimentDocumentDto,
    ip: string | null,
  ): Promise<AdminRegimentDocumentDto> {
    const regiment = await this.loadRegiment(user.regimentId);
    const existing = await this.documents.findOne({
      where: { regimentId: user.regimentId, slug },
    });

    const body = dto.body && dto.body.trim().length > 0 ? dto.body : null;
    const previousLength = existing?.body?.length ?? 0;

    const document =
      existing ?? this.documents.create({ regimentId: user.regimentId, slug, body: null });
    document.body = body;
    document.updatedByMemberId = user.memberId ?? null;
    const saved = await this.documents.save(document);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'regiment.document.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'regiment_document', id: slug, label: slug },
      before: { length: previousLength },
      after: { length: body?.length ?? 0 },
      detail: `Updated the ${slug} document for ${regiment.name}`,
    });

    // Re-attach the author so the response carries their name: the entity we
    // just saved has only the FK column populated, not the relation.
    saved.updatedByMember = user.memberId
      ? await this.members.findOne({ where: { id: user.memberId } })
      : null;
    return AdminRegimentDocumentDto.fromAdmin(slug, saved);
  }

  /**
   * Mark first-run setup complete (T-0056): flips the regiment's
   * `setupComplete` flag so the Owner is no longer routed into first-run setup
   * (T-0037). Idempotent — a no-op (still returns the panel) if already complete.
   * Audited as a settings change.
   */
  async completeSetup(user: AuthenticatedUser, ip: string | null): Promise<SettingsDto> {
    const regiment = await this.loadRegiment(user.regimentId);
    const settings =
      (await this.settings.findOne({ where: { regimentId: user.regimentId } })) ??
      this.defaultSettings(user.regimentId);

    if (!regiment.setupComplete) {
      regiment.setupComplete = true;
      await this.regiments.save(regiment);
      await this.audit.record({
        regimentId: user.regimentId,
        action: 'settings.update',
        actor: AuditService.actorFromUser(user, ip),
        target: { type: 'regiment', id: regiment.id, label: regiment.name },
        before: { setupComplete: false },
        after: { setupComplete: true },
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
   * the regiment must remain governable: the Owner keeps ManageSettings and
   * ManageRoles, and at least one role retains ManageSettings. Only then are the
   * changed cells persisted, the authz cache invalidated, and the edit audited.
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
      // Applicant is the implicit fallback role for EVERY authenticated
      // identity-only session, so granting it a privileged capability would widen
      // that capability to all signed-in Discord users (LDA-M17). Forbid it.
      if (
        change.granted &&
        change.role === MemberRole.Applicant &&
        PRIVILEGED_CAPABILITIES.has(change.capability as Capability)
      ) {
        throw new BadRequestException(
          `The '${change.capability}' capability cannot be granted to the Applicant role`,
        );
      }
    }

    const rows = await this.permissions.find({ where: { regimentId: user.regimentId } });
    const matrix = this.buildMatrix(rows);
    for (const change of dto.changes) {
      matrix[change.role][change.capability] = change.granted;
    }

    this.assertGovernable(matrix);

    // Collapse duplicate (role, capability) cells so each is written exactly once
    // (last change wins) — two inserts for the same new cell would otherwise hit
    // the UNIQUE(regiment_id, role, capability) index. Persist the whole batch in
    // one transaction so a failure never leaves a partial, unaudited edit.
    const deduped = new Map<string, (typeof dto.changes)[number]>();
    for (const change of dto.changes) {
      deduped.set(`${change.role}\u0000${change.capability}`, change);
    }

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RolePermission);
      for (const change of deduped.values()) {
        const existing = rows.find(
          (row) => row.role === change.role && row.capability === change.capability,
        );
        if (existing) {
          await repo.update(
            { regimentId: user.regimentId, role: change.role, capability: change.capability },
            { granted: change.granted },
          );
        } else {
          await repo.save(
            repo.create({
              regimentId: user.regimentId,
              role: change.role,
              capability: change.capability,
              granted: change.granted,
            }),
          );
        }
      }
    });

    // Only after the batch commits: refresh the cache + audit the effective edit.
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
   * the Owner must retain the core pair (ManageSettings, ManageRoles) and at
   * least one role must keep ManageSettings. It was a trio until T-0170 retired
   * TransferOwnership; the floor shrank with the capability axis, not because
   * the guard got weaker.
   */
  private assertGovernable(matrix: Record<string, Record<string, boolean>>): void {
    const owner = matrix[MemberRole.Owner] ?? {};
    const ownerRetainsCore =
      owner[Capability.ManageSettings] === true && owner[Capability.ManageRoles] === true;
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
    // Presentation (T-0146): null everywhere means "use the shipped copy". The
    // SPA owns the fallback, so an unconfigured regiment still renders a
    // complete landing and login page.
    settings.heroBannerUrl = null;
    settings.loginBannerUrl = null;
    settings.charterQuote = null;
    settings.charterQuoteAttribution = null;
    settings.loginQuote = null;
    settings.loginQuoteAttribution = null;
    settings.heroOverlayDensity = null;
    settings.loginOverlayDensity = null;
    return settings;
  }
}
