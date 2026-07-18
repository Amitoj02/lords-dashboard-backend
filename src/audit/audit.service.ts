import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { AuthenticatedUser } from '../auth/types/authenticated-user.interface';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { AuditActorType, AuditSeverity, DiscordSyncStatus } from '../common/enums';
import { DiscordSyncService } from '../discord/discord-sync.service';
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
    // Resolved lazily (via ModuleRef) to mirror entries to Discord without a DI
    // cycle — AuditModule is @Global and DiscordModule depends on it (T-0043).
    private readonly moduleRef: ModuleRef,
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
      // Persist first so the mirror job can reference the saved entry id.
      const saved = await this.entries.save(entry);
      // Best-effort mirror to the audit-log Discord channel; the returned flag
      // says whether a mirror job was actually enqueued so we can record a
      // truthful sync status (pending vs not_applicable) on the entry.
      const enqueued = await this.mirrorToDiscord(
        input.regimentId,
        saved.id,
        input.action,
        actor.label ?? null,
        severity,
        input.detail ?? null,
      );
      // Record the truthful sync status. The mirror job is drainable the instant
      // it is enqueued, so a fast worker can flip this entry to synced/failed
      // before we get here; guard the pending write with `discordSyncStatus IS
      // NULL` so we never clobber a terminal status back to pending.
      if (enqueued) {
        await this.entries.update(
          { id: saved.id, discordSyncStatus: IsNull() },
          { discordSyncStatus: DiscordSyncStatus.Pending },
        );
      } else {
        await this.entries.update(
          { id: saved.id },
          { discordSyncStatus: DiscordSyncStatus.NotApplicable },
        );
      }
    } catch (error) {
      this.logger.error(`Failed to record audit '${input.action}': ${(error as Error).message}`);
    }
  }

  /**
   * Cross-post an audit entry to the configured audit-log channel (T-0043).
   * Best-effort; never throws (a mirror failure must not break record()). The
   * `discord.sync.failed` action is EXCLUDED to break a feedback loop: a failed
   * mirror produces exactly that entry, which would otherwise re-enqueue forever.
   * Returns whether a mirror job was actually enqueued so the caller can set the
   * source entry's sync status (excluded action / bot off / no channel ⇒ false).
   */
  private async mirrorToDiscord(
    regimentId: string,
    auditEntryId: string,
    action: string,
    actorLabel: string | null,
    severity: AuditSeverity,
    detail: string | null,
  ): Promise<boolean> {
    if (action === 'discord.sync.failed') return false;
    let sync: DiscordSyncService;
    try {
      sync = this.moduleRef.get(DiscordSyncService, { strict: false });
    } catch {
      return false; // DiscordSyncService not available (e.g. narrow test module) — skip.
    }
    try {
      return await sync.enqueueAuditLog(
        regimentId,
        { action, actorLabel, detail, severity },
        auditEntryId,
      );
    } catch (error) {
      this.logger.error(`Audit Discord mirror failed: ${(error as Error).message}`);
      return false;
    }
  }

  /** Paginated, filtered read of the ledger for a regiment (most recent first). */
  async findEntries(
    regimentId: string,
    query: AuditQueryDto,
  ): Promise<PaginatedResponseDto<AuditLogEntryDto>> {
    const [rows, total] = await this.entries.findAndCount({
      where: this.buildWhere(regimentId, query),
      // Join the actor/target members (and their Discord identity) so the DTO can
      // resolve a human name when the denormalised label was not stored (actor FK
      // is onDelete SET NULL) and a real avatar with a Discord fallback (T-0117).
      relations: {
        actorMember: { discordIdentity: true },
        targetMember: { discordIdentity: true },
      },
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

  /** Fetch a single ledger entry, regiment-scoped. 404 when it does not exist. */
  async findOne(regimentId: string, id: string): Promise<AuditLogEntryDto> {
    const row = await this.entries.findOne({
      where: { id, regimentId },
      // See findEntries: resolve the actor/target member name + avatar when unstored.
      relations: {
        actorMember: { discordIdentity: true },
        targetMember: { discordIdentity: true },
      },
    });
    if (!row) throw new NotFoundException('Audit entry not found');
    return AuditLogEntryDto.from(row);
  }

  /**
   * Export the filtered ledger as a CSV string. Applies the same filters as
   * {@link findEntries} but is un-paginated (capped at 10k rows, newest first).
   * Every field is quote-escaped so commas, quotes, and newlines stay contained.
   */
  async exportCsv(regimentId: string, query: AuditQueryDto): Promise<string> {
    const rows = await this.entries.find({
      where: this.buildWhere(regimentId, query),
      // Join the actor/target members (and their Discord identity) so the CSV
      // resolves the human name when the denormalised label was not stored and a
      // real avatar with a Discord fallback — matching the JSON read paths + DTO.
      relations: {
        actorMember: { discordIdentity: true },
        targetMember: { discordIdentity: true },
      },
      order: { occurredAt: 'DESC', id: 'DESC' },
      take: 10000,
    });

    const header =
      'occurredAt,action,severity,actorType,actorLabel,actorMemberId,actorAvatarUrl,targetType,targetId,targetLabel,targetAvatarUrl,detail';
    const lines = [header];
    for (const row of rows) {
      lines.push(
        [
          row.occurredAt.toISOString(),
          row.action,
          row.severity,
          row.actorType,
          row.actorLabel ?? row.actorMember?.inGameName ?? '',
          row.actorMemberId,
          row.actorMember?.avatarUrl ?? row.actorMember?.discordIdentity?.avatarUrl ?? null,
          row.targetType,
          row.targetId,
          row.targetLabel ?? row.targetMember?.inGameName ?? '',
          row.targetMember?.avatarUrl ?? row.targetMember?.discordIdentity?.avatarUrl ?? null,
          row.detail,
        ]
          .map((field) => this.escapeCsvField(field))
          .join(','),
      );
    }
    return lines.join('\n');
  }

  /** Compose the shared filter WHERE clause used by both list and export reads. */
  private buildWhere(regimentId: string, query: AuditQueryDto): FindOptionsWhere<AuditLogEntry> {
    const where: FindOptionsWhere<AuditLogEntry> = { regimentId };
    if (query.severity) where.severity = query.severity;
    if (query.action) where.action = query.action;
    if (query.actorMemberId) where.actorMemberId = query.actorMemberId;

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && to) where.occurredAt = Between(from, to);
    else if (from) where.occurredAt = MoreThanOrEqual(from);
    else if (to) where.occurredAt = LessThanOrEqual(to);

    return where;
  }

  /**
   * CSV-escape one field: null→empty, CR/LF→space, `"`→`""`, always quoted.
   * Also neutralises spreadsheet formula injection (CWE-1236): a field that
   * begins with `= + - @` (or tab) is prefixed with a single quote so Excel/
   * Sheets treat the cell as text rather than evaluating attacker-controlled
   * content (e.g. an audited event title or member name) as a formula.
   */
  private escapeCsvField(value: string | null): string {
    let text = (value ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, '""');
    if (/^[=+\-@\t]/.test(text)) {
      text = `'${text}`;
    }
    return `"${text}"`;
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
