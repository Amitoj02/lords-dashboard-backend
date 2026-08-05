import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { MemberRole, MemberStatus } from '../../common/enums';
import { parseProfileHandle, profilePathFor } from '../../common/ids/username';
import { EventAttendee } from '../../events/entities/event-attendee.entity';
import { MemberMedal } from '../../medals/entities/member-medal.entity';
import { RegimentSettings } from '../../regiments/entities/regiment-settings.entity';
import { MemberMedalSummary } from '../dto/member.dto';
import { PublicMemberDto } from '../dto/public-member.dto';
import { Member } from '../entities/member.entity';
import {
  UsernameReservation,
  UsernameReservationReason,
} from '../entities/username-reservation.entity';
import { MemberAvatarService } from './member-avatar.service';
import { PublicMemberQueryDto } from './public-member-query.dto';

/** One row of the sitemap, for the SEO module. */
export interface PublicProfileRef {
  canonicalPath: string;
  updatedAt: Date;
}

@Injectable()
export class PublicMembersService {
  constructor(
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    @InjectRepository(MemberMedal)
    private readonly memberMedals: Repository<MemberMedal>,
    @InjectRepository(EventAttendee)
    private readonly attendees: Repository<EventAttendee>,
    @InjectRepository(UsernameReservation)
    private readonly reservations: Repository<UsernameReservation>,
    @InjectRepository(RegimentSettings)
    private readonly settings: Repository<RegimentSettings>,
    private readonly avatars: MemberAvatarService,
  ) {}

  /**
   * THE exclusion predicate. Every anonymous surface — the roster, a profile,
   * the sitemap and the crawler shell — narrows through this one method, so
   * they cannot drift apart and leave a member indexed on a page they were
   * removed from.
   *
   * Four exclusions, each for its own reason:
   *  - `Applicant` / `Pending` — publishing these labels a named person as
   *    "applied and not yet accepted". That is rejection-adjacent information
   *    about someone who has not joined anything yet, and it is not ours to
   *    broadcast. They are not filtered out of a public list, they have no
   *    public page at all.
   *  - banned, and currently suspended — disciplinary state. It must not be
   *    inferable from the presence or absence of a page either, which is why a
   *    suspended member 404s exactly like a stranger rather than 410-ing.
   *  - soft-deleted — the row is anonymised in place by the GDPR path and must
   *    never be re-published.
   *
   * `suspended_until <= NOW()` is treated as NOT suspended: the column is a
   * timestamp, not a status, so a lapsed suspension restores the profile
   * without anyone running anything.
   */
  private applyPublicPredicate<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    alias = 'member',
  ): SelectQueryBuilder<T> {
    return qb
      .andWhere(`${alias}.deletedAt IS NULL`)
      .andWhere(`${alias}.role NOT IN (:...hiddenRoles)`, {
        hiddenRoles: [MemberRole.Applicant],
      })
      .andWhere(`${alias}.status <> :hiddenStatus`, { hiddenStatus: MemberStatus.Pending })
      .andWhere(`${alias}.bannedAt IS NULL`)
      .andWhere(`(${alias}.suspendedUntil IS NULL OR ${alias}.suspendedUntil <= NOW())`);
  }

  /**
   * The single-tenant regiment id. Unlike the events and gallery equivalents
   * this enforces NO privacy flag — the roster and profiles are public by
   * product decision, with no per-member or regiment-wide opt-out — so the only
   * failure mode is a regiment that was never configured.
   */
  private async resolveRegimentId(): Promise<string> {
    const [settings] = await this.settings.find({ take: 1 });
    if (!settings) {
      throw new NotFoundException('Regiment not found');
    }
    return settings.regimentId;
  }

  /** The public roster: one page, ordered by rank precedence then name. */
  async list(query: PublicMemberQueryDto): Promise<PaginatedResponseDto<PublicMemberDto>> {
    const regimentId = await this.resolveRegimentId();

    const qb = this.members
      .createQueryBuilder('member')
      .leftJoinAndSelect('member.rank', 'rank')
      // The identity is joined for the avatar fallback ONLY. Nothing from it
      // reaches the DTO — see PublicMemberDto for why discordTag never can.
      .leftJoinAndSelect('member.discordIdentity', 'identity')
      .where('member.regimentId = :regimentId', { regimentId });
    this.applyPublicPredicate(qb);

    if (query.search) {
      // Same escaping as the authenticated roster: a user-supplied % or _ is
      // matched literally rather than turning the search into a full scan.
      const escaped = query.search
        .toLowerCase()
        .slice(0, 100)
        .replace(/[\\%_]/g, '\\$&');
      const term = `%${escaped}%`;
      // Searches the PUBLIC identifiers only. The authenticated roster also
      // matches discordTag; doing that here would let an anonymous caller
      // confirm a Discord handle belongs to a member without ever seeing it.
      qb.andWhere('(LOWER(member.inGameName) LIKE :term OR LOWER(member.username) LIKE :term)', {
        term,
      });
    }
    if (query.rankId) {
      qb.andWhere('member.rankId = :rankId', { rankId: query.rankId });
    }

    const [rows, total] = await qb
      .orderBy('rank.precedence', 'ASC')
      .addOrderBy('member.inGameName', 'ASC')
      .skip(query.skip)
      .take(query.limit)
      .getManyAndCount();

    const data = await this.projectMany(rows);
    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  /**
   * One public profile, addressed by `@handle` or by short id.
   *
   * Returns the member alongside the DTO because the callers need the row: the
   * HTTP controller to decide whether to redirect a short-id URL to the vanity
   * one, and the crawler shell to build `rel=canonical`.
   */
  async findByHandle(handle: string): Promise<{ dto: PublicMemberDto; member: Member }> {
    const regimentId = await this.resolveRegimentId();
    const parsed = parseProfileHandle(handle);
    if (!parsed) {
      throw new NotFoundException('Member not found');
    }

    const qb = this.members
      .createQueryBuilder('member')
      .leftJoinAndSelect('member.rank', 'rank')
      .leftJoinAndSelect('member.discordIdentity', 'identity')
      .where('member.regimentId = :regimentId', { regimentId });

    if ('username' in parsed) {
      qb.andWhere('member.username = :username', { username: parsed.username });
    } else {
      qb.andWhere('member.id = :id', { id: parsed.shortId });
    }
    this.applyPublicPredicate(qb);

    const member = await qb.getOne();
    if (!member) {
      await this.assertNotGone(parsed, regimentId);
      throw new NotFoundException('Member not found');
    }

    const [dto] = await this.projectMany([member]);
    return { dto, member };
  }

  /**
   * Distinguish "was here, is permanently gone" from "never existed", for the
   * handful of cases where saying so is correct.
   *
   * ONLY account deletion earns a 410. It is the fastest de-indexing signal
   * Google honours, and the fact that an account was deleted is not private —
   * the person deleted it. Everything else (banned, suspended, applicant,
   * never-existed) collapses to an indistinguishable 404 ON PURPOSE: a
   * distinguishable status code would turn this endpoint into an oracle that
   * answers "was this member disciplined?" to anyone who kept the old URL.
   */
  private async assertNotGone(
    parsed: { username: string } | { shortId: string },
    regimentId: string,
  ): Promise<void> {
    if ('username' in parsed) {
      const reservation = await this.reservations.findOne({
        where: { username: parsed.username, reason: UsernameReservationReason.Blocked },
      });
      if (reservation) {
        throw new GoneException('This member is no longer with the regiment');
      }
      return;
    }
    // A soft-deleted row still exists; `withDeleted` is what makes it visible.
    const deleted = await this.members.findOne({
      where: { id: parsed.shortId, regimentId },
      withDeleted: true,
    });
    if (deleted?.deletedAt) {
      throw new GoneException('This member is no longer with the regiment');
    }
  }

  /** Every public profile, for the sitemap. Ordered so the output is stable. */
  async listForSitemap(): Promise<PublicProfileRef[]> {
    const regimentId = await this.resolveRegimentId();
    const qb = this.members
      .createQueryBuilder('member')
      .select(['member.id', 'member.username', 'member.updatedAt'])
      .where('member.regimentId = :regimentId', { regimentId });
    this.applyPublicPredicate(qb);
    const rows = await qb.orderBy('member.updatedAt', 'DESC').take(5000).getMany();
    return rows.map((member) => ({
      canonicalPath: profilePathFor(member),
      updatedAt: member.updatedAt,
    }));
  }

  /** How many members the public roster holds (for the roster header + JSON-LD). */
  async countPublic(): Promise<number> {
    const regimentId = await this.resolveRegimentId();
    const qb = this.members
      .createQueryBuilder('member')
      .where('member.regimentId = :regimentId', { regimentId });
    this.applyPublicPredicate(qb);
    return qb.getCount();
  }

  /** The avatar bytes for a member, subject to the same exclusion predicate. */
  async avatarFor(memberId: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    const regimentId = await this.resolveRegimentId();
    const qb = this.members
      .createQueryBuilder('member')
      .leftJoinAndSelect('member.discordIdentity', 'identity')
      .where('member.regimentId = :regimentId', { regimentId })
      .andWhere('member.id = :id', { id: memberId });
    this.applyPublicPredicate(qb);
    const member = await qb.getOne();
    return member ? this.avatars.fetchFor(member) : null;
  }

  /**
   * Project a page of members. Attendance counts and medals are batched into
   * two grouped queries for the whole page — the same no-N+1 shape the
   * authenticated roster uses.
   */
  private async projectMany(rows: Member[]): Promise<PublicMemberDto[]> {
    const ids = rows.map((m) => m.id);
    const [attendance, medals] = await Promise.all([
      this.attendanceCounts(ids),
      this.medalsByMember(ids),
    ]);
    return rows.map((member) =>
      PublicMemberDto.from(
        member,
        { eventsAttended: attendance.get(member.id) ?? 0 },
        medals.get(member.id) ?? [],
        // null when the member has no avatar source at all, so the client keeps
        // rendering its initials tile instead of chasing a 404.
        member.avatarUrl || member.discordIdentity?.avatarUrl
          ? this.avatars.pathFor(member.id)
          : null,
      ),
    );
  }

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

  /**
   * Medals for a page, ordered by the medal cabinet (precedence ASC, then
   * newest award first, then id) — the same total ordering the authenticated
   * roster contracts for, so a member's decorations read identically signed-in
   * and signed-out.
   */
  private async medalsByMember(memberIds: string[]): Promise<Map<string, MemberMedalSummary[]>> {
    const map = new Map<string, MemberMedalSummary[]>();
    if (memberIds.length === 0) return map;

    const awards = await this.memberMedals.find({
      where: { memberId: In(memberIds) },
      relations: { medal: true },
      order: { medal: { precedence: 'ASC' }, awardedAt: 'DESC', id: 'ASC' },
    });

    for (const award of awards) {
      if (!award.medal) continue;
      const list = map.get(award.memberId) ?? [];
      list.push({
        id: award.id,
        medalId: award.medalId,
        title: award.medal.title,
        glyph: award.medal.glyph,
        imageUrl: award.medal.imageUrl,
        description: award.medal.description ?? null,
        // Carried on the intermediate summary only; PublicMemberDto.from drops
        // it and never copies it onto the wire.
        detail: award.detail,
        awardedAt: award.awardedAt.toISOString(),
      });
      map.set(award.memberId, list);
    }
    return map;
  }
}
