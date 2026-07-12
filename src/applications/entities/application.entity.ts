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
import { ApplicationStatus } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';

/**
 * A recruitment application, shaped to the regiment's live "Application for
 * Enlistment" form (T-0039): in-game name, current regiment, how they found us
 * (free text), preferred classes, skills to improve, an interest/enlist-in-game
 * confirmation, and an optional representative/guest note. Identity 1—*
 * applications; *—0..1 member on approval. Age is a client-side terms
 * attestation only and is intentionally NOT stored here (T-0039 Q2).
 */
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

  /** The applicant's current/most-recent regiment (free text; "None" is common). */
  @Column({ type: 'varchar', length: 255, default: '' })
  currentRegiment: string;

  /** Free-text "how did you find/hear about the Lords of Holdfast?" answer. */
  @Column({ type: 'varchar', length: 500, default: '' })
  howFound: string;

  /** Classes the applicant prefers to play (free text / comma-joined). */
  @Column({ type: 'varchar', length: 500, default: '' })
  preferredClasses: string;

  /** What the applicant wants to improve at. */
  @Column({ type: 'varchar', length: 1000, default: '' })
  skillsToImprove: string;

  /** Confirms interest + willingness to enlist in-game (required at intake). */
  @Column({ default: false })
  interestConfirmed: boolean;

  /** Optional note when a representative/guest applies on someone's behalf. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  representativeNote: string | null;

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
