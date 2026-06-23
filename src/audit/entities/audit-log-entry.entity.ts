import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AuditActorType, AuditSeverity, DiscordSyncStatus } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';

/**
 * Generic, polymorphic, append-only audit ledger. Emitted as a side effect of
 * mutations. Actor/target member FKs are SET NULL so history survives a purge.
 */
@Entity('audit_log_entries')
@Index(['regimentId', 'occurredAt'])
export class AuditLogEntry {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'char', length: 36 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId: string | null;

  @Column({ type: 'datetime', precision: 6 })
  occurredAt: Date;

  @Column({ type: 'char', length: 36, nullable: true })
  actorMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_member_id' })
  actorMember?: Member | null;

  @Column({ type: 'enum', enum: AuditActorType })
  actorType: AuditActorType;

  @Column({ type: 'varchar', length: 120, nullable: true })
  actorLabel: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  actorIp: string | null;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  action: string;

  @Index()
  @Column({ type: 'enum', enum: AuditSeverity, default: AuditSeverity.Info })
  severity: AuditSeverity;

  @Column({ type: 'varchar', length: 32, nullable: true })
  targetType: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetId: string | null;

  @Column({ type: 'char', length: 36, nullable: true })
  targetMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'target_member_id' })
  targetMember?: Member | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  targetLabel: string | null;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ type: 'json', nullable: true })
  beforeValue: Record<string, unknown> | null;

  @Column({ type: 'json', nullable: true })
  afterValue: Record<string, unknown> | null;

  @Column({ type: 'enum', enum: DiscordSyncStatus, nullable: true })
  discordSyncStatus: DiscordSyncStatus | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  anonymisedAt: Date | null;
}
