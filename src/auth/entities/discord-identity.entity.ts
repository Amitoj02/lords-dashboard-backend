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

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
