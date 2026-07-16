import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  UpdateDateColumn,
} from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { DiscordIdentity } from '../../auth/entities/discord-identity.entity';
import { MemberRole, MemberStatus } from '../../common/enums';
import { Rank } from '../../ranks/entities/rank.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';

/** Authoritative person/roster record. */
@Entity('members')
export class Member extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  // References the retained-uuid discord_identities.id (the JWT sub) → stays char(36).
  @Column({ type: 'char', length: 36, nullable: true })
  discordIdentityId: string | null;

  @OneToOne(() => DiscordIdentity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'discord_identity_id' })
  discordIdentity?: DiscordIdentity | null;

  @Column({ type: 'char', length: 12 })
  rankId: string;

  @ManyToOne(() => Rank, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'rank_id' })
  rank?: Rank;

  // The member's in-game name is the sole display identity (the former separate
  // `name` display column was dropped in T-0106; in_game_name is now NOT NULL).
  @Column({ type: 'varchar', length: 120 })
  inGameName: string;

  @Index()
  @Column({ type: 'enum', enum: MemberRole, default: MemberRole.Applicant })
  role: MemberRole;

  @Index()
  @Column({ type: 'enum', enum: MemberStatus, default: MemberStatus.Pending })
  status: MemberStatus;

  @Column({ default: false })
  discordLinked: boolean;

  @Column({ default: true })
  publicProfile: boolean;

  @Column({ type: 'varchar', length: 512, nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  bannerUrl: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  standing: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  joinedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastSeenAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  suspendedUntil: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  bannedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'datetime', precision: 6, nullable: true })
  deletedAt: Date | null;
}
