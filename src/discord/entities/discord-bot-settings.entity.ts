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
 * in-process "Lord Adjutant" gateway does: role sync + announcements only (no
 * slash commands). All the behaviour switches default to the SAFE position:
 * `botEnabled` is off (nothing is enqueued until an admin turns the bot on), and
 * `applyBanRoleOnBan` is off (an app-side ban does NOT touch Discord until
 * explicitly enabled — a deliberately sensitive, owner-gated action).
 */
@Entity('discord_bot_settings')
export class DiscordBotSettings {
  @PrimaryColumn({ type: 'char', length: 12 })
  regimentId: string;

  @OneToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  /** Master switch. When false, no sync jobs are enqueued (the bot is dormant). */
  @Column({ default: false })
  botEnabled: boolean;

  /** Channel snowflake welcome messages are posted to (falls back to a DM). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  welcomeChannelId: string | null;

  /**
   * Per-purpose routed channels (T-0041). Each is an admin-picked snowflake; no
   * seeded defaults — a producer no-ops until its channel is set. Names are
   * cached for display only.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  enlistmentChannelId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  enlistmentChannelName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  auditLogChannelId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  auditLogChannelName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  eventAnnouncementChannelId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  eventAnnouncementChannelName: string | null;

  /** Template used when welcoming a new guild member. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  welcomeMessage: string | null;

  /** Role snowflake auto-assigned to members on join (the "Guest" role). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  joinRoleId: string | null;

  @Column({ type: 'varchar', length: 120, default: 'Guest' })
  joinRoleName: string;

  /**
   * Role snowflake applied on an app-side ban (a locked-down "Ban" role the
   * owner creates with no access). Required before {@link applyBanRoleOnBan} can
   * be enabled. Null until an admin picks it from the role picker.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  banRoleId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  banRoleName: string | null;

  /** When true, rank/role/medal changes enqueue a Discord role sync. */
  @Column({ default: true })
  syncRolesOnChange: boolean;

  /**
   * ⚠️ SENSITIVE (owner decision, questionnaire T-0027 Q4 → reshaped by T-0035).
   * When true, an app-side ban STRIPS the member's managed Discord roles and
   * applies the configured {@link banRoleId}. Defaults to false and must be
   * turned on explicitly (and only when a Ban role is set) — the owner asked to
   * re-review this every time it is touched, so it is never enabled by default.
   * Replaces the old KICK_MEMBERS-based `kickOnBan`.
   */
  @Column({ default: false })
  applyBanRoleOnBan: boolean;

  /**
   * Master switch for guild-membership gating (T-0167). OFF by default and
   * shipped that way deliberately: production has ~576 real members and the bot
   * rollout has not happened, so with no bot connected every membership verdict
   * would be wrong and turning the gate on would lock the regiment out of its own
   * dashboard. With this false the verdict is still computed and reported, but
   * nothing is gated on it — behaviour is exactly as before the flag existed.
   */
  @Column({ default: false })
  guildGateEnabled: boolean;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
