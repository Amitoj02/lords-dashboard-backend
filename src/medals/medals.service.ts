import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { StorageTarget } from '../common/enums';
import { StorageService } from '../storage/storage.service';
import { CreateMedalDto } from './dto/create-medal.dto';
import { LinkDiscordDto } from './dto/link-discord.dto';
import { MedalDto } from './dto/medal.dto';
import { ReorderMedalsDto } from './dto/reorder-medals.dto';
import { UpdateMedalDto } from './dto/update-medal.dto';
import { Medal } from './entities/medal.entity';
import { MemberMedal } from './entities/member-medal.entity';

/**
 * Temporary offset added to every medal's precedence during a reorder. Mirrors
 * the ranks reorder: all rows are first shifted clear of the 1..N target range,
 * then written to their final positions. Medal precedence is NOT unique so this
 * is belt-and-braces (kept for parity with ranks). Assumes a regiment never has
 * anywhere near this many medals.
 */
const REORDER_OFFSET = 1000;

/** Derived award counts for a medal (see {@link MedalsService.awardStats}). */
interface AwardStats {
  /** Distinct members who currently hold the medal. */
  holders: number;
  /** Total award rows (a member may hold the same medal more than once). */
  awards: number;
}

/**
 * Medal *catalogue* CRUD (per regiment). Awarding medals TO members lives in the
 * members module — this service only manages the lookup rows. Every query is
 * scoped to the caller's regiment (single-tenant); list enrichment (holders/award
 * counts) is batched into one grouped query to avoid N+1. Every mutation writes
 * an audit row.
 */
@Injectable()
export class MedalsService {
  constructor(
    @InjectRepository(Medal)
    private readonly medals: Repository<Medal>,
    @InjectRepository(MemberMedal)
    private readonly memberMedals: Repository<MemberMedal>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /**
   * List every medal for the caller's regiment, ordered by precedence, each
   * enriched with its distinct-holder and total-award counts. The counts for the
   * whole list are gathered in a single grouped query (no per-row N+1).
   */
  async findAll(user: AuthenticatedUser): Promise<MedalDto[]> {
    const medals = await this.medals.find({
      where: { regimentId: user.regimentId },
      order: { precedence: 'ASC' },
    });

    const stats = await this.awardStats(medals.map((m) => m.id));

    return medals.map((medal) => {
      const s = stats.get(medal.id);
      return MedalDto.from(medal, s?.holders ?? 0, s?.awards ?? 0);
    });
  }

  /**
   * Create a medal. `title` must be unique within the regiment. When no
   * precedence is supplied the medal is placed at the end of the ladder
   * (max precedence + 1). Audited as `medal.create`.
   */
  async create(user: AuthenticatedUser, dto: CreateMedalDto, ip: string | null): Promise<MedalDto> {
    await this.assertTitleFree(user.regimentId, dto.title);

    const precedence = dto.precedence ?? (await this.nextPrecedence(user.regimentId));
    const imageUrl = await this.resolveIconImage(user, dto.imageKey ?? null);

    const medal = this.medals.create({
      regimentId: user.regimentId,
      title: dto.title,
      glyph: dto.glyph,
      description: dto.description ?? null,
      imageUrl,
      precedence,
      discordRoleName: dto.discordRoleName ?? null,
      linked: false,
    });
    const saved = await this.medals.save(medal);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'medal.create',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'medal', id: saved.id, label: saved.title },
      after: this.snapshot(saved),
    });

    // A freshly created medal has no awards yet.
    return MedalDto.from(saved, 0, 0);
  }

  /**
   * Partially update a medal. Only provided fields are applied; a changed title
   * is re-checked for uniqueness. Captures before/after for the `medal.update`
   * audit row. 404 when the medal is not in the caller's regiment.
   */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateMedalDto,
    ip: string | null,
  ): Promise<MedalDto> {
    const medal = await this.loadOrFail(user, id);
    const before = this.snapshot(medal);

    if (dto.title !== undefined && dto.title !== medal.title) {
      await this.assertTitleFree(user.regimentId, dto.title, medal.id);
      medal.title = dto.title;
    }
    if (dto.glyph !== undefined) medal.glyph = dto.glyph;
    if (dto.description !== undefined) medal.description = dto.description ?? null;
    if (dto.imageKey !== undefined) {
      medal.imageUrl = await this.resolveIconImage(user, dto.imageKey || null);
    }
    if (dto.precedence !== undefined) medal.precedence = dto.precedence;
    if (dto.discordRoleName !== undefined) medal.discordRoleName = dto.discordRoleName ?? null;

    const saved = await this.medals.save(medal);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'medal.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'medal', id: saved.id, label: saved.title },
      before,
      after: this.snapshot(saved),
    });

    return this.project(saved);
  }

  /**
   * Delete a medal. Blocked when the medal has ever been awarded (any
   * member_medals rows reference it) — deleting would orphan award history.
   * Audited as `medal.delete`.
   */
  async remove(user: AuthenticatedUser, id: string, ip: string | null): Promise<void> {
    const medal = await this.loadOrFail(user, id);

    const awardsCount = await this.memberMedals.count({ where: { medalId: medal.id } });
    if (awardsCount > 0) {
      throw new ConflictException(
        `Medal has been awarded to ${awardsCount} members and cannot be deleted`,
      );
    }

    await this.medals.remove(medal);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'medal.delete',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'medal', id: medal.id, label: medal.title },
      before: this.snapshot(medal),
    });
  }

  /**
   * Transactionally rewrite the whole catalogue's precedence from a full, ordered
   * list of medal ids. The set must match the regiment's medals exactly. Mirrors
   * the ranks reorder: all rows are first shifted by REORDER_OFFSET, then written
   * to their final 1..N positions (medal precedence is not UNIQUE, so the shift is
   * belt-and-braces, kept for parity). Audited as `medal.reorder`.
   */
  async reorder(
    user: AuthenticatedUser,
    dto: ReorderMedalsDto,
    ip: string | null,
  ): Promise<MedalDto[]> {
    const medals = await this.medals.find({ where: { regimentId: user.regimentId } });
    const existingIds = new Set(medals.map((m) => m.id));
    const requestedIds = new Set(dto.order);

    const sameSize = dto.order.length === medals.length && requestedIds.size === dto.order.length;
    const sameMembers = dto.order.every((id) => existingIds.has(id));
    if (!sameSize || !sameMembers) {
      throw new BadRequestException('order must list every medal id of the regiment exactly once');
    }

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Medal);
      // Shift all rows clear of the 1..N target range, then assign final positions.
      await repo.increment({ regimentId: user.regimentId }, 'precedence', REORDER_OFFSET);
      for (let i = 0; i < dto.order.length; i++) {
        await repo.update({ id: dto.order[i], regimentId: user.regimentId }, { precedence: i + 1 });
      }
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'medal.reorder',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'medal', label: 'catalogue' },
      detail: `Reordered ${dto.order.length} medals.`,
    });

    return this.findAll(user);
  }

  /**
   * Map the medal to a Discord role and flag it linked. Recorded as a
   * `medal.update` audit row (there is no dedicated link action code).
   */
  async linkDiscord(
    user: AuthenticatedUser,
    id: string,
    dto: LinkDiscordDto,
    ip: string | null,
  ): Promise<MedalDto> {
    const medal = await this.loadOrFail(user, id);
    const before = this.snapshot(medal);

    medal.discordRoleId = dto.discordRoleId;
    if (dto.discordRoleName !== undefined) medal.discordRoleName = dto.discordRoleName ?? null;
    medal.linked = true;

    const saved = await this.medals.save(medal);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'medal.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'medal', id: saved.id, label: saved.title },
      before,
      after: this.snapshot(saved),
    });

    return this.project(saved);
  }

  /**
   * Clear a medal's Discord role mapping and flag it unlinked. Recorded as a
   * `medal.update` audit row (reusing the link action code — no dedicated
   * unlink code) with a detail note.
   */
  async unlinkDiscord(user: AuthenticatedUser, id: string, ip: string | null): Promise<MedalDto> {
    const medal = await this.loadOrFail(user, id);
    const before = this.snapshot(medal);

    medal.discordRoleId = null;
    medal.discordRoleName = null;
    medal.linked = false;

    const saved = await this.medals.save(medal);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'medal.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'medal', id: saved.id, label: saved.title },
      before,
      after: this.snapshot(saved),
      detail: 'Unlinked from Discord role.',
    });

    return this.project(saved);
  }

  /** Load a regiment-scoped medal or throw 404. */
  private async loadOrFail(user: AuthenticatedUser, id: string): Promise<Medal> {
    const medal = await this.medals.findOne({ where: { id, regimentId: user.regimentId } });
    if (!medal) {
      throw new NotFoundException('Medal not found');
    }
    return medal;
  }

  /** Throw 409 when a medal with `title` already exists (excluding `exceptId`). */
  private async assertTitleFree(
    regimentId: string,
    title: string,
    exceptId?: string,
  ): Promise<void> {
    const existing = await this.medals.findOne({ where: { regimentId, title } });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException('A medal with this title already exists');
    }
  }

  /** Next precedence value = current max + 1 (1 when the regiment has no medals). */
  private async nextPrecedence(regimentId: string): Promise<number> {
    const row = await this.medals
      .createQueryBuilder('medal')
      .select('MAX(medal.precedence)', 'max')
      .where('medal.regimentId = :regimentId', { regimentId })
      .getRawOne<{ max: string | null }>();
    const max = row?.max != null ? Number(row.max) : 0;
    return max + 1;
  }

  /**
   * One grouped query mapping medalId -> { holders (distinct members), awards
   * (total rows) } for the given medals. Returns an empty map for an empty list.
   */
  private async awardStats(medalIds: string[]): Promise<Map<string, AwardStats>> {
    if (medalIds.length === 0) return new Map();
    const rows = await this.memberMedals
      .createQueryBuilder('mm')
      .select('mm.medalId', 'medalId')
      .addSelect('COUNT(*)', 'awards')
      .addSelect('COUNT(DISTINCT mm.memberId)', 'holders')
      .where('mm.medalId IN (:...medalIds)', { medalIds })
      .groupBy('mm.medalId')
      .getRawMany<{ medalId: string; awards: string; holders: string }>();
    return new Map(
      rows.map((r) => [r.medalId, { holders: Number(r.holders), awards: Number(r.awards) }]),
    );
  }

  /** Project a single saved medal, computing its current award counts. */
  private async project(medal: Medal): Promise<MedalDto> {
    const stats = await this.awardStats([medal.id]);
    const s = stats.get(medal.id);
    return MedalDto.from(medal, s?.holders ?? 0, s?.awards ?? 0);
  }

  /** Field snapshot used for audit before/after values. */
  private snapshot(medal: Medal): Record<string, unknown> {
    return {
      title: medal.title,
      glyph: medal.glyph,
      description: medal.description,
      imageUrl: medal.imageUrl,
      precedence: medal.precedence,
      discordRoleName: medal.discordRoleName,
      discordRoleId: medal.discordRoleId,
      linked: medal.linked,
    };
  }

  /**
   * Resolve an uploaded medal-image key to its persisted public URL, enforcing the
   * 250px dimension cap first (T-0125). A null/empty key clears the image.
   */
  private async resolveIconImage(
    user: AuthenticatedUser,
    key: string | null,
  ): Promise<string | null> {
    if (!key) {
      return null;
    }
    await this.storage.assertIconWithinDimensions(key);
    return this.storage.resolveKeyToPublicUrl(user, key, StorageTarget.MedalImage);
  }
}
