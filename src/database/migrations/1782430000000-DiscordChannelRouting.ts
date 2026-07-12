import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-purpose Discord channel routing (T-0041). Adds three admin-configurable
 * target channels (id + cached name) to discord_bot_settings — enlistments,
 * audit log, and event announcements — that the three producers
 * (T-0042/43/44) route through. All nullable with NO seeded defaults: a producer
 * silently no-ops until its channel is picked. Guarded on information_schema so
 * db:setup stays idempotent.
 */
export class DiscordChannelRouting1782430000000 implements MigrationInterface {
  name = 'DiscordChannelRouting1782430000000';

  private readonly columns: Array<[string, string]> = [
    ['enlistment_channel_id', 'varchar(20) NULL'],
    ['enlistment_channel_name', 'varchar(120) NULL'],
    ['audit_log_channel_id', 'varchar(20) NULL'],
    ['audit_log_channel_name', 'varchar(120) NULL'],
    ['event_announcement_channel_id', 'varchar(20) NULL'],
    ['event_announcement_channel_name', 'varchar(120) NULL'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [column, definition] of this.columns) {
      if (!(await this.columnExists(queryRunner, 'discord_bot_settings', column))) {
        await queryRunner.query(
          `ALTER TABLE \`discord_bot_settings\` ADD \`${column}\` ${definition}`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [column] of [...this.columns].reverse()) {
      if (await this.columnExists(queryRunner, 'discord_bot_settings', column)) {
        await queryRunner.query(`ALTER TABLE \`discord_bot_settings\` DROP COLUMN \`${column}\``);
      }
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
