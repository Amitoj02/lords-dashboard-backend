import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vanity usernames for the public member profiles (T-0215).
 *
 * ── WHY A COLUMN AND A TABLE ────────────────────────────────────────────────
 * `members.username` is the handle itself. It is NULLable because it is
 * optional — a member who never claims one keeps addressing their profile by
 * short id — and UNIQUE because it is a public namespace. MySQL treats NULLs as
 * distinct inside a unique index, so "optional AND unique" needs no partial
 * index and no shadow column; `members.discord_identity_id` and
 * `regiments.discord_server_id` already rely on exactly that property.
 *
 * `username_reservations` is the part a UNIQUE index cannot express: a handle
 * that is NOT held by any member yet must still not be claimable. Two cases,
 * one table, distinguished by `reason`:
 *   - `cooldown`  — the previous holder renamed. `held_until` is 30 days out;
 *                   after that the row is dead weight and the claim succeeds.
 *   - `blocked`   — the holder deleted their account. `held_until` is NULL,
 *                   i.e. forever, so a stranger cannot take over the handle a
 *                   departed member is still addressed by in Discord history
 *                   and old audit rows.
 * Reserved *words* (`admin`, `api`, `roster`, …) are code-owned and live in
 * `src/common/ids/username.ts`, not here — they are a property of the routing
 * table, and a deploy must be able to add one without a migration.
 *
 * ── COLLATION IS LOAD-BEARING AND IS DELIBERATELY NOT OVERRIDDEN ────────────
 * Every string column in this schema is `utf8mb4_unicode_ci` (pinned at the
 * server, the database and the connection). That collation is case-insensitive
 * AND accent-insensitive AND PAD SPACE, so `UQ_members_username` refuses
 * `Panda` when `panda` exists, refuses `pánda` too, and cannot be defeated with
 * a trailing space — without a lower-cased shadow column, a generated column or
 * a functional index. That is the anti-impersonation property we want, so no
 * per-column COLLATE clause is emitted here. The application additionally
 * normalises to lowercase before writing, so the stored form is canonical.
 *
 * Additive only. Nothing here rewrites an existing row — every member gets
 * `username = NULL` and claims one when they choose to — and `down()` is a true
 * inverse: it drops an index, two columns and a table that did not exist before
 * this migration. Production has been live since 2026-07-20.
 */
export class PublicProfilesAndUsernames1784900005000 implements MigrationInterface {
  name = 'PublicProfilesAndUsernames1784900005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `members` ADD `username` varchar(32) NULL AFTER `in_game_name`',
    );
    // The rename cooldown is enforced against this, not against `updated_at` —
    // every self-edit touches `updated_at`, so it cannot tell a handle change
    // from an avatar upload.
    await queryRunner.query(
      'ALTER TABLE `members` ADD `username_changed_at` datetime(6) NULL AFTER `username`',
    );
    await queryRunner.query('CREATE UNIQUE INDEX `UQ_members_username` ON `members` (`username`)');

    await queryRunner.query(
      'CREATE TABLE `username_reservations` (' +
        '`username` varchar(32) NOT NULL, ' +
        "`reason` enum('cooldown','blocked') NOT NULL, " +
        '`former_member_id` char(12) NULL, ' +
        '`held_until` datetime(6) NULL, ' +
        '`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ' +
        'PRIMARY KEY (`username`)' +
        ') ENGINE=InnoDB',
    );
    // Deliberately NO foreign key on `former_member_id`. The row outlives the
    // member on purpose: the whole point of a `blocked` reservation is that it
    // survives a hard delete of the person it refers to.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `username_reservations`');
    await queryRunner.query('DROP INDEX `UQ_members_username` ON `members`');
    await queryRunner.query('ALTER TABLE `members` DROP COLUMN `username_changed_at`');
    await queryRunner.query('ALTER TABLE `members` DROP COLUMN `username`');
  }
}
