import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Event-reminder dispatch bookkeeping (T-0174).
 *
 * `event_notify_offsets` rows have been written since T-0073 (by the event
 * authoring path and cloned onto every generated recurrence occurrence) but
 * NOTHING ever consumed them — there was no reminder producer at all. Adding one
 * needs somewhere durable to record that an offset has already fired, because a
 * reminder is a non-idempotent side effect: posting "starts in 15 minutes"
 * twice is a visible defect, and the API restarts on every deploy, so an
 * in-memory "already sent" set would forget its contents exactly when it matters.
 *
 * One column:
 *  - `event_notify_offsets.sent_at` — when the scheduler RESOLVED this offset,
 *    whether by enqueuing the reminder or by retiring it as stale. NULL means
 *    unresolved, which is the honest value for every row that exists today: none
 *    of them has ever been considered by a scheduler. It is also what makes the
 *    claim atomic — the sweep updates `... SET sent_at = ? WHERE ... AND sent_at
 *    IS NULL` and only sends when it actually won the row.
 *
 * Deliberately ADDITIVE ONLY, and nullable with no default, so it rewrites no
 * existing row's data. Production has been live since 2026-07-20. `down()` is a
 * true inverse: it drops a column that did not exist before this migration.
 */
export class EventReminderDispatch1784900002000 implements MigrationInterface {
  name = 'EventReminderDispatch1784900002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`event_notify_offsets\` ADD \`sent_at\` datetime(6) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`event_notify_offsets\` DROP COLUMN \`sent_at\``);
  }
}
