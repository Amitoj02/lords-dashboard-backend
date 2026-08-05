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
import { USERNAME_MAX_LENGTH } from '../../common/ids/username';
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

  /**
   * Optional vanity handle backing `/u/@panda` (T-0215). NULL for a member who
   * never claimed one — MySQL treats NULLs as distinct inside a unique index,
   * which is the whole reason "optional AND unique" needs no shadow column.
   * The `utf8mb4_unicode_ci` collation makes this index case- and
   * accent-insensitive for free; see the migration for why that is deliberate.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: USERNAME_MAX_LENGTH, nullable: true })
  username: string | null;

  /**
   * When the handle was last changed, for the rename cooldown. Separate from
   * `updatedAt` on purpose — every self-edit bumps that one, so it cannot tell
   * a handle change from an avatar upload.
   */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  usernameChangedAt: Date | null;

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

  /**
   * Member-authored blurb shown on the public profile (T-0216). NULL means the
   * member never wrote one — and whitespace-only input is normalised to NULL in
   * the service, so "blank" has exactly one representation rather than two that
   * render identically and compare differently.
   *
   * `text` rather than a varchar: the LENGTH LIMIT IS A PRODUCT RULE (280
   * characters, so the blurb stays one paragraph beside the avatar) and product
   * rules that move belong in the DTO, not in a column type that needs a
   * migration to relax. There is no sanitizer library in this codebase; the bio
   * is escaped at RENDER time by `escapeHtml` in `src/seo`, which is where every
   * other member-authored string is already made safe.
   */
  @Column({ type: 'text', nullable: true })
  bio: string | null;

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
