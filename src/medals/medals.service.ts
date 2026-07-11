import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { CreateMedalDto } from './dto/create-medal.dto';
import { LinkDiscordDto } from './dto/link-discord.dto';
import { MedalDto } from './dto/medal.dto';
import { UpdateMedalDto } from './dto/update-medal.dto';
import { Medal } from './entities/medal.entity';
import { MemberMedal } from './entities/member-medal.entity';

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
    private readonly audit: AuditService,
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

    const medal = this.medals.create({
      regimentId: user.regimentId,
      title: dto.title,
      glyph: dto.glyph,
      ribbon: dto.ribbon,
      description: dto.description ?? null,
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
    if (dto.ribbon !== undefined) medal.ribbon = dto.ribbon;
    if (dto.description !== undefined) medal.description = dto.description ?? null;
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
      ribbon: medal.ribbon,
      description: medal.description,
      precedence: medal.precedence,
      discordRoleName: medal.discordRoleName,
      discordRoleId: medal.discordRoleId,
      linked: medal.linked,
    };
  }
}
