import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Guild-membership re-validation (T-0167) and its feature flag (T-0166/T-0168).
 *
 * Two columns:
 *  - `discord_identities.guild_checked_at` — when `guild_member` was last
 *    CONFIRMED by the bot. Nullable on purpose: null distinguishes "never
 *    checked" from "checked and not a member", which is what lets the read path
 *    fail OPEN instead of locking members out when the bot is unreachable.
 *    Every existing row starts null, which is the honest value — none of those
 *    verdicts was recorded with this distinction available.
 *  - `discord_bot_settings.guild_gate_enabled` — the master switch, NOT NULL
 *    DEFAULT 0 so the gate is OFF everywhere the moment this lands. It matches
 *    the tinyint convention of the other booleans on that table
 *    (`bot_enabled`, `apply_ban_role_on_ban`), and the table holds one row per
 *    regiment (one row in production), so the default costs nothing to apply.
 *
 * Deliberately ADDITIVE ONLY. Production has been live since 2026-07-20, so
 * this adds columns at the end of two tables and rewrites no existing row's
 * data; `down()` is a true inverse (dropping columns that did not exist before).
 */
export class GuildMembershipRevalidation1784900001000 implements MigrationInterface {
  name = 'GuildMembershipRevalidation1784900001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`discord_identities\` ADD \`guild_checked_at\` datetime(6) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`discord_bot_settings\` ADD \`guild_gate_enabled\` tinyint NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`discord_bot_settings\` DROP COLUMN \`guild_gate_enabled\``,
    );
    await queryRunner.query(`ALTER TABLE \`discord_identities\` DROP COLUMN \`guild_checked_at\``);
  }
}
