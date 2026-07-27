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
import { AuditSeverity, StorageTarget } from '../common/enums';
import { DiscordRolePolicyService } from '../discord/discord-role-policy.service';
import { DiscordSyncService } from '../discord/discord-sync.service';
import { Member } from '../members/entities/member.entity';
import { StorageService } from '../storage/storage.service';
import { CreateRankDto } from './dto/create-rank.dto';
import { LinkDiscordDto } from './dto/link-discord.dto';
import { RankDto } from './dto/rank.dto';
import { ReorderRanksDto } from './dto/reorder-ranks.dto';
import { UpdateRankDto } from './dto/update-rank.dto';
import { Rank } from './entities/rank.entity';
import { protectedRankReason } from './protected-ranks';

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
    // Re-linking a rank's Discord role has to reach every holder; the fan-out is
    // enqueued through the outbox, never applied inline (T-0158).
    private readonly discordSync: DiscordSyncService,
    // Validates that a target Discord role is safe to link (LDA-H1).
    private readonly rolePolicy: DiscordRolePolicyService,
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
   * Create a rank. When `precedence` is omitted the rank is appended at the end of
   * the ladder. Duplicate name/precedence within the regiment (the two UNIQUE
   * indexes) surface as a 409. The insignia is a custom uploaded icon (`imageKey`).
   */
  async create(user: AuthenticatedUser, dto: CreateRankDto, ip: string | null): Promise<RankDto> {
    await this.assertNameFree(user.regimentId, dto.name);
    if (dto.precedence !== undefined) {
      await this.assertPrecedenceFree(user.regimentId, dto.precedence);
    }

    const precedence = dto.precedence ?? (await this.nextPrecedence(user.regimentId));
    const imageUrl = await this.resolveIconImage(user, dto.imageKey ?? null);

    const rank = this.ranks.create({
      regimentId: user.regimentId,
      name: dto.name,
      imageUrl,
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
   *
   * A protected rank's NAME is frozen (T-0190); everything else about it —
   * precedence, insignia, Discord role — stays as editable as any other rank.
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
      // Only a CHANGED name is refused: the admin console posts the whole rank
      // body on every save, so rejecting the mere presence of `name` would block
      // an icon or precedence edit on a protected rank.
      this.assertNotProtected(rank, 'renamed');
      await this.assertNameFree(user.regimentId, dto.name, id);
      rank.name = dto.name;
    }
    if (dto.precedence !== undefined && dto.precedence !== rank.precedence) {
      await this.assertPrecedenceFree(user.regimentId, dto.precedence, id);
      rank.precedence = dto.precedence;
    }
    if (dto.imageKey !== undefined) {
      rank.imageUrl = await this.resolveIconImage(user, dto.imageKey || null);
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
   *
   * A protected rank is refused outright, before the holder count: an empty
   * Recruit ladder is exactly when the FK would NOT have stopped the delete
   * (T-0190).
   */
  async remove(user: AuthenticatedUser, id: string, ip: string | null): Promise<void> {
    const rank = await this.loadRank(id, user.regimentId);
    this.assertNotProtected(rank, 'deleted');

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
   * display name) and mark it linked. Audited as a rank.update, and — when the
   * role actually changed — followed by a bulk re-link of every holder.
   *
   * A role carrying privileged Discord permissions no longer blocks the link
   * (T-0189); it comes back as `discordRoleWarning` for the admin UI to surface
   * and raises the audit row to `warn` so the ledger says what was accepted.
   */
  async linkDiscord(
    user: AuthenticatedUser,
    id: string,
    dto: LinkDiscordDto,
    ip: string | null,
  ): Promise<RankDto> {
    const rank = await this.loadRank(id, user.regimentId);
    const before = this.snapshot(rank);
    const previousRoleId = rank.discordRoleId;

    // Reject roles the bot CANNOT assign — above/equal the bot, integration-
    // managed, or not in the guild (LDA-H1). A privileged role is allowed through
    // with an advisory instead (T-0189). No-op while the bot is mocked (validation
    // defers until a real bot runs); the DTO still enforces the snowflake format.
    const warning = await this.rolePolicy.checkRoleLinkable(dto.discordRoleId);

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
      // The warning is the whole reason this row matters after the fact: with the
      // 400 gone, the ledger is where "someone linked a rank to an admin role"
      // survives, so it says so in the detail AND wears the severity.
      detail: warning
        ? `Linked to Discord role ${saved.discordRoleId}. ${warning}`
        : `Linked to Discord role ${saved.discordRoleId}.`,
      severity: warning ? AuditSeverity.Warn : undefined,
    });
    const relinkBatchId = await this.fanOutRelink(user, saved, previousRoleId, ip);

    const holders = await this.holderCountFor(saved.id);
    return RankDto.from(saved, holders, relinkBatchId, warning);
  }

  /**
   * Clear a rank's Discord role binding: null the snowflake id and display name
   * and mark it unlinked. Audited as a rank.update (reusing the link action code)
   * with a detail note.
   */
  async unlinkDiscord(user: AuthenticatedUser, id: string, ip: string | null): Promise<RankDto> {
    const rank = await this.loadRank(id, user.regimentId);
    const before = this.snapshot(rank);
    const previousRoleId = rank.discordRoleId;

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
    // An unlink is a re-link to nothing: holders must LOSE the old role.
    const relinkBatchId = await this.fanOutRelink(user, saved, previousRoleId, ip);

    const holders = await this.holderCountFor(saved.id);
    return RankDto.from(saved, holders, relinkBatchId);
  }

  /**
   * Queue the bulk re-link for a rank whose Discord role mapping just changed
   * and record the ONE audit row that stands for the whole action — who did it,
   * which role left, which arrived, and how many members are affected. A row per
   * member would bury the ladder's history under a single admin click.
   *
   * No-ops silently when nothing was queued (bot disabled, role syncing off, the
   * role did not actually change, or the rank has no linked holders).
   */
  private async fanOutRelink(
    user: AuthenticatedUser,
    rank: Rank,
    previousRoleId: string | null,
    ip: string | null,
  ): Promise<string | null> {
    const batch = await this.discordSync.enqueueRoleRelink({
      regimentId: user.regimentId,
      subject: 'rank',
      subjectId: rank.id,
      subjectLabel: rank.name,
      previousRoleId,
      nextRoleId: rank.discordRoleId,
      // Exclude the actor so they cannot self-grant via this fan-out (LDA-H1).
      excludeMemberId: user.memberId ?? null,
    });
    if (!batch) return null;

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'discord.role.relink',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'rank', id: rank.id, label: rank.name },
      before: { discordRoleId: previousRoleId },
      after: { discordRoleId: rank.discordRoleId },
      detail:
        `Re-linked from Discord role ${previousRoleId ?? '(none)'} to ` +
        `${rank.discordRoleId ?? '(none)'}; queued ${batch.affected} member role updates ` +
        `(batch ${batch.batchId}).`,
    });
    return batch.batchId;
  }

  /**
   * Refuse a rename or a delete on a rank the server resolves BY NAME (T-0190).
   *
   * 403 rather than 409: this is not a state the admin can clear by reassigning
   * holders or picking another value — the rule holds for every caller, including
   * the Owner, for as long as the code behind it does. Deliberately NOT gated on
   * a capability, for the same reason `MemberRole.Owner` cannot be assigned
   * through the API: no permission grants it.
   */
  private assertNotProtected(rank: Rank, verb: 'renamed' | 'deleted'): void {
    const because = protectedRankReason(rank.name);
    if (!because) return;
    throw new ForbiddenException(
      `"${rank.name}" is required by the dashboard and cannot be ${verb}, ` +
        `because ${because}. Its position, insignia and Discord role can still ` +
        'be changed.',
    );
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
      imageUrl: rank.imageUrl,
      precedence: rank.precedence,
      discordRoleName: rank.discordRoleName,
      discordRoleId: rank.discordRoleId,
      linked: rank.linked,
    };
  }

  /**
   * Resolve an uploaded rank-icon key to its persisted public URL, enforcing the
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
    return this.storage.resolveKeyToPublicUrl(user, key, StorageTarget.RankImage);
  }
}
