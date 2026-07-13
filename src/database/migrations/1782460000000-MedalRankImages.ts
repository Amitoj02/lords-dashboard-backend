import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Medal + rank image columns (T-0069/T-0070): a nullable public-URL column on
 * each catalogue so an uploaded image (via the storage presign flow) can be
 * attached. Existing medals (glyph/ribbon only) and ranks (chevrons only) keep
 * working — the column is nullable. Guarded on information_schema so `db:setup`
 * stays idempotent (re-run safe).
 */
export class MedalRankImages1782460000000 implements MigrationInterface {
  name = 'MedalRankImages1782460000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'medals', 'image_url'))) {
      await queryRunner.query(`ALTER TABLE \`medals\` ADD \`image_url\` varchar(512) NULL`);
    }
    if (!(await this.columnExists(queryRunner, 'ranks', 'image_url'))) {
      await queryRunner.query(`ALTER TABLE \`ranks\` ADD \`image_url\` varchar(512) NULL`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.columnExists(queryRunner, 'ranks', 'image_url')) {
      await queryRunner.query(`ALTER TABLE \`ranks\` DROP COLUMN \`image_url\``);
    }
    if (await this.columnExists(queryRunner, 'medals', 'image_url')) {
      await queryRunner.query(`ALTER TABLE \`medals\` DROP COLUMN \`image_url\``);
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
