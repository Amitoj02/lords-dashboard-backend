import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { AuditService } from '../audit/audit.service';
import { EventStatus } from '../common/enums';
import { EventAttendee } from '../events/entities/event-attendee.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { MemberDto, MemberMetrics } from './dto/member.dto';
import { MemberQueryDto } from './dto/member-query.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { Member } from './entities/member.entity';

/**
 * Roster read/profile service. Every query is scoped to the caller's regiment
 * (single-tenant) and excludes soft-deleted rows. Derived fields — rank,
 * chevrons, confirmed attendance and attendance rate — are computed server-side;
 * the client is never trusted for them. List attendance is batched into one
 * grouped query to avoid N+1.
 */
@Injectable()
export class MembersService {
  constructor(
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(EventAttendee)
    private readonly attendees: Repository<EventAttendee>,
    @InjectRepository(RegimentEvent)
    private readonly events: Repository<RegimentEvent>,
    // AuditService is global; retained for the future admin members endpoint
    // (role/status/rank changes that emit member.role.change). Self-service
    // edits deliberately emit no audit row.
    private readonly audit: AuditService,
  ) {}

  /**
   * Paginated, filtered roster for the caller's regiment. Joins rank + Discord
   * identity, applies search/role/status/rank filters, orders by rank precedence
   * then name, and enriches each row with attendance metrics.
   */
  async findAll(
    query: MemberQueryDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedResponseDto<MemberDto>> {
    const qb = this.members
      .createQueryBuilder('member')
      .leftJoinAndSelect('member.rank', 'rank')
      .leftJoinAndSelect('member.discordIdentity', 'identity')
      .where('member.regimentId = :regimentId', { regimentId: user.regimentId })
      .andWhere('member.deletedAt IS NULL');

    if (query.search) {
      const term = `%${query.search.toLowerCase()}%`;
      qb.andWhere(
        '(LOWER(member.name) LIKE :term OR LOWER(member.inGameName) LIKE :term OR LOWER(identity.discordTag) LIKE :term)',
        { term },
      );
    }
    if (query.role) {
      qb.andWhere('member.role = :role', { role: query.role });
    }
    if (query.status) {
      qb.andWhere('member.status = :status', { status: query.status });
    }
    if (query.rankId) {
      qb.andWhere('member.rankId = :rankId', { rankId: query.rankId });
    }

    qb.orderBy('rank.precedence', 'ASC')
      .addOrderBy('member.name', 'ASC')
      .skip(query.skip)
      .take(query.limit);

    const [rows, total] = await qb.getManyAndCount();

    // Compute shared denominator once, then batch the attendance counts for the
    // whole page in a single grouped query (no per-row N+1).
    const totalPastEvents = await this.countPastEvents(user.regimentId);
    const attendanceByMember = await this.attendanceCounts(rows.map((m) => m.id));

    const data = rows.map((member) =>
      MemberDto.from(
        member,
        this.metricsFor(attendanceByMember.get(member.id) ?? 0, totalPastEvents),
      ),
    );

    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  /**
   * Single member projection. 404 when the member does not exist, belongs to a
   * different regiment, or is soft-deleted. Attendance is counted for just this
   * member.
   */
  async findOne(id: string, user: AuthenticatedUser): Promise<MemberDto> {
    const member = await this.loadMember(id, user.regimentId);
    const totalPastEvents = await this.countPastEvents(user.regimentId);
    const eventsAttended = await this.attendees.count({ where: { memberId: member.id } });
    return MemberDto.from(member, this.metricsFor(eventsAttended, totalPastEvents));
  }

  /**
   * Self-service profile update. A member may only edit their own profile — any
   * mismatch with the authenticated member id is forbidden. Only the restricted
   * set of fields (platform/timezone/inGameName/avatarUrl) is mutable here.
   *
   * TODO(admin): changing another member's role/status/rank — which emits a
   * `member.role.change` audit row — belongs to a future admin members endpoint
   * and is intentionally out of scope for this self-service handler.
   */
  async updateSelf(id: string, dto: UpdateMemberDto, user: AuthenticatedUser): Promise<MemberDto> {
    if (user.memberId !== id) {
      throw new ForbiddenException('You can only edit your own profile');
    }

    const member = await this.loadMember(id, user.regimentId);

    if (dto.platform !== undefined) member.platform = dto.platform;
    if (dto.timezone !== undefined) member.timezone = dto.timezone;
    if (dto.inGameName !== undefined) member.inGameName = dto.inGameName;
    // TODO(storage): avatarUrl is a plain URL today; swap for an uploaded asset later.
    if (dto.avatarUrl !== undefined) member.avatarUrl = dto.avatarUrl;

    const saved = await this.members.save(member);

    // No audit row: a self profile edit never touches role/status/rank, so there
    // is no security-relevant change to record.

    const totalPastEvents = await this.countPastEvents(user.regimentId);
    const eventsAttended = await this.attendees.count({ where: { memberId: saved.id } });
    return MemberDto.from(saved, this.metricsFor(eventsAttended, totalPastEvents));
  }

  /** Load a regiment-scoped, non-deleted member with its rank + identity, or 404. */
  private async loadMember(id: string, regimentId: string): Promise<Member> {
    const member = await this.members.findOne({
      where: { id, regimentId },
      relations: { rank: true, discordIdentity: true },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    return member;
  }

  /** Count of past (previous, non-archived) events — the attendance denominator. */
  private countPastEvents(regimentId: string): Promise<number> {
    return this.events.count({
      where: { regimentId, status: EventStatus.Previous, isArchived: false },
    });
  }

  /**
   * One grouped query mapping memberId -> confirmed attendance count for the
   * given page of members. Returns an empty map for an empty page.
   */
  private async attendanceCounts(memberIds: string[]): Promise<Map<string, number>> {
    if (memberIds.length === 0) return new Map();
    const rows = await this.attendees
      .createQueryBuilder('attendee')
      .select('attendee.memberId', 'memberId')
      .addSelect('COUNT(*)', 'count')
      .where('attendee.memberId IN (:...memberIds)', { memberIds })
      .groupBy('attendee.memberId')
      .getRawMany<{ memberId: string; count: string }>();
    return new Map(rows.map((r) => [r.memberId, Number(r.count)]));
  }

  /** Derive the attendance metrics (rate clamped 0..100; 0 when no past events). */
  private metricsFor(eventsAttended: number, totalPastEvents: number): MemberMetrics {
    if (totalPastEvents <= 0) {
      return { eventsAttended, attendanceRate: 0 };
    }
    const rate = Math.round((eventsAttended / totalPastEvents) * 100);
    return { eventsAttended, attendanceRate: Math.max(0, Math.min(100, rate)) };
  }
}
