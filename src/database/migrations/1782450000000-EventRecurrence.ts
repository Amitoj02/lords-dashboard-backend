import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Event recurrence model (T-0074): structured cadence + template linkage + a stop
 * flag on `events`, so a recurring template's future occurrences can be
 * materialized as real rows by the recurrence scheduler (T-0075).
 *
 *  - `recurrence_cadence`     — daily/weekly/monthly (null on one-offs/occurrences)
 *  - `recurrence_active`      — the stop flag (true keeps generating; false stops)
 *  - `recurrence_template_id` — on a generated occurrence, its template's id
 *
 * Every step is guarded on information_schema so `db:setup` stays idempotent.
 */
export class EventRecurrence1782450000000 implements MigrationInterface {
  name = 'EventRecurrence1782450000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'events', 'recurrence_cadence'))) {
      await queryRunner.query(
        `ALTER TABLE \`events\` ADD \`recurrence_cadence\` enum ('daily', 'weekly', 'monthly') NULL`,
      );
    }
    if (!(await this.columnExists(queryRunner, 'events', 'recurrence_active'))) {
      await queryRunner.query(
        `ALTER TABLE \`events\` ADD \`recurrence_active\` tinyint NOT NULL DEFAULT 0`,
      );
    }
    if (!(await this.columnExists(queryRunner, 'events', 'recurrence_template_id'))) {
      await queryRunner.query(
        `ALTER TABLE \`events\` ADD \`recurrence_template_id\` char(12) NULL`,
      );
    }
    if (!(await this.indexExists(queryRunner, 'events', 'IDX_event_recurrence_template'))) {
      await queryRunner.query(
        `CREATE INDEX \`IDX_event_recurrence_template\` ON \`events\` (\`recurrence_template_id\`)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.indexExists(queryRunner, 'events', 'IDX_event_recurrence_template')) {
      await queryRunner.query(`DROP INDEX \`IDX_event_recurrence_template\` ON \`events\``);
    }
    if (await this.columnExists(queryRunner, 'events', 'recurrence_template_id')) {
      await queryRunner.query(`ALTER TABLE \`events\` DROP COLUMN \`recurrence_template_id\``);
    }
    if (await this.columnExists(queryRunner, 'events', 'recurrence_active')) {
      await queryRunner.query(`ALTER TABLE \`events\` DROP COLUMN \`recurrence_active\``);
    }
    if (await this.columnExists(queryRunner, 'events', 'recurrence_cadence')) {
      await queryRunner.query(`ALTER TABLE \`events\` DROP COLUMN \`recurrence_cadence\``);
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

  private async indexExists(
    queryRunner: QueryRunner,
    table: string,
    index: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS c FROM information_schema.statistics ` +
        `WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, index],
    )) as Array<{ c: number | string }>;
    return Number(rows[0]?.c ?? 0) > 0;
  }
}
