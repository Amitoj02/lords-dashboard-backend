import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { encryptionTransformer } from '../../common/crypto/encryption.transformer';
import { EventStatus } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';

/** A scheduled regiment event/operation (table `events`). */
@Entity('events')
@Index(['regimentId', 'status'])
export class RegimentEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 36 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'char', length: 36, nullable: true })
  createdByMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_member_id' })
  createdByMember?: Member | null;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  bannerUrl: string | null;

  @Index()
  @Column({ type: 'datetime', precision: 6 })
  startsAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  endsAt: Date | null;

  @Column({ type: 'varchar', length: 40, default: 'UTC' })
  timezone: string;

  @Column({ default: false })
  isRecurring: boolean;

  @Column({ type: 'varchar', length: 120, nullable: true })
  recurrenceRule: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  serverName: string | null;

  @Column({ type: 'text', nullable: true, transformer: encryptionTransformer })
  serverPassword: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  serverRegion: string | null;

  @Column({ type: 'enum', enum: EventStatus, default: EventStatus.Upcoming })
  status: EventStatus;

  @Column({ type: 'int', nullable: true })
  expectedAttendance: number | null;

  @Column({ type: 'int', nullable: true })
  attendanceGoal: number | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  outcome: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  twitchUrl: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  startedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  inLineCount: number | null;

  @Column({ default: false })
  isDraft: boolean;

  @Column({ default: false })
  isArchived: boolean;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'datetime', precision: 6, nullable: true })
  deletedAt: Date | null;
}
