import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AccountDeletionStatus } from '../../common/enums';
import { Member } from './member.entity';

/** GDPR deferred-deletion request (requires out-of-band Discord acknowledgement). */
@Entity('account_deletion_requests')
export class AccountDeletionRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'char', length: 36 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  confirmToken: string;

  @Column()
  acknowledgePermanent: boolean;

  @Column()
  acknowledgeDataDownloaded: boolean;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  discordReauthenticatedAt: Date | null;

  @Column({
    type: 'enum',
    enum: AccountDeletionStatus,
    default: AccountDeletionStatus.PendingDiscordConfirmation,
  })
  status: AccountDeletionStatus;

  @Column({ type: 'datetime', precision: 6 })
  requestedAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  confirmedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  executedAt: Date | null;
}
