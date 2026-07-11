import { ApiProperty } from '@nestjs/swagger';
import { AuditActorType, AuditSeverity } from '../../common/enums';
import { AuditLogEntry } from '../entities/audit-log-entry.entity';

/** Client-facing projection of one audit ledger row. */
export class AuditLogEntryDto {
  @ApiProperty({ example: '1024' })
  id: string;

  @ApiProperty({ example: '2026-06-22T18:30:00.000Z' })
  occurredAt: string;

  @ApiProperty({ example: 'application.approve' })
  action: string;

  @ApiProperty({ enum: AuditSeverity })
  severity: AuditSeverity;

  @ApiProperty({ enum: AuditActorType })
  actorType: AuditActorType;

  @ApiProperty({ nullable: true })
  actorMemberId: string | null;

  @ApiProperty({ nullable: true })
  actorLabel: string | null;

  @ApiProperty({ nullable: true })
  targetType: string | null;

  @ApiProperty({ nullable: true })
  targetId: string | null;

  @ApiProperty({ nullable: true })
  targetMemberId: string | null;

  @ApiProperty({ nullable: true })
  targetLabel: string | null;

  @ApiProperty({ nullable: true })
  detail: string | null;

  @ApiProperty({ nullable: true, type: Object })
  before: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: Object })
  after: Record<string, unknown> | null;

  static from(entry: AuditLogEntry): AuditLogEntryDto {
    return {
      id: entry.id,
      occurredAt: entry.occurredAt.toISOString(),
      action: entry.action,
      severity: entry.severity,
      actorType: entry.actorType,
      actorMemberId: entry.actorMemberId,
      actorLabel: entry.actorLabel,
      targetType: entry.targetType,
      targetId: entry.targetId,
      targetMemberId: entry.targetMemberId,
      targetLabel: entry.targetLabel,
      detail: entry.detail,
      before: entry.beforeValue,
      after: entry.afterValue,
    };
  }
}
