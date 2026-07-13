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
import { Member } from '../members/entities/member.entity';
import { StorageService } from '../storage/storage.service';
import { CreateRankDto } from './dto/create-rank.dto';
import { LinkDiscordDto } from './dto/link-discord.dto';
import { RankDto } from './dto/rank.dto';
import { ReorderRanksDto } from './dto/reorder-ranks.dto';
import { UpdateRankDto } from './dto/update-rank.dto';
import { Rank } from './entities/rank.entity';

/**
 * Temporary offset added to every rank's precedence during a reorder. Because
 * (regimentId, precedence) is UNIQUE, we cannot assign the final 1..N values in
 * place without transient collisions, so the transaction first shifts all rows
 * clear of the target range, then writes the final positions. Assumes a regiment
 * never has anywhere near this many ranks.
 */
const REORDER_OFFSET = 1000;

/**
 * Editable rank ladder for the caller's regiment. Reads are open to any
 * authenticated member; every mutation requires EditRanksMedals (enforced at the
 * controller) and writes an audit row. All queries are regiment-scoped and the
 * list's holder counts are batched into ONE grouped query (no per-row N+1).
 */
@Injectable()
export class RanksService {
  constructor(
    @InjectRepository(Rank)
    private readonly ranks: Repository<Rank>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    private readonly dataSource: DataSource,
    // AuditService is global; used by every mutation below.
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /**
   * The full ladder for the caller's regiment, ordered top-to-bottom. Each rank
   * is enriched with `holdersCount` from a single grouped members query.
   */
  async findAll(user: AuthenticatedUser): Promise<RankDto[]> {
    const ranks = await this.ranks.find({
      where: { regimentId: user.regimentId },
      order: { precedence: 'ASC' },
    });

    const holdersByRank = await this.holderCounts(ranks.map((r) => r.id));

    return ranks.map((rank) => RankDto.from(rank, holdersByRank.get(rank.id) ?? 0));
  }

  /**
   * Create a rank. `chevrons` defaults to 0; when `precedence` is omitted the
   * rank is appended at the end of the ladder. Duplicate name/precedence within
   * the regiment (the two UNIQUE indexes) surface as a 409.
   */
  async create(user: AuthenticatedUser, dto: CreateRankDto, ip: string | null): Promise<RankDto> {
    await this.assertNameFree(user.regimentId, dto.name);
    if (dto.precedence !== undefined) {
      await this.assertPrecedenceFree(user.regimentId, dto.precedence);
    }

    const precedence = dto.precedence ?? (await this.nextPrecedence(user.regimentId));

    const rank = this.ranks.create({
      regimentId: user.regimentId,
      name: dto.name,
      chevrons: dto.chevrons ?? 0,
      imageUrl: dto.imageKey
        ? this.storage.resolveKeyToPublicUrl(user, dto.imageKey, StorageTarget.RankImage)
        : null,
      precedence,
      discordRoleName: dto.discordRoleName ?? null,
      discordRoleId: null,
      linked: false,
    });
    const saved = await this.ranks.save(rank);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'rank.create',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'rank', id: saved.id, label: saved.name },
      after: this.snapshot(saved),
    });

    // A brand-new rank has no holders yet.
    return RankDto.from(saved, 0);
  }

  /**
   * Update a regiment-scoped rank (404 otherwise). Re-checks name/precedence
   * uniqueness for changed fields (excluding the row itself) and records the
   * before/after snapshot on the audit row.
   */
  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateRankDto,
    ip: string | null,
  ): Promise<RankDto> {
    const rank = await this.loadRank(id, user.regimentId);
    const before = this.snapshot(rank);

    if (dto.name !== undefined && dto.name !== rank.name) {
      await this.assertNameFree(user.regimentId, dto.name, id);
      rank.name = dto.name;
    }
    if (dto.precedence !== undefined && dto.precedence !== rank.precedence) {
      await this.assertPrecedenceFree(user.regimentId, dto.precedence, id);
      rank.precedence = dto.precedence;
    }
    if (dto.chevrons !== undefined) rank.chevrons = dto.chevrons;
    if (dto.imageKey !== undefined) {
      rank.imageUrl = dto.imageKey
        ? this.storage.resolveKeyToPublicUrl(user, dto.imageKey, StorageTarget.RankImage)
        : null;
    }
    if (dto.discordRoleName !== undefined) rank.discordRoleName = dto.discordRoleName;

    const saved = await this.ranks.save(rank);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'rank.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'rank', id: saved.id, label: saved.name },
      before,
      after: this.snapshot(saved),
    });

    const holders = await this.holderCountFor(saved.id);
    return RankDto.from(saved, holders);
  }

  /**
   * Delete a regiment-scoped rank. The member.rankId FK is RESTRICT, so a rank
   * still worn by anyone cannot be removed — guard it here (counting soft-deleted
   * members too, since their rows still hold the FK) and surface a friendly 409.
   */
  async remove(user: AuthenticatedUser, id: string, ip: string | null): Promise<void> {
    const rank = await this.loadRank(id, user.regimentId);

    const inUse = await this.members.count({ where: { rankId: id }, withDeleted: true });
    if (inUse > 0) {
      throw new ConflictException(`Rank is in use by ${inUse} members`);
    }

    // Capture identity before remove() strips the entity's id.
    const target = { type: 'rank', id: rank.id, label: rank.name };
    const before = this.snapshot(rank);
    await this.ranks.remove(rank);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'rank.delete',
      actor: AuditService.actorFromUser(user, ip),
      target,
      before,
    });
  }

  /**
   * Transactionally rewrite the whole ladder's precedence from a full, ordered
   * list of rank ids. The set must match the regiment's ranks exactly. To respect
   * the UNIQUE (regimentId, precedence) index, all rows are first shifted by
   * REORDER_OFFSET, then written to their final 1..N positions.
   */
  async reorder(
    user: AuthenticatedUser,
    dto: ReorderRanksDto,
    ip: string | null,
  ): Promise<RankDto[]> {
    const ranks = await this.ranks.find({ where: { regimentId: user.regimentId } });
    const existingIds = new Set(ranks.map((r) => r.id));
    const requestedIds = new Set(dto.order);

    const sameSize = dto.order.length === ranks.length && requestedIds.size === dto.order.length;
    const sameMembers = dto.order.every((id) => existingIds.has(id));
    if (!sameSize || !sameMembers) {
      throw new BadRequestException('order must list every rank id of the regiment exactly once');
    }

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Rank);
      // Shift all rows clear of the 1..N target range to dodge unique collisions.
      await repo.increment({ regimentId: user.regimentId }, 'precedence', REORDER_OFFSET);
      // Assign the final positions in requested order.
      for (let i = 0; i < dto.order.length; i++) {
        await repo.update({ id: dto.order[i], regimentId: user.regimentId }, { precedence: i + 1 });
      }
    });

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'rank.reorder',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'rank', label: 'ladder' },
      detail: `Reordered ${dto.order.length} ranks.`,
    });

    return this.findAll(user);
  }

  /**
   * Bind a rank to a Discord role: set its snowflake id (and optionally a fresh
   * display name) and mark it linked. Audited as a rank.update.
   */
  async linkDiscord(
    user: AuthenticatedUser,
    id: string,
    dto: LinkDiscordDto,
    ip: string | null,
  ): Promise<RankDto> {
    const rank = await this.loadRank(id, user.regimentId);
    const before = this.snapshot(rank);

    rank.discordRoleId = dto.discordRoleId;
    if (dto.discordRoleName !== undefined) rank.discordRoleName = dto.discordRoleName;
    rank.linked = true;

    const saved = await this.ranks.save(rank);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'rank.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'rank', id: saved.id, label: saved.name },
      before,
      after: this.snapshot(saved),
      detail: `Linked to Discord role ${saved.discordRoleId}.`,
    });

    const holders = await this.holderCountFor(saved.id);
    return RankDto.from(saved, holders);
  }

  /**
   * Clear a rank's Discord role binding: null the snowflake id and display name
   * and mark it unlinked. Audited as a rank.update (reusing the link action code)
   * with a detail note.
   */
  async unlinkDiscord(user: AuthenticatedUser, id: string, ip: string | null): Promise<RankDto> {
    const rank = await this.loadRank(id, user.regimentId);
    const before = this.snapshot(rank);

    rank.discordRoleId = null;
    rank.discordRoleName = null;
    rank.linked = false;

    const saved = await this.ranks.save(rank);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'rank.update',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'rank', id: saved.id, label: saved.name },
      before,
      after: this.snapshot(saved),
      detail: 'Unlinked from Discord role.',
    });

    const holders = await this.holderCountFor(saved.id);
    return RankDto.from(saved, holders);
  }

  /** Load a regiment-scoped rank or throw 404. */
  private async loadRank(id: string, regimentId: string): Promise<Rank> {
    const rank = await this.ranks.findOne({ where: { id, regimentId } });
    if (!rank) {
      throw new NotFoundException('Rank not found');
    }
    return rank;
  }

  /**
   * One grouped query mapping rankId -> live holder count for the given ranks.
   * Soft-deleted members are excluded (they are not part of the active roster).
   * Returns an empty map for an empty ladder.
   */
  private async holderCounts(rankIds: string[]): Promise<Map<string, number>> {
    if (rankIds.length === 0) return new Map();
    const rows = await this.members
      .createQueryBuilder('member')
      .select('member.rankId', 'rankId')
      .addSelect('COUNT(*)', 'count')
      .where('member.rankId IN (:...rankIds)', { rankIds })
      .andWhere('member.deletedAt IS NULL')
      .groupBy('member.rankId')
      .getRawMany<{ rankId: string; count: string }>();
    return new Map(rows.map((r) => [r.rankId, Number(r.count)]));
  }

  /** Live holder count for a single rank (soft-deleted members excluded). */
  private holderCountFor(rankId: string): Promise<number> {
    return this.members.count({ where: { rankId } });
  }

  /** Next free precedence = max(precedence) + 1 (1 when the ladder is empty). */
  private async nextPrecedence(regimentId: string): Promise<number> {
    const row = await this.ranks
      .createQueryBuilder('rank')
      .select('MAX(rank.precedence)', 'max')
      .where('rank.regimentId = :regimentId', { regimentId })
      .getRawOne<{ max: number | null }>();
    return Number(row?.max ?? 0) + 1;
  }

  /** 409 if another rank in the regiment already uses `name`. */
  private async assertNameFree(regimentId: string, name: string, exceptId?: string): Promise<void> {
    const existing = await this.ranks.findOne({ where: { regimentId, name } });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException('A rank with this name already exists');
    }
  }

  /** 409 if another rank in the regiment already sits at `precedence`. */
  private async assertPrecedenceFree(
    regimentId: string,
    precedence: number,
    exceptId?: string,
  ): Promise<void> {
    const existing = await this.ranks.findOne({ where: { regimentId, precedence } });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException('A rank with this precedence already exists');
    }
  }

  /** The audited, human-meaningful fields of a rank (for before/after diffs). */
  private snapshot(rank: Rank): Record<string, unknown> {
    return {
      name: rank.name,
      chevrons: rank.chevrons,
      imageUrl: rank.imageUrl,
      precedence: rank.precedence,
      discordRoleName: rank.discordRoleName,
      discordRoleId: rank.discordRoleId,
      linked: rank.linked,
    };
  }
}
