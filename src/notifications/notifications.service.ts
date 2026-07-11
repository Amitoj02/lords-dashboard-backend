import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { NotificationTone } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationDto } from './dto/notification.dto';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { NotificationRead } from './entities/notification-read.entity';
import { Notification } from './entities/notification.entity';

/** The author label applied to a dispatch when no member name is available. */
const DEFAULT_AUTHOR_LABEL = 'Command';

/**
 * "Field Dispatch" announcements: a regiment-scoped feed with per-member read
 * state (the notification_reads junction). Reads are readable by any enrolled
 * member; composing a dispatch is capability-gated and audited. Read tracking is
 * idempotent — marking an already-read notification is a no-op.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(NotificationRead)
    private readonly reads: Repository<NotificationRead>,
    @InjectRepository(Member)
    private readonly members: Repository<Member>,
    private readonly audit: AuditService,
  ) {}

  /** Paginated feed (most recent first) with the caller's read state per row. */
  async findAll(
    user: AuthenticatedUser,
    query: NotificationQueryDto,
  ): Promise<PaginatedResponseDto<NotificationDto>> {
    const [rows, total] = await this.notifications.findAndCount({
      where: { regimentId: user.regimentId },
      order: { createdAt: 'DESC' },
      skip: query.skip,
      take: query.limit,
    });

    const readIds = await this.readIdsFor(
      user.memberId,
      rows.map((row) => row.id),
    );

    return new PaginatedResponseDto(
      rows.map((row) => NotificationDto.from(row, readIds.has(row.id))),
      total,
      query.page,
      query.limit,
    );
  }

  /** Count of regiment notifications the caller has not yet read (0 when unlinked). */
  async unreadCount(user: AuthenticatedUser): Promise<{ count: number }> {
    if (!user.memberId) {
      return { count: 0 };
    }
    const count = await this.unreadQuery(user.regimentId, user.memberId).getCount();
    return { count };
  }

  /**
   * Compose a dispatch. The author label defaults to the caller's member name
   * (falling back to 'Command') when the body omits one. Audited; returned as
   * read for the author.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateNotificationDto,
    ip: string | null,
  ): Promise<NotificationDto> {
    let authorLabel = dto.authorLabel ?? null;
    if (!authorLabel && user.memberId) {
      const member = await this.members.findOne({
        where: { id: user.memberId, regimentId: user.regimentId },
      });
      authorLabel = member?.name ?? null;
    }

    const notification = this.notifications.create({
      regimentId: user.regimentId,
      title: dto.title,
      body: dto.body,
      tone: dto.tone ?? NotificationTone.Info,
      authorLabel: authorLabel ?? DEFAULT_AUTHOR_LABEL,
    });
    const saved = await this.notifications.save(notification);

    await this.audit.record({
      regimentId: user.regimentId,
      action: 'notification.create',
      actor: AuditService.actorFromUser(user, ip),
      target: { type: 'notification', id: saved.id, label: saved.title },
    });

    // The author has implicitly "seen" their own dispatch.
    return NotificationDto.from(saved, true);
  }

  /**
   * Idempotently mark a single notification read for the caller. Validates the
   * notification belongs to the caller's regiment (404 otherwise).
   */
  async markRead(user: AuthenticatedUser, id: string): Promise<{ read: boolean }> {
    if (!user.memberId) {
      throw new ForbiddenException('A linked member is required to mark notifications read');
    }

    const notification = await this.notifications.findOne({
      where: { id, regimentId: user.regimentId },
    });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    const existing = await this.reads.findOne({
      where: { notificationId: id, memberId: user.memberId },
    });
    if (!existing) {
      await this.reads.save(
        this.reads.create({ notificationId: id, memberId: user.memberId, readAt: new Date() }),
      );
    }

    return { read: true };
  }

  /** Mark every unread regiment notification read for the caller. Returns the count marked. */
  async markAllRead(user: AuthenticatedUser): Promise<{ read: number }> {
    if (!user.memberId) {
      return { read: 0 };
    }

    const unread = await this.unreadQuery(user.regimentId, user.memberId).getMany();
    if (unread.length === 0) {
      return { read: 0 };
    }

    const now = new Date();
    await this.reads.save(
      unread.map((notification) =>
        this.reads.create({
          notificationId: notification.id,
          memberId: user.memberId as string,
          readAt: now,
        }),
      ),
    );

    return { read: unread.length };
  }

  /** Ids (from the given set) the member has read — empty when the member is unlinked. */
  private async readIdsFor(memberId: string | null, ids: string[]): Promise<Set<string>> {
    if (!memberId || ids.length === 0) {
      return new Set();
    }
    const rows = await this.reads.find({
      where: { notificationId: In(ids), memberId },
    });
    return new Set(rows.map((row) => row.notificationId));
  }

  /** Regiment notifications lacking a read row for the member (anti-join). */
  private unreadQuery(regimentId: string, memberId: string): SelectQueryBuilder<Notification> {
    return this.notifications
      .createQueryBuilder('n')
      .leftJoin(NotificationRead, 'r', 'r.notificationId = n.id AND r.memberId = :memberId', {
        memberId,
      })
      .where('n.regimentId = :regimentId', { regimentId })
      .andWhere('r.notificationId IS NULL');
  }
}
