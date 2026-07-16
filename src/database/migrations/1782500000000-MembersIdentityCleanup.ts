import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collapse the member identity + drop retired profile columns (T-0106 + T-0099):
 *
 *  - backfill `in_game_name` from the legacy `name` where null, then promote it
 *    to NOT NULL and DROP the separate `name` display column — the in-game name
 *    is now the sole display identity;
 *  - DROP `platform` and `timezone` (retired from the profile particulars).
 *
 * Guarded on information_schema so `db:setup` stays idempotent (re-run safe).
 */
export class MembersIdentityCleanup1782500000000 implements MigrationInterface {
  name = 'MembersIdentityCleanup1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Collapse name -> in_game_name.
    if (
      (await this.columnExists(queryRunner, 'members', 'name')) &&
      (await this.columnExists(queryRunner, 'members', 'in_game_name'))
    ) {
      // Backfill any member whose in_game_name was never set.
      await queryRunner.query(
        `UPDATE \`members\` SET \`in_game_name\` = \`name\` ` +
          `WHERE \`in_game_name\` IS NULL OR \`in_game_name\` = ''`,
      );
    }
    // Promote in_game_name to NOT NULL (idempotent — MODIFY is safe to re-run).
    if (await this.columnExists(queryRunner, 'members', 'in_game_name')) {
      await queryRunner.query(
        `ALTER TABLE \`members\` MODIFY \`in_game_name\` varchar(120) NOT NULL`,
      );
    }
    // Drop the retired columns.
    if (await this.columnExists(queryRunner, 'members', 'name')) {
      await queryRunner.query(`ALTER TABLE \`members\` DROP COLUMN \`name\``);
    }
    if (await this.columnExists(queryRunner, 'members', 'platform')) {
      await queryRunner.query(`ALTER TABLE \`members\` DROP COLUMN \`platform\``);
    }
    if (await this.columnExists(queryRunner, 'members', 'timezone')) {
      await queryRunner.query(`ALTER TABLE \`members\` DROP COLUMN \`timezone\``);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'members', 'timezone'))) {
      await queryRunner.query(`ALTER TABLE \`members\` ADD \`timezone\` varchar(40) NULL`);
    }
    if (!(await this.columnExists(queryRunner, 'members', 'platform'))) {
      await queryRunner.query(
        `ALTER TABLE \`members\` ADD \`platform\` enum('steam','xbox','ps') NULL`,
      );
    }
    if (!(await this.columnExists(queryRunner, 'members', 'name'))) {
      await queryRunner.query(`ALTER TABLE \`members\` ADD \`name\` varchar(120) NULL`);
      // Restore the display name from the in-game name so existing rows are valid.
      await queryRunner.query(`UPDATE \`members\` SET \`name\` = \`in_game_name\``);
      await queryRunner.query(`ALTER TABLE \`members\` MODIFY \`name\` varchar(120) NOT NULL`);
    }
    // Relax in_game_name back to nullable (its pre-collapse shape).
    if (await this.columnExists(queryRunner, 'members', 'in_game_name')) {
      await queryRunner.query(`ALTER TABLE \`members\` MODIFY \`in_game_name\` varchar(120) NULL`);
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
