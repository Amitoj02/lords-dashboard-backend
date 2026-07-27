import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Event announcements that can be RSVP'd to from Discord (T-0205).
 *
 * ── ONE COLUMN, ONE TABLE, AND THE SPLIT IS THE POINT ───────────────────────
 * `events.announce_role_id` is AUTHORING input: the role an author picks when
 * they create the event, alongside its notify offsets. It is nullable with no
 * default, so every event already in production keeps announcing silently —
 * exactly as it does today — until somebody picks a role.
 *
 * `event_announcements` is DELIVERY state: where the bot actually put the
 * message. It is a separate table rather than four more nullable columns on
 * `events` because a row's PRESENCE is the answer to "has this been announced?",
 * and four nullable columns can only approximate that. It also only exists for
 * events the bot really posted, which — with the bot mocked in production — is
 * none of them yet.
 *
 * Additive only. Nothing here rewrites an existing row, and `down()` is a true
 * inverse: it drops a table and a column that did not exist before this
 * migration. Production has been live since 2026-07-20.
 */
export class EventRsvpButtonsAndThreads1784900004000 implements MigrationInterface {
  name = 'EventRsvpButtonsAndThreads1784900004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `events` ADD `announce_role_id` varchar(20) NULL AFTER `recurrence_template_id`',
    );
    await queryRunner.query(
      'CREATE TABLE `event_announcements` (' +
        '`event_id` char(12) NOT NULL, ' +
        '`channel_id` varchar(20) NOT NULL, ' +
        '`message_id` varchar(20) NOT NULL, ' +
        '`thread_id` varchar(20) NULL, ' +
        '`closed_at` datetime(6) NULL, ' +
        '`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ' +
        'PRIMARY KEY (`event_id`)' +
        ') ENGINE=InnoDB',
    );
    // CASCADE: the announcement is delivery state OF the event and has no
    // meaning without it. A hard-deleted event must not leave a row pointing at
    // a message nothing can render — the soft-delete path is handled in the
    // application, where the buttons are retired first.
    await queryRunner.query(
      'ALTER TABLE `event_announcements` ADD CONSTRAINT `FK_event_announcements_event` ' +
        'FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `event_announcements` DROP FOREIGN KEY `FK_event_announcements_event`',
    );
    await queryRunner.query('DROP TABLE `event_announcements`');
    await queryRunner.query('ALTER TABLE `events` DROP COLUMN `announce_role_id`');
  }
}
