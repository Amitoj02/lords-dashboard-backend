import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replace the KICK_MEMBERS-based ban→kick with a strip-roles + apply-"Ban"-role
 * flow (T-0034/T-0035). Adds `ban_role_id`/`ban_role_name` to
 * discord_bot_settings and renames the behaviour gate `kick_on_ban` →
 * `apply_ban_role_on_ban` (same tinyint default 0). All steps are guarded on
 * information_schema so `db:setup` stays idempotent.
 */
export class DiscordBanRole1782410000000 implements MigrationInterface {
  name = 'DiscordBanRole1782410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'discord_bot_settings', 'ban_role_id'))) {
      await queryRunner.query(
        `ALTER TABLE \`discord_bot_settings\` ADD \`ban_role_id\` varchar(20) NULL`,
      );
    }
    if (!(await this.columnExists(queryRunner, 'discord_bot_settings', 'ban_role_name'))) {
      await queryRunner.query(
        `ALTER TABLE \`discord_bot_settings\` ADD \`ban_role_name\` varchar(120) NULL`,
      );
    }
    // Rename the gate only if the old column is still present and the new one is
    // not (so a re-run — or a fresh schema already carrying the new name — is a
    // no-op).
    const hasOld = await this.columnExists(queryRunner, 'discord_bot_settings', 'kick_on_ban');
    const hasNew = await this.columnExists(
      queryRunner,
      'discord_bot_settings',
      'apply_ban_role_on_ban',
    );
    if (hasOld && !hasNew) {
      await queryRunner.query(
        `ALTER TABLE \`discord_bot_settings\` ` +
          `CHANGE \`kick_on_ban\` \`apply_ban_role_on_ban\` tinyint NOT NULL DEFAULT 0`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasNew = await this.columnExists(
      queryRunner,
      'discord_bot_settings',
      'apply_ban_role_on_ban',
    );
    const hasOld = await this.columnExists(queryRunner, 'discord_bot_settings', 'kick_on_ban');
    if (hasNew && !hasOld) {
      await queryRunner.query(
        `ALTER TABLE \`discord_bot_settings\` ` +
          `CHANGE \`apply_ban_role_on_ban\` \`kick_on_ban\` tinyint NOT NULL DEFAULT 0`,
      );
    }
    if (await this.columnExists(queryRunner, 'discord_bot_settings', 'ban_role_name')) {
      await queryRunner.query(`ALTER TABLE \`discord_bot_settings\` DROP COLUMN \`ban_role_name\``);
    }
    if (await this.columnExists(queryRunner, 'discord_bot_settings', 'ban_role_id')) {
      await queryRunner.query(`ALTER TABLE \`discord_bot_settings\` DROP COLUMN \`ban_role_id\``);
    }
  }

  private async columnExists(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns ` +
        `WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    )) as Array<{ c: number | string }>;
    return Number(rows[0]?.c ?? 0) > 0;
  }
}
