import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire the denormalised rank/medal insignia columns now that both use a custom
 * uploaded icon (T-0122 + T-0123):
 *
 *  - DROP `ranks.chevrons` (the chevron count is replaced by `ranks.image_url`);
 *  - DROP `medals.ribbon` (the ribbon colour is replaced by `medals.image_url`).
 *
 * The `image_url` columns were added earlier (MedalRankImages) and remain. Guarded
 * on information_schema so `db:setup` stays idempotent (re-run safe). `down()`
 * re-adds each column in its original shape (chevrons as tinyint UNSIGNED default
 * 0; ribbon as its inline enum, defaulting to 'blue' so existing rows stay valid).
 */
export class DropRankChevronsMedalRibbon1782540000000 implements MigrationInterface {
  name = 'DropRankChevronsMedalRibbon1782540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.columnExists(queryRunner, 'ranks', 'chevrons')) {
      await queryRunner.query(`ALTER TABLE \`ranks\` DROP COLUMN \`chevrons\``);
    }
    if (await this.columnExists(queryRunner, 'medals', 'ribbon')) {
      await queryRunner.query(`ALTER TABLE \`medals\` DROP COLUMN \`ribbon\``);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'medals', 'ribbon'))) {
      await queryRunner.query(
        `ALTER TABLE \`medals\` ADD \`ribbon\` enum('blue','red','gold','green','tricolor') ` +
          `NOT NULL DEFAULT 'blue'`,
      );
    }
    if (!(await this.columnExists(queryRunner, 'ranks', 'chevrons'))) {
      await queryRunner.query(
        `ALTER TABLE \`ranks\` ADD \`chevrons\` tinyint UNSIGNED NOT NULL DEFAULT '0'`,
      );
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
