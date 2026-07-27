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

  /**
   * Where a gallery submission is posted the moment it arrives, for officers to
   * review. Staff-facing: it carries items nobody has approved yet, so it must
   * be a channel the regiment at large cannot read.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  gallerySubmissionChannelId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  gallerySubmissionChannelName: string | null;

  /**
   * Where an APPROVED gallery item is showcased. Public-facing, and the reason
   * the two are separate settings rather than one: the same media is fit for the
   * whole guild only after a moderator has passed it.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  galleryApprovedChannelId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  galleryApprovedChannelName: string | null;

  /** Template used when welcoming a new guild member. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  welcomeMessage: string | null;

  /**
   * The regiment's single "Member" role — the one Discord role every enrolled
   * member carries regardless of rank, so the guild can hang its permissions off
   * one role instead of a dozen rank roles.
   *
   * ⚠️ THIS WAS `joinRoleId`, AND IT MEANT THE OPPOSITE. It used to be assigned
   * by {@link DiscordOnboardingService} to every account that walked into the
   * guild, which made it worthless as a permission anchor: visitors who had
   * never applied held the same role as enlisted members. It is now granted from
   * ROSTER STATE by the role reconcile — an approved member gets it, a mercenary
   * and a visitor do not — and nothing assigns it on join.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  membershipRoleId: string | null;

  @Column({ type: 'varchar', length: 120, default: 'Member' })
  membershipRoleName: string;

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
