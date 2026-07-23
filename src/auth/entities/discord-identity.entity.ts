import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { encryptionTransformer } from '../../common/crypto/encryption.transformer';

/**
 * The OAuth "user account" record — created/updated on every Discord sign-in.
 * Tokens are encrypted at rest. A member (roster) row links to this 0..1.
 */
@Entity('discord_identities')
export class DiscordIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20 })
  discordUserId: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  discordTag: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  discordUsername: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  globalName: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'text', nullable: true, transformer: encryptionTransformer })
  accessToken: string | null;

  @Column({ type: 'text', nullable: true, transformer: encryptionTransformer })
  refreshToken: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  tokenExpiresAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  scopes: string | null;

  @Column({ default: false })
  guildMember: boolean;

  /**
   * When {@link guildMember} was last CONFIRMED by the bot (T-0167). Null means
   * "never confirmed either way" — which is not the same as "not a member", and
   * the difference is the whole point: a lookup that timed out, hit a
   * disconnected bot or found no configured guild leaves this null and the
   * verdict is read FAIL-OPEN (T-0168), so a bot outage can never lock the
   * regiment out. Only a completed lookup (or a live join/leave event, T-0169)
   * writes this pair.
   */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  guildCheckedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastSignInAt: Date | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  lastSignInIp: string | null;

  /**
   * iat cutoff for session invalidation (T-0048). A JWT whose `iat` predates
   * this instant is rejected by JwtStrategy. Bumped on logout and sensitive
   * events (ban/suspend). Null means no tokens have been invalidated yet.
   */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  sessionsValidFrom: Date | null;

  /**
   * Applicant blocklist (T-0055): when set, an officer has permanently barred
   * this identity from submitting further recruitment applications. Cleared on
   * re-enable. Mirrors the member ban/suspend-as-columns convention. Null ⇒ the
   * identity may apply normally.
   */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  applicationsBlockedAt: Date | null;

  @Column({ type: 'char', length: 12, nullable: true })
  applicationsBlockedByMemberId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  applicationsBlockedReason: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
