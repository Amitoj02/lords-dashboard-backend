import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tear down the ad-hoc regiment-announcement (Field Dispatch) path (T-0103):
 *
 *  - DROP the `notifications` + `notification_reads` tables (the NotificationsModule
 *    was removed);
 *  - DROP `discord_bot_settings.announcement_channel_id` (event announcements now
 *    route solely via `event_announcement_channel_id`);
 *  - remove the orphaned `manage_notifications` role_permissions grants (the
 *    capability was retired).
 *
 * `DiscordSyncJobType.Announce` is kept — it still backs event + enlistment posts.
 * Guarded/`IF EXISTS` so `db:setup` stays idempotent (re-run safe).
 */
export class TearDownAnnouncements1782520000000 implements MigrationInterface {
  name = 'TearDownAnnouncements1782520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.columnExists(queryRunner, 'discord_bot_settings', 'announcement_channel_id')) {
      await queryRunner.query(
        `ALTER TABLE \`discord_bot_settings\` DROP COLUMN \`announcement_channel_id\``,
      );
    }

    // Drop the retired tables (FK-safe: disable checks so drop order is irrelevant).
    await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 0`);
    await queryRunner.query(`DROP TABLE IF EXISTS \`notification_reads\``);
    await queryRunner.query(`DROP TABLE IF EXISTS \`notifications\``);
    await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 1`);

    // Clean up orphaned grants for the retired capability.
    await queryRunner.query(
      `DELETE FROM \`role_permissions\` WHERE \`capability\` = 'manage_notifications'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await this.columnExists(queryRunner, 'discord_bot_settings', 'announcement_channel_id'))
    ) {
      await queryRunner.query(
        `ALTER TABLE \`discord_bot_settings\` ADD \`announcement_channel_id\` varchar(20) NULL`,
      );
    }

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS \`notifications\` (\`id\` char(12) NOT NULL, ` +
        `\`regiment_id\` char(12) NOT NULL, \`title\` varchar(160) NOT NULL, \`body\` text NOT NULL, ` +
        `\`tone\` enum ('info', 'warn', 'ok') NOT NULL DEFAULT 'info', \`author_label\` varchar(120) NULL, ` +
        `\`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS \`notification_reads\` (\`notification_id\` char(12) NOT NULL, ` +
        `\`member_id\` char(12) NOT NULL, \`read_at\` datetime(6) NOT NULL, ` +
        `INDEX \`IDX_9615bdb2455ce385890ba0c20c\` (\`member_id\`), ` +
        `PRIMARY KEY (\`notification_id\`, \`member_id\`)) ENGINE=InnoDB`,
    );
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
