import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Regiment identity cleanup (T-0102 + T-0105):
 *
 *  - ADD `regiments.established_at` (DATE) — a full establishment date driving the
 *    landing "Since est MM/YYYY" line (the bare `established_year` is retained);
 *  - DROP `regiments.short_tag` and its UNIQUE index (the short tag is retired);
 *  - DROP `regiment_settings.public_roster` (the public-roster toggle is retired).
 *
 * Guarded on information_schema so `db:setup` stays idempotent (re-run safe). The
 * short_tag UNIQUE index name is generated, so it is discovered dynamically.
 */
export class RegimentIdentityCleanup1782510000000 implements MigrationInterface {
  name = 'RegimentIdentityCleanup1782510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'regiments', 'established_at'))) {
      await queryRunner.query(`ALTER TABLE \`regiments\` ADD \`established_at\` date NULL`);
    }

    if (await this.columnExists(queryRunner, 'regiments', 'short_tag')) {
      const indexName = await this.indexNameFor(queryRunner, 'regiments', 'short_tag');
      if (indexName) {
        await queryRunner.query(`ALTER TABLE \`regiments\` DROP INDEX \`${indexName}\``);
      }
      await queryRunner.query(`ALTER TABLE \`regiments\` DROP COLUMN \`short_tag\``);
    }

    if (await this.columnExists(queryRunner, 'regiment_settings', 'public_roster')) {
      await queryRunner.query(`ALTER TABLE \`regiment_settings\` DROP COLUMN \`public_roster\``);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'regiment_settings', 'public_roster'))) {
      await queryRunner.query(
        `ALTER TABLE \`regiment_settings\` ADD \`public_roster\` tinyint NOT NULL DEFAULT 1`,
      );
    }
    if (!(await this.columnExists(queryRunner, 'regiments', 'short_tag'))) {
      await queryRunner.query(`ALTER TABLE \`regiments\` ADD \`short_tag\` varchar(6) NULL`);
      // Restore a placeholder value from the name so existing rows are non-empty.
      await queryRunner.query(`UPDATE \`regiments\` SET \`short_tag\` = UPPER(LEFT(\`name\`, 6))`);
    }
    if (await this.columnExists(queryRunner, 'regiments', 'established_at')) {
      await queryRunner.query(`ALTER TABLE \`regiments\` DROP COLUMN \`established_at\``);
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

  private async indexNameFor(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<string | null> {
    const rows = (await queryRunner.query(
      `SELECT index_name AS name FROM information_schema.statistics ` +
        `WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
      [table, column],
    )) as Array<{ name: string }>;
    return rows[0]?.name ?? null;
  }
}
