import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventStatus, MemberRole, MemberStatus } from '../common/enums';
import { RegimentEvent } from '../events/entities/event.entity';
import { Member } from '../members/entities/member.entity';
import { RegimentProfileDto } from './dto/regiment-profile.dto';
import { MembersByRole, RegimentStatsDto } from './dto/regiment-stats.dto';
import { RegimentSettings } from './entities/regiment-settings.entity';
import { Regiment } from './entities/regiment.entity';

/** Roles that count as enrolled roster members (everything except Applicant). */
const ENROLLED_ROLES: MemberRole[] = [
  MemberRole.Owner,
  MemberRole.Admin,
  MemberRole.Moderator,
  MemberRole.Member,
  MemberRole.Mercenary,
];

/**
 * Public regiment profile + landing statistics. The system is single-tenant, so
 * every read resolves "the" regiment (the oldest non-dissolved row) rather than
 * scoping by an authenticated caller — both endpoints are public. All counters
 * are computed with grouped/COUNT queries; no rows are materialised.
 */
@Injectable()
export class RegimentsService {
  constructor(
    @InjectRepository(Regiment)
    private readonly regiments: Repository<Regiment>,
    @InjectRepository(RegimentSettings)
    private readonly settings: Repository<RegimentSettings>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(RegimentEvent)
    private readonly events: Repository<RegimentEvent>,
  ) {}

  /** Public profile of the single regiment, enriched with its member count. */
  async getProfile(): Promise<RegimentProfileDto> {
    const regiment = await this.resolveRegiment();
    const memberCount = await this.members.count({ where: { regimentId: regiment.id } });
    return RegimentProfileDto.from(regiment, memberCount);
  }

  /**
   * Landing counters for the single regiment. Honours the `publicStats` privacy
   * flag — a private regiment returns 403 rather than leaking aggregates.
   */
  async getStats(): Promise<RegimentStatsDto> {
    const regiment = await this.resolveRegiment();

    const settings = await this.settings.findOne({ where: { regimentId: regiment.id } });
    if (settings && settings.publicStats === false) {
      throw new ForbiddenException('Regiment statistics are private');
    }

    const membersByRole = await this.memberCountsByRole(regiment.id);
    const totalMembers = ENROLLED_ROLES.reduce((sum, role) => sum + membersByRole[role], 0);
    const enrolledExcludingMercenaries = ENROLLED_ROLES.filter(
      (role) => role !== MemberRole.Mercenary,
    ).reduce((sum, role) => sum + membersByRole[role], 0);

    const [activeMembers, totalEvents, upcomingEvents, previousEvents] = await Promise.all([
      this.members.count({ where: { regimentId: regiment.id, status: MemberStatus.Active } }),
      this.events.count({ where: { regimentId: regiment.id } }),
      this.events.count({
        where: { regimentId: regiment.id, status: EventStatus.Upcoming, isArchived: false },
      }),
      this.events.count({ where: { regimentId: regiment.id, status: EventStatus.Previous } }),
    ]);

    const dto = new RegimentStatsDto();
    dto.totalMembers = totalMembers;
    dto.enrolledExcludingMercenaries = enrolledExcludingMercenaries;
    dto.activeMembers = activeMembers;
    dto.membersByRole = membersByRole;
    dto.totalEvents = totalEvents;
    dto.upcomingEvents = upcomingEvents;
    dto.previousEvents = previousEvents;
    dto.establishedYear = regiment.establishedYear;
    dto.establishedAt = regiment.establishedAt;
    return dto;
  }

  /**
   * Resolve THE regiment (single-tenant): the oldest non-dissolved row. The
   * `dissolvedAt` soft-delete column is auto-excluded by TypeORM. 404 when none.
   */
  private async resolveRegiment(): Promise<Regiment> {
    const [regiment] = await this.regiments.find({ order: { createdAt: 'ASC' }, take: 1 });
    if (!regiment) {
      throw new NotFoundException('Regiment not found');
    }
    return regiment;
  }

  /**
   * One grouped query mapping role -> count for non-deleted members. Every role
   * key is present (defaulting to 0) so the response shape is stable.
   */
  private async memberCountsByRole(regimentId: string): Promise<MembersByRole> {
    const rows = await this.members
      .createQueryBuilder('member')
      .select('member.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .where('member.regimentId = :regimentId', { regimentId })
      .andWhere('member.deletedAt IS NULL')
      .groupBy('member.role')
      .getRawMany<{ role: MemberRole; count: string }>();

    const byRole = Object.values(MemberRole).reduce((acc, role) => {
      acc[role] = 0;
      return acc;
    }, {} as MembersByRole);

    for (const row of rows) {
      byRole[row.role] = Number(row.count);
    }
    return byRole;
  }
}
