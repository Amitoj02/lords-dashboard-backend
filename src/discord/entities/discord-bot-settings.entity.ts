import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Regiment } from '../../regiments/entities/regiment.entity';

/**
 * 1—1 configuration for a regiment's Discord bot (PK = FK). Drives what the
 * in-process "Quartermaster" gateway does: role sync + announcements only (no
 * slash commands). All the behaviour switches default to the SAFE position:
 * `botEnabled` is off (nothing is enqueued until an admin turns the bot on), and
 * `kickOnBan` is off (an app-side ban does NOT touch Discord until explicitly
 * enabled — a deliberately sensitive, owner-gated action).
 */
@Entity('discord_bot_settings')
export class DiscordBotSettings {
  @PrimaryColumn({ type: 'char', length: 36 })
  regimentId: string;

  @OneToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  /** Master switch. When false, no sync jobs are enqueued (the bot is dormant). */
  @Column({ default: false })
  botEnabled: boolean;

  /** Channel snowflake announcements/dispatches are posted to (#announcements). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  announcementChannelId: string | null;

  /** Channel snowflake welcome messages are posted to (falls back to a DM). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  welcomeChannelId: string | null;

  /** Template used when welcoming a new guild member. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  welcomeMessage: string | null;

  /** Role snowflake auto-assigned to members on join (the "Guest" role). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  joinRoleId: string | null;

  @Column({ type: 'varchar', length: 120, default: 'Guest' })
  joinRoleName: string;

  /** When true, rank/role/medal changes enqueue a Discord role sync. */
  @Column({ default: true })
  syncRolesOnChange: boolean;

  /**
   * ⚠️ SENSITIVE (owner decision, questionnaire T-0027 Q4). When true, an
   * app-side ban ALSO kicks the member from the Discord guild. Defaults to false
   * and must be turned on explicitly — the owner asked to re-review this every
   * time it is touched, so it is never enabled by default.
   */
  @Column({ default: false })
  kickOnBan: boolean;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
