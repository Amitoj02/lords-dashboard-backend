import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Re-add `applications.applicant_type` (T-0095): the enlistment track the
 * applicant chooses (Member/Mercenary, default Member). On approval it selects
 * the enrolled member role. Existing rows default to Member.
 *
 * Guarded on information_schema so `db:setup` stays idempotent (re-run safe).
 */
export class ReAddApplicantType1782530000000 implements MigrationInterface {
  name = 'ReAddApplicantType1782530000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'applications', 'applicant_type'))) {
      await queryRunner.query(
        `ALTER TABLE \`applications\` ADD \`applicant_type\` enum('Member','Mercenary') ` +
          `NOT NULL DEFAULT 'Member'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.columnExists(queryRunner, 'applications', 'applicant_type')) {
      await queryRunner.query(`ALTER TABLE \`applications\` DROP COLUMN \`applicant_type\``);
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
