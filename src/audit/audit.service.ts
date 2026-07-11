import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { AuditActorType, AuditSeverity } from '../common/enums';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditLogEntryDto } from './dto/audit-log-entry.dto';
import { AuditAction } from './entities/audit-action.entity';
import { AuditLogEntry } from './entities/audit-log-entry.entity';

/** Who performed the action. `memberId` absent ⇒ defaults to a system actor. */
export interface AuditActor {
  memberId?: string | null;
  type?: AuditActorType;
  label?: string | null;
  ip?: string | null;
}

/** What the action was performed on (any of these may be omitted). */
export interface AuditTarget {
  type?: string | null;
  id?: string | null;
  memberId?: string | null;
  label?: string | null;
}

/** The shape callers pass to {@link AuditService.record}. */
export interface AuditRecordInput {
  regimentId: string;
  /** Action code, e.g. `application.approve` (see audit_actions). */
  action: string;
  actor?: AuditActor;
  target?: AuditTarget;
  /** Overrides the action's configured default severity. */
  severity?: AuditSeverity;
  detail?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requestId?: string | null;
  occurredAt?: Date;
}

/**
 * Append-only audit ledger. {@link record} is the write side wired into every
 * mutation; {@link findEntries} backs the read API. Recording is a side effect,
 * so a failure is logged and swallowed — it must never break the caller.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  /** Lazily-loaded action → default severity lookup (static reference data). */
  private severityByAction: Map<string, AuditSeverity> | null = null;

  constructor(
    @InjectRepository(AuditLogEntry)
    private readonly entries: Repository<AuditLogEntry>,
    @InjectRepository(AuditAction)
    private readonly actions: Repository<AuditAction>,
  ) {}

  /** Build an actor descriptor from the authenticated request user. */
  static actorFromUser(
    user: AuthenticatedUser,
    ip?: string | null,
    label?: string | null,
  ): AuditActor {
    return {
      memberId: user.memberId,
      type: AuditActorType.Member,
      label: label ?? null,
      ip: ip ?? null,
    };
  }

  /** Append an audit row. Never throws — failures are logged and swallowed. */
  async record(input: AuditRecordInput): Promise<void> {
    try {
      const severity = input.severity ?? (await this.defaultSeverity(input.action));
      const actor = input.actor ?? {};
      const entry = this.entries.create({
        regimentId: input.regimentId,
        action: input.action,
        occurredAt: input.occurredAt ?? new Date(),
        requestId: input.requestId ?? null,
        actorMemberId: actor.memberId ?? null,
        actorType: actor.type ?? (actor.memberId ? AuditActorType.Member : AuditActorType.System),
        actorLabel: actor.label ?? null,
        actorIp: actor.ip ?? null,
        severity,
        targetType: input.target?.type ?? null,
        targetId: input.target?.id ?? null,
        targetMemberId: input.target?.memberId ?? null,
        targetLabel: input.target?.label ?? null,
        detail: input.detail ?? null,
        beforeValue: input.before ?? null,
        afterValue: input.after ?? null,
        discordSyncStatus: null,
        anonymisedAt: null,
      });
      await this.entries.save(entry);
    } catch (error) {
      this.logger.error(`Failed to record audit '${input.action}': ${(error as Error).message}`);
    }
  }

  /** Paginated, filtered read of the ledger for a regiment (most recent first). */
  async findEntries(
    regimentId: string,
    query: AuditQueryDto,
  ): Promise<PaginatedResponseDto<AuditLogEntryDto>> {
    const where: FindOptionsWhere<AuditLogEntry> = { regimentId };
    if (query.severity) where.severity = query.severity;
    if (query.action) where.action = query.action;
    if (query.actorMemberId) where.actorMemberId = query.actorMemberId;

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && to) where.occurredAt = Between(from, to);
    else if (from) where.occurredAt = MoreThanOrEqual(from);
    else if (to) where.occurredAt = LessThanOrEqual(to);

    const [rows, total] = await this.entries.findAndCount({
      where,
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip: query.skip,
      take: query.limit,
    });

    return new PaginatedResponseDto(
      rows.map((row) => AuditLogEntryDto.from(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Resolve an action's configured default severity (Info when unknown). */
  private async defaultSeverity(action: string): Promise<AuditSeverity> {
    if (!this.severityByAction) {
      const rows = await this.actions.find();
      this.severityByAction = new Map(rows.map((r) => [r.code, r.defaultSeverity]));
    }
    return this.severityByAction.get(action) ?? AuditSeverity.Info;
  }
}
