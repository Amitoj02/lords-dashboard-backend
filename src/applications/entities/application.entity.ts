import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DiscordIdentity } from '../../auth/entities/discord-identity.entity';
import { ApplicantType, ApplicationStatus, HowFound, Platform } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';

/** A recruitment application. Identity 1—* applications; *—0..1 member on approval. */
@Entity('applications')
@Index(['regimentId', 'status'])
export class Application {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 36 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Index()
  @Column({ type: 'char', length: 36, nullable: true })
  discordIdentityId: string | null;

  @ManyToOne(() => DiscordIdentity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'discord_identity_id' })
  discordIdentity?: DiscordIdentity | null;

  @Column({ type: 'char', length: 36, nullable: true })
  promotedMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'promoted_member_id' })
  promotedMember?: Member | null;

  @Column({ type: 'char', length: 36, nullable: true })
  decidedByMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'decided_by_member_id' })
  decidedByMember?: Member | null;

  @Column({ type: 'varchar', length: 120 })
  applicantName: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  discordTag: string | null;

  @Column({ type: 'varchar', length: 120 })
  inGameName: string;

  @Column({ type: 'enum', enum: Platform })
  platform: Platform;

  @Column({ type: 'enum', enum: ApplicantType, default: ApplicantType.Applicant })
  applicantType: ApplicantType;

  @Column({ type: 'varchar', length: 40, nullable: true })
  timezone: string | null;

  @Column({ type: 'text' })
  whyJoin: string;

  @Column({ type: 'enum', enum: HowFound })
  howFound: HowFound;

  @Column({ type: 'varchar', length: 600, nullable: true })
  priorExperience: string | null;

  @Column({ default: false })
  ageConfirmed: boolean;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  ageConfirmedAt: Date | null;

  @Column({ type: 'enum', enum: ApplicationStatus, default: ApplicationStatus.Pending })
  status: ApplicationStatus;

  @Column({ default: false })
  isReapplication: boolean;

  @Column({ default: false })
  discordInServer: boolean;

  @Column({ type: 'int', default: 0 })
  mutualEventsCount: number;

  @Column({ type: 'text', nullable: true })
  moderatorNote: string | null;

  @Column({ type: 'text', nullable: true })
  discordDmMessage: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  declineReason: string | null;

  @Column({ default: false })
  isDraft: boolean;

  @Column({ type: 'datetime', precision: 6 })
  submittedAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  decidedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
