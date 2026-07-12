import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reshape the applications table to the regiment's live "Application for
 * Enlistment" form (T-0039). Drops the fields the form no longer collects
 * (platform, applicant_type, timezone, why_join, prior_experience, age_confirmed
 * + age_confirmed_at), converts how_found from an enum to free text, and adds
 * current_regiment, preferred_classes, skills_to_improve, interest_confirmed and
 * representative_note. New NOT NULL columns are added WITH a default so existing
 * rows survive; every step is guarded on information_schema for idempotency.
 * (Greenfield — no production data; owner authorised destructive DB changes.)
 */
export class ReshapeApplications1782420000000 implements MigrationInterface {
  name = 'ReshapeApplications1782420000000';

  private readonly dropped = [
    'platform',
    'applicant_type',
    'timezone',
    'why_join',
    'prior_experience',
    'age_confirmed',
    'age_confirmed_at',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add the new columns (with defaults so any existing rows populate).
    await this.addColumn(queryRunner, 'current_regiment', `varchar(255) NOT NULL DEFAULT ''`);
    await this.addColumn(queryRunner, 'preferred_classes', `varchar(500) NOT NULL DEFAULT ''`);
    await this.addColumn(queryRunner, 'skills_to_improve', `varchar(1000) NOT NULL DEFAULT ''`);
    await this.addColumn(queryRunner, 'interest_confirmed', `tinyint NOT NULL DEFAULT 0`);
    await this.addColumn(queryRunner, 'representative_note', `varchar(500) NULL`);

    // 2. how_found: enum -> free text.
    if ((await this.columnType(queryRunner, 'applications', 'how_found')) === 'enum') {
      await queryRunner.query(
        `ALTER TABLE \`applications\` MODIFY \`how_found\` varchar(500) NOT NULL`,
      );
    }

    // 3. Drop the retired columns.
    for (const column of this.dropped) {
      if (await this.columnExists(queryRunner, 'applications', column)) {
        await queryRunner.query(`ALTER TABLE \`applications\` DROP COLUMN \`${column}\``);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-add the retired columns (nullable — the original values are gone).
    await this.addColumn(queryRunner, 'platform', `enum('steam','xbox','ps') NULL`);
    await this.addColumn(
      queryRunner,
      'applicant_type',
      `enum('Applicant','Mercenary') NOT NULL DEFAULT 'Applicant'`,
    );
    await this.addColumn(queryRunner, 'timezone', `varchar(40) NULL`);
    await this.addColumn(queryRunner, 'why_join', `text NULL`);
    await this.addColumn(queryRunner, 'prior_experience', `varchar(600) NULL`);
    await this.addColumn(queryRunner, 'age_confirmed', `tinyint NOT NULL DEFAULT 0`);
    await this.addColumn(queryRunner, 'age_confirmed_at', `datetime(6) NULL`);

    for (const column of [
      'representative_note',
      'interest_confirmed',
      'skills_to_improve',
      'preferred_classes',
      'current_regiment',
    ]) {
      if (await this.columnExists(queryRunner, 'applications', column)) {
        await queryRunner.query(`ALTER TABLE \`applications\` DROP COLUMN \`${column}\``);
      }
    }
  }

  private async addColumn(
    queryRunner: QueryRunner,
    column: string,
    definition: string,
  ): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'applications', column))) {
      await queryRunner.query(`ALTER TABLE \`applications\` ADD \`${column}\` ${definition}`);
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

  private async columnType(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<string | null> {
    const rows = (await queryRunner.query(
      `SELECT DATA_TYPE AS t FROM information_schema.columns ` +
        `WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    )) as Array<{ t: string }>;
    return rows[0]?.t ?? null;
  }
}
