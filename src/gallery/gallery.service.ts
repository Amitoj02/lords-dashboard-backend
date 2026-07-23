import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { AuthzService } from '../authz/authz.service';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import {
  Capability,
  GalleryMediaType,
  GalleryStatus,
  MemberRole,
  StorageTarget,
} from '../common/enums';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { StorageService } from '../storage/storage.service';
import { CreateGalleryItemDto } from './dto/create-gallery-item.dto';
import { DeclineGalleryDto } from './dto/decline-gallery.dto';
import {
  GalleryFileDto,
  GalleryItemDto,
  GallerySubmissionSummaryDto,
} from './dto/gallery-item.dto';
import { GalleryQueryDto } from './dto/gallery-query.dto';
import { UpdateGalleryItemDto } from './dto/update-gallery-item.dto';
import { GalleryFile } from './entities/gallery-file.entity';
import { GalleryItem } from './entities/gallery-item.entity';
import { GalleryLike } from './entities/gallery-like.entity';
import { GalleryTag } from './entities/gallery-tag.entity';

/** Fallbacks mirroring the regiment_settings column defaults (used when no row exists). */
const DEFAULT_MAX_ITEMS_PER_SUBMISSION = 10;
const DEFAULT_MAX_IMAGE_SIZE_MB = 12;
const DEFAULT_MAX_VIDEO_SIZE_MB = 80;

/** Roles trusted for gallery auto-approval when the regiment opts in. */
const TRUSTED_ROLES: MemberRole[] = [MemberRole.Owner, MemberRole.Admin];

/** The like state returned by the like/unlike endpoints. */
export interface GalleryLikeState {
  likesCount: number;
  liked: boolean;
}

/**
 * Gallery submissions + moderation. The public feed is unauthenticated and
 * resolves the single-tenant regiment from its settings row (there is no caller
 * to scope by); every authenticated read/write is scoped to the caller's
 * regiment and excludes soft-deleted rows. Submissions land in the moderation
 * queue unless the regiment auto-approves trusted staff. Multi-table writes
 * (item + files + tags) run in a transaction; every moderation mutation is
 * audited. List enrichment (files, like counts, tagged members) is batched into
 * grouped queries to avoid N+1.
 */
@Injectable()
export class GalleryService {
  private readonly logger = new Logger(GalleryService.name);

  constructor(
    @InjectRepository(GalleryItem)
    private readonly items: Repository<GalleryItem>,
    @InjectRepository(GalleryFile)
    private readonly files: Repository<GalleryFile>,
    @InjectRepository(GalleryLike)
    private readonly likes: Repository<GalleryLike>,
    @InjectRepository(GalleryTag)
    private readonly tags: Repository<GalleryTag>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(RegimentSettings)
    private readonly settings: Repository<RegimentSettings>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    // Capability checks for the author-or-moderator delete path (T-0121).
    private readonly authz: AuthzService,
    // Resolves uploaded file keys to public URLs (namespace-validated).
    private readonly storage: StorageService,
    // Best-effort decline DMs to the submitter (never fails the decision).
    private readonly discordSync: DiscordSyncService,
  ) {}

  // ── Public feed (unauthenticated — no caller to scope by) ────────────────────

  /**
   * Public gallery feed: approved, non-draft items for the single regiment.
   * Honours the `publicGallery` privacy flag (403 when disabled). Never sets
   * `liked` — a public caller has no member context.
   */
  async findPublic(query: GalleryQueryDto): Promise<PaginatedResponseDto<GalleryItemDto>> {
    const settings = await this.resolveSettings();
    if (settings && settings.publicGallery === false) {
      throw new ForbiddenException('The gallery is private');
    }
    if (!settings) {
      return new PaginatedResponseDto([], 0, query.page, query.limit);
    }
    return this.listItems(settings.regimentId, GalleryStatus.Approved, query, null);
  }

  /** Public view of a single approved item (404 otherwise). Honours `publicGallery`. */
  async findOnePublic(id: string): Promise<GalleryItemDto> {
    const settings = await this.resolveSettings();
    // Mirror findPublic: with no settings row there is no resolvable public
    // gallery, so a single item is treated as not found (never served unscoped).
    if (!settings) {
      throw new NotFoundException('Gallery item not found');
    }
    if (settings.publicGallery === false) {
      throw new ForbiddenException('The gallery is private');
    }

    const where: FindOptionsWhere<GalleryItem> = {
      id,
      regimentId: settings.regimentId,
      status: GalleryStatus.Approved,
      isDraft: false,
    };
    const item = await this.items.findOne({
      where,
      relations: { author: { discordIdentity: true } },
    });
    if (!item) {
      throw new NotFoundException('Gallery item not found');
    }
    return this.projectOne(item, null);
  }

  // ── Authenticated member archive ─────────────────────────────────────────────

  /**
   * Authenticated archive: approved items for the caller's regiment, IGNORING
   * the `publicGallery` flag (T-0086). Populated for any signed-in roster member
   * even when the public archive is off. Scoped to the caller's regiment and
   * passes their memberId so the per-item `liked` flag is populated.
   */
  findArchive(
    user: AuthenticatedUser,
    query: GalleryQueryDto,
  ): Promise<PaginatedResponseDto<GalleryItemDto>> {
    return this.listItems(user.regimentId, GalleryStatus.Approved, query, user.memberId);
  }

  // ── Moderation queue ─────────────────────────────────────────────────────────

  /**
   * Items awaiting moderation, scoped to the caller's regiment. The `status`
   * query param (T-0089) selects the bucket — pending (default), approved, or
   * declined — so the FE can populate each moderation tab. Declined items carry
   * their `declineReason` through the projection.
   */
  moderationQueue(
    user: AuthenticatedUser,
    query: GalleryQueryDto,
  ): Promise<PaginatedResponseDto<GalleryItemDto>> {
    return this.listItems(
      user.regimentId,
      query.status ?? GalleryStatus.Pending,
      query,
      user.memberId,
    );
  }

  /**
   * Lean list of pending submissions for the dashboard "Gallery submissions"
   * panel (T-0094): just `{ id, title, submitterUsername }`, newest first. Gated
   * by ManageEvents at the controller (the panel is visible to events managers);
   * moderation actions remain ModerateGallery.
   */
  async pendingSummary(user: AuthenticatedUser): Promise<GallerySubmissionSummaryDto[]> {
    const rows = await this.items
      .createQueryBuilder('item')
      .leftJoin('item.author', 'author')
      .select('item.id', 'id')
      .addSelect('item.title', 'title')
      .addSelect('author.inGameName', 'submitterUsername')
      .where('item.regimentId = :regimentId', { regimentId: user.regimentId })
      .andWhere('item.status = :status', { status: GalleryStatus.Pending })
      .andWhere('item.isDraft = :isDraft', { isDraft: false })
      .andWhere('item.deletedAt IS NULL')
      .orderBy('item.submittedAt', 'DESC')
      .getRawMany<{ id: string; title: string; submitterUsername: string | null }>();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      submitterUsername: row.submitterUsername ?? null,
    }));
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  /**
   * Submit a gallery item. Forces Pending unless the regiment auto-approves
   * trusted staff (Owner/Admin) — enforcing the per-submission item count and
   * per-type size caps from regiment_settings first. Writes the item, its files
   * and tagged members atomically, then audits the submission. A submission with
   * no poster key simply stores no thumbnail.
   */
  async submit(
    user: AuthenticatedUser,
    dto: CreateGalleryItemDto,
    ip: string | null,
  ): Promise<GalleryItemDto> {
    // Extract to a const local so the non-null narrowing survives into the closure.
    const memberId = user.memberId;
    if (!memberId) {
      throw new ForbiddenException('Only enrolled members can submit to the gallery');
    }

    const settings = await this.settings.findOne({ where: { regimentId: user.regimentId } });
    const files = dto.files ?? [];
    this.assertWithinLimits(files, settings);

    // The video poster frame (T-0152) is captured client-side and uploaded like
    // any other asset, so it arrives as a KEY: resolving it through the poster
    // namespace is the only thing standing between the item's thumbnail and an
    // arbitrary attacker-chosen URL. Resolved before the transaction so a bad
    // key fails the request before any row is written.
    const posterUrl = dto.posterKey
      ? this.storage.resolveKeyToPublicUrl(user, dto.posterKey, StorageTarget.GalleryPoster)
      : null;

    const autoApprove = !!settings?.autoApproveTrustedMembers && TRUSTED_ROLES.includes(user.role);
    const now = new Date();
    const status = autoApprove ? GalleryStatus.Approved : GalleryStatus.Pending;

    const saved = await this.dataSource.transaction(async (manager) => {
      const itemRepo = manager.getRepository(GalleryItem);
      const fileRepo = manager.getRepository(GalleryFile);
      const tagRepo = manager.getRepository(GalleryTag);

      const item = await itemRepo.save(
        itemRepo.create({
          regimentId: user.regimentId,
          authorMemberId: memberId,
          moderatedByMemberId: autoApprove ? memberId : null,
          title: dto.title,
          caption: dto.caption ?? null,
          type: dto.type,
          linkUrl: dto.linkUrl ?? null,
          thumbnailUrl: posterUrl,
          status,
          declineReason: null,
          isDraft: false,
          submittedAt: now,
          approvedAt: autoApprove ? now : null,
        }),
      );

      if (files.length > 0) {
        await fileRepo.save(
          files.map((file) =>
            fileRepo.create({
              galleryItemId: item.id,
              fileName: file.fileName,
              // Uploaded files reference a storage key; its namespace is
              // re-validated and resolved to the public URL persisted here. A file
              // with no key stores no URL — arbitrary client URLs are NOT accepted
              // (they would bypass the namespace check).
              url: file.key
                ? this.storage.resolveKeyToPublicUrl(user, file.key, StorageTarget.Gallery)
                : null,
              mediaType: file.mediaType,
              sizeBytes: file.sizeBytes ?? null,
              width: file.width ?? null,
              height: file.height ?? null,
              durationSeconds: file.durationSeconds ?? null,
              caption: file.caption ?? null,
              thumbnailColor: file.thumbnailColor ?? null,
            }),
          ),
        );
      }

      const tags = dto.tags ?? [];
      if (tags.length > 0) {
        // De-dupe and cap defensively (the DTO also enforces @ArrayMaxSize(10)).
        const unique = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 10);
        if (unique.length > 0) {
          await tagRepo.insert(unique.map((tag) => ({ galleryItemId: item.id, tag })));
        }
      }

      return item;
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'gallery.submit',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'gallery', id: saved.id, label: saved.title },
      detail: autoApprove ? 'Auto-approved (trusted member)' : null,
    });

    const reloaded = await this.loadItem(saved.id, user.regimentId, {});
    return this.projectOne(reloaded, memberId);
  }

  /** Approve a pending/declined item. Audited. */
  async approve(user: AuthenticatedUser, id: string, ip: string | null): Promise<GalleryItemDto> {
    const item = await this.loadItem(id, user.regimentId, {});
    item.status = GalleryStatus.Approved;
    item.approvedAt = new Date();
    item.moderatedByMemberId = user.memberId;
    item.declineReason = null;
    const saved = await this.items.save(item);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'gallery.approve',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'gallery', id: saved.id, label: saved.title },
    });

    return this.projectOne(saved, user.memberId);
  }

  /** Decline an item with an optional reason. Audited. */
  async decline(
    user: AuthenticatedUser,
    id: string,
    dto: DeclineGalleryDto,
    ip: string | null,
  ): Promise<GalleryItemDto> {
    const item = await this.loadItem(id, user.regimentId, {});
    item.status = GalleryStatus.Declined;
    item.declineReason = dto.reason ?? null;
    item.moderatedByMemberId = user.memberId;
    const saved = await this.items.save(item);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'gallery.decline',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'gallery', id: saved.id, label: saved.title },
      detail: dto.reason ?? null,
    });

    // Best-effort decline DM to the submitter (never affects the decision).
    await this.enqueueDeclineDm(user.regimentId, saved.authorMemberId, saved.title, dto.reason);

    return this.projectOne(saved, user.memberId);
  }

  /**
   * Moderator edit of an item's title, caption and/or tags (ModerateGallery). The
   * media itself (type, files, links) is not editable here. Only the fields
   * present on the DTO are touched; `tags`, when provided, replaces the whole tag
   * set (deduped/trimmed/capped, mirroring submit()). Runs the scalar writes and
   * the tag replacement in one transaction, then audits. Audited.
   */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateGalleryItemDto,
    ip: string | null,
  ): Promise<GalleryItemDto> {
    const item = await this.loadItem(id, user.regimentId, {});

    await this.dataSource.transaction(async (manager) => {
      const itemRepo = manager.getRepository(GalleryItem);
      const tagRepo = manager.getRepository(GalleryTag);

      // Title/caption are scalar edits on the item row — batch them into one save.
      let itemDirty = false;
      if (dto.title !== undefined) {
        // The column is NOT NULL; a whitespace-only title (which slips past the
        // DTO's @MinLength) is rejected rather than persisted as blank.
        const trimmed = dto.title.trim();
        if (trimmed.length === 0) {
          throw new BadRequestException('Title cannot be empty');
        }
        item.title = trimmed;
        itemDirty = true;
      }
      if (dto.caption !== undefined) {
        const trimmed = dto.caption.trim();
        item.caption = trimmed.length > 0 ? trimmed : null;
        itemDirty = true;
      }
      if (itemDirty) {
        await itemRepo.save(item);
      }

      if (dto.tags !== undefined) {
        // Wholesale replace: gallery_tags has a composite PK (galleryItemId, tag),
        // so delete-then-insert (never bare insert) avoids duplicate-key collisions.
        await tagRepo.delete({ galleryItemId: item.id });
        const unique = [...new Set(dto.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 10);
        if (unique.length > 0) {
          await tagRepo.insert(unique.map((tag) => ({ galleryItemId: item.id, tag })));
        }
      }
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'gallery.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'gallery', id: item.id, label: item.title },
    });

    // `item` carries the freshly-saved caption + author relation; projectOne
    // re-queries the replaced tags via tagsFor(), so no reload is needed.
    return this.projectOne(item, user.memberId);
  }

  /** Idempotently like an item for the caller. Returns the fresh like state. */
  async like(user: AuthenticatedUser, id: string): Promise<GalleryLikeState> {
    const memberId = this.requireMember(user);
    // onlyApproved: likes apply solely to publicly-visible items — a member must
    // not be able to like (or probe the existence of) a pending/declined item.
    const item = await this.loadItem(id, user.regimentId, { onlyApproved: true });

    const existing = await this.likes.findOne({
      where: { galleryItemId: item.id, memberId },
    });
    if (!existing) {
      await this.likes.save(
        this.likes.create({ galleryItemId: item.id, memberId, likedAt: new Date() }),
      );
    }

    const likesCount = await this.likes.count({ where: { galleryItemId: item.id } });
    return { likesCount, liked: true };
  }

  /** Idempotently remove the caller's like. Returns the fresh like state. */
  async unlike(user: AuthenticatedUser, id: string): Promise<GalleryLikeState> {
    const memberId = this.requireMember(user);
    const item = await this.loadItem(id, user.regimentId, { onlyApproved: true });

    await this.likes.delete({ galleryItemId: item.id, memberId });
    const likesCount = await this.likes.count({ where: { galleryItemId: item.id } });
    return { likesCount, liked: false };
  }

  /**
   * Soft-delete an item and purge its stored media objects. Authorized to the
   * post AUTHOR or a moderator (ModerateGallery) — the controller no longer gates
   * this route on the capability so an author can remove their own post (T-0121).
   * Regiment scoping is preserved by {@link loadItem} (a cross-regiment id 404s
   * before this check). The row is soft-removed (recoverable) but the backing
   * MinIO/S3 objects are deleted best-effort so orphaned bytes don't outlive the
   * item; a storage outage can never block the softRemove or the audit row.
   * Audited.
   */
  async remove(user: AuthenticatedUser, id: string, ip: string | null): Promise<void> {
    const item = await this.loadItem(id, user.regimentId, {});

    // Author OR moderator. The author check is exact (a member deleting their own
    // post); everyone else must hold ModerateGallery within the regiment.
    const isAuthor = !!user.memberId && item.authorMemberId === user.memberId;
    if (!isAuthor) {
      const canModerate = await this.authz.can(
        user.regimentId,
        user.role,
        Capability.ModerateGallery,
      );
      if (!canModerate) {
        throw new ForbiddenException('You can only delete your own gallery posts');
      }
    }

    // GalleryFile has no soft-delete column, so its rows remain readable after
    // softRemove — load them first to know which objects to purge.
    const files = await this.files.find({ where: { galleryItemId: item.id } });
    await this.items.softRemove(item);

    for (const file of files) {
      if (file.url) {
        await this.storage.deleteObject(file.url);
      }
    }
    // The poster frame (T-0152) is a stored object of its own, so it has to be
    // purged with the media or it outlives the item it belonged to. deleteObject
    // ignores anything outside the storage base, so a legacy externally-hosted
    // thumbnail is a no-op here.
    if (item.thumbnailUrl) {
      await this.storage.deleteObject(item.thumbnailUrl);
    }

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'gallery.delete',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'gallery', id: item.id, label: item.title },
    });
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /**
   * Shared list builder: a regiment-scoped, status-filtered, non-draft page of
   * items ordered newest-submitted first, enriched with files/likes/tags/author.
   * `viewerMemberId` (when present) drives the per-item `liked` flag.
   */
  private async listItems(
    regimentId: string,
    status: GalleryStatus,
    query: GalleryQueryDto,
    viewerMemberId: string | null,
  ): Promise<PaginatedResponseDto<GalleryItemDto>> {
    const qb = this.items
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.author', 'author')
      // Nested identity so the author avatar can fall back to the Discord avatar.
      .leftJoinAndSelect('author.discordIdentity', 'authorIdentity')
      .where('item.regimentId = :regimentId', { regimentId })
      .andWhere('item.status = :status', { status })
      .andWhere('item.isDraft = :isDraft', { isDraft: false })
      .andWhere('item.deletedAt IS NULL');

    if (query.type) {
      qb.andWhere('item.type = :type', { type: query.type });
    }

    const [rows, total] = await qb
      .orderBy('item.submittedAt', 'DESC')
      .skip(query.skip)
      .take(query.limit)
      .getManyAndCount();

    const data = await this.projectMany(rows, viewerMemberId);
    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  /** Load a regiment-scoped item (with author) or 404; optionally require Approved. */
  private async loadItem(
    id: string,
    regimentId: string,
    opts: { onlyApproved?: boolean },
  ): Promise<GalleryItem> {
    const where: FindOptionsWhere<GalleryItem> = { id, regimentId };
    if (opts.onlyApproved) {
      where.status = GalleryStatus.Approved;
    }
    const item = await this.items.findOne({
      where,
      relations: { author: { discordIdentity: true } },
    });
    if (!item) {
      throw new NotFoundException('Gallery item not found');
    }
    return item;
  }

  /** Project a single loaded item, batching its enrichment (a one-element page). */
  private async projectOne(
    item: GalleryItem,
    viewerMemberId: string | null,
  ): Promise<GalleryItemDto> {
    const [dto] = await this.projectMany([item], viewerMemberId);
    return dto;
  }

  /**
   * Enrich a page of items into DTOs, batching the files/likes/tagged-member
   * lookups into one grouped query each (no per-row N+1). When `viewerMemberId`
   * is set, a single query resolves the caller's liked set for the page.
   */
  private async projectMany(
    items: GalleryItem[],
    viewerMemberId: string | null,
  ): Promise<GalleryItemDto[]> {
    if (items.length === 0) {
      return [];
    }
    const itemIds = items.map((item) => item.id);
    const [filesByItem, likeCounts, tagsByItem, likedSet] = await Promise.all([
      this.filesFor(itemIds),
      this.likeCountsFor(itemIds),
      this.tagsFor(itemIds),
      viewerMemberId ? this.likedSetFor(itemIds, viewerMemberId) : Promise.resolve(null),
    ]);

    return items.map((item) =>
      GalleryItemDto.from(item, {
        files: filesByItem.get(item.id) ?? [],
        likesCount: likeCounts.get(item.id) ?? 0,
        tags: tagsByItem.get(item.id) ?? [],
        author: item.author
          ? {
              memberId: item.author.id,
              name: item.author.inGameName,
              // Custom avatar first, then the linked Discord avatar (mirrors member.dto).
              avatarUrl: item.author.avatarUrl ?? item.author.discordIdentity?.avatarUrl ?? null,
            }
          : null,
        liked: likedSet ? likedSet.has(item.id) : undefined,
      }),
    );
  }

  /** One query mapping itemId -> its file DTOs for the page. */
  private async filesFor(itemIds: string[]): Promise<Map<string, GalleryFileDto[]>> {
    const map = new Map<string, GalleryFileDto[]>();
    if (itemIds.length === 0) {
      return map;
    }
    const files = await this.files.find({
      where: { galleryItemId: In(itemIds) },
      order: { fileName: 'ASC' },
    });
    for (const file of files) {
      const list = map.get(file.galleryItemId) ?? [];
      list.push(GalleryFileDto.from(file));
      map.set(file.galleryItemId, list);
    }
    return map;
  }

  /** One grouped query mapping itemId -> like count for the page. */
  private async likeCountsFor(itemIds: string[]): Promise<Map<string, number>> {
    if (itemIds.length === 0) {
      return new Map();
    }
    const rows = await this.likes
      .createQueryBuilder('gl')
      .select('gl.galleryItemId', 'itemId')
      .addSelect('COUNT(*)', 'count')
      .where('gl.galleryItemId IN (:...itemIds)', { itemIds })
      .groupBy('gl.galleryItemId')
      .getRawMany<{ itemId: string; count: string }>();
    return new Map(rows.map((row) => [row.itemId, Number(row.count)]));
  }

  /** One query mapping itemId -> its free-form tags (mirrors EventsService.tagsFor). */
  private async tagsFor(itemIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (itemIds.length === 0) {
      return map;
    }
    const rows = await this.tags.find({
      where: { galleryItemId: In(itemIds) },
      order: { tag: 'ASC' },
    });
    for (const row of rows) {
      const list = map.get(row.galleryItemId) ?? [];
      list.push(row.tag);
      map.set(row.galleryItemId, list);
    }
    return map;
  }

  /** One query resolving which of the page's items the caller has liked. */
  private async likedSetFor(itemIds: string[], memberId: string): Promise<Set<string>> {
    if (itemIds.length === 0) {
      return new Set();
    }
    const rows = await this.likes.find({
      where: { galleryItemId: In(itemIds), memberId },
    });
    return new Set(rows.map((row) => row.galleryItemId));
  }

  /** Resolve THE regiment's settings row (single-tenant: the oldest row) or null. */
  private async resolveSettings(): Promise<RegimentSettings | null> {
    const [settings] = await this.settings.find({ order: { createdAt: 'ASC' }, take: 1 });
    return settings ?? null;
  }

  /** Guard: a submission may not exceed the configured item count / size caps. */
  private assertWithinLimits(
    files: CreateGalleryItemDto['files'],
    settings: RegimentSettings | null,
  ): void {
    const list = files ?? [];
    const maxItems = settings?.galleryMaxItemsPerSubmission ?? DEFAULT_MAX_ITEMS_PER_SUBMISSION;
    if (list.length > maxItems) {
      throw new BadRequestException(`A submission may include at most ${maxItems} files`);
    }

    const maxImageMb = settings?.galleryMaxImageSizeMb ?? DEFAULT_MAX_IMAGE_SIZE_MB;
    const maxVideoMb = settings?.galleryMaxVideoSizeMb ?? DEFAULT_MAX_VIDEO_SIZE_MB;
    const maxImageBytes = maxImageMb * 1024 * 1024;
    const maxVideoBytes = maxVideoMb * 1024 * 1024;

    // Allowed extension lists from settings (bare extensions, e.g. ['jpg','png']);
    // when a list is configured, every file of that kind must match it. Null/empty
    // lists mean "no restriction". This finally enforces the settings the wizard
    // exposes (previously stored + editable but never checked).
    const allowedImage = this.normalizeExtensions(settings?.galleryAllowedImageTypes);
    const allowedVideo = this.normalizeExtensions(settings?.galleryAllowedVideoTypes);

    for (const file of list) {
      const ext = this.extensionOf(file.key ?? file.fileName);
      if (file.mediaType === GalleryMediaType.Image) {
        if (allowedImage.length > 0 && (ext === null || !allowedImage.includes(ext))) {
          throw new BadRequestException(
            `Image "${file.fileName}" has a disallowed type (allowed: ${allowedImage.join(', ')})`,
          );
        }
      } else if (file.mediaType === GalleryMediaType.Video) {
        if (allowedVideo.length > 0 && (ext === null || !allowedVideo.includes(ext))) {
          throw new BadRequestException(
            `Video "${file.fileName}" has a disallowed type (allowed: ${allowedVideo.join(', ')})`,
          );
        }
      }

      if (file.sizeBytes == null) {
        continue;
      }
      const size = Number(file.sizeBytes);
      if (file.mediaType === GalleryMediaType.Image && size > maxImageBytes) {
        throw new BadRequestException(`Image "${file.fileName}" exceeds the ${maxImageMb}MB limit`);
      }
      if (file.mediaType === GalleryMediaType.Video && size > maxVideoBytes) {
        throw new BadRequestException(`Video "${file.fileName}" exceeds the ${maxVideoMb}MB limit`);
      }
    }
  }

  /** Lower-cased, dot-stripped allowed-extension list (tolerates '.jpg' or 'JPG'). */
  private normalizeExtensions(list: string[] | null | undefined): string[] {
    return (list ?? []).map((e) => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  }

  /** The lower-cased extension of a path/filename, or null when it has none. */
  private extensionOf(nameOrPath: string): string | null {
    const base = nameOrPath.split('/').pop() ?? nameOrPath;
    const dot = base.lastIndexOf('.');
    if (dot < 0 || dot === base.length - 1) return null;
    return base.slice(dot + 1).toLowerCase();
  }

  /**
   * Best-effort DM to a declined submission's author (T-0090). Resolves the
   * author's Discord user id one hop through their linked identity; silently
   * skips when there is no linked identity / Discord user. Wrapped so ANY
   * failure here can never affect the decline result (mirrors the applications
   * decision-DM pattern). Runs post-commit, and the underlying enqueue no-ops
   * when the bot is disabled.
   */
  private async enqueueDeclineDm(
    regimentId: string,
    authorMemberId: string,
    title: string,
    reason?: string | null,
  ): Promise<void> {
    try {
      const author = await this.members.findOne({
        where: { id: authorMemberId },
        relations: { discordIdentity: true },
      });
      const discordUserId = author?.discordIdentity?.discordUserId;
      if (!discordUserId) {
        return;
      }
      // COMPOSITION MOVED (T-0173): the DM text used to be assembled right here,
      // one of five services that each knew what a notification looks like. The
      // facts go to DiscordSyncService and it renders the moderation-outcome
      // embed — same colour language as an application decline.
      await this.discordSync.enqueueGalleryDecision(regimentId, {
        discordUserId,
        title,
        reason: reason?.trim() || null,
      });
    } catch (error) {
      this.logger.error(`Failed to enqueue gallery decline DM: ${(error as Error).message}`);
    }
  }

  /** Guard: the caller must be an enrolled member (has a memberId). */
  private requireMember(user: AuthenticatedUser): string {
    if (!user.memberId) {
      throw new ForbiddenException('Only enrolled members can perform this action');
    }
    return user.memberId;
  }
}
