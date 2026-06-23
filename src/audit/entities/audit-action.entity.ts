import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AuditSeverity } from '../../common/enums';

/** Lookup of known audit action codes (open set — new codes can be inserted). */
@Entity('audit_actions')
export class AuditAction {
  @PrimaryColumn({ length: 64 })
  code: string;

  @Column({ type: 'varchar', length: 120 })
  label: string;

  @Column({ type: 'enum', enum: AuditSeverity, default: AuditSeverity.Info })
  defaultSeverity: AuditSeverity;
}
