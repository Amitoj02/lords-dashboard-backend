import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Uniqueness guard for materialized recurring-event occurrences (T-0075): a
 * UNIQUE index on (recurrence_template_id, starts_at) so two concurrent/overlapping
 * generation sweeps (or a second app instance) can never double-create the same
 * occurrence. Templates and one-off events carry recurrence_template_id = NULL,
 * and MySQL treats NULLs as distinct in a unique index, so only real occurrences
 * are constrained. Guarded on information_schema so `db:setup` stays idempotent.
 */
export class EventOccurrenceUnique1782470000000 implements MigrationInterface {
  name = 'EventOccurrenceUnique1782470000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.indexExists(queryRunner, 'events', 'UQ_event_occurrence'))) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX \`UQ_event_occurrence\` ON \`events\` (\`recurrence_template_id\`, \`starts_at\`)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.indexExists(queryRunner, 'events', 'UQ_event_occurrence')) {
      await queryRunner.query(`DROP INDEX \`UQ_event_occurrence\` ON \`events\``);
    }
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
