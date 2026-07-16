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
import { MemberRole, MemberStatus, Platform } from '../../common/enums';
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

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  inGameName: string | null;

  @Index()
  @Column({ type: 'enum', enum: MemberRole, default: MemberRole.Applicant })
  role: MemberRole;

  @Index()
  @Column({ type: 'enum', enum: MemberStatus, default: MemberStatus.Pending })
  status: MemberStatus;

  @Column({ type: 'enum', enum: Platform, nullable: true })
  platform: Platform | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  timezone: string | null;

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
