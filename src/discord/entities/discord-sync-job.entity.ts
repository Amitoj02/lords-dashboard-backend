import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DiscordSyncJobStatus } from '../../common/enums';
import { Regiment } from '../../regiments/entities/regiment.entity';

/**
 * Transactional-outbox row for Discord side effects. App mutations (rank/role/
 * medal change, ban→kick, announcements, welcomes) enqueue a job instead of
 * calling Discord inline, so the API never blocks on — or is broken by — the
 * gateway, and the worker can retry with backoff while respecting Discord rate
 * limits. `jobType` is a DiscordSyncJobType; `payload` carries the job's args.
 */
@Entity('discord_sync_jobs')
@Index(['status', 'scheduledAt'])
export class DiscordSyncJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'varchar', length: 40 })
  jobType: string;

  @Column({ type: 'enum', enum: DiscordSyncJobStatus, default: DiscordSyncJobStatus.Pending })
  status: DiscordSyncJobStatus;

  @Column({ type: 'json', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 5 })
  maxAttempts: number;

  @Column({ type: 'varchar', length: 512, nullable: true })
  lastError: string | null;

  /** Earliest time the worker may pick this job up (drives retry backoff). */
  @Column({ type: 'datetime', precision: 6 })
  scheduledAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
