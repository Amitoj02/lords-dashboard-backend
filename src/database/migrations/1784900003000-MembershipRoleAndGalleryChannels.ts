import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Membership role (T-0191) and the two gallery channels (T-0195).
 *
 * ── THE RENAME IS THE POINT, NOT A TIDY-UP ───────────────────────────────────
 * `join_role_id` was assigned by the guild-join handler to EVERY account that
 * walked into the guild, which made it useless as the thing the guild hangs its
 * permissions off: a visitor who had never applied held exactly the role an
 * enlisted member held. The column now carries the regiment's single "Member"
 * role and is granted from ROSTER STATE by the role reconcile instead.
 *
 * It is a RENAME rather than a new column + a drop, on purpose. The live row's
 * value is already the snowflake the regiment wants as its Membership role (the
 * admin had pointed Join Role at their `Member` role), so renaming carries the
 * configuration across intact. A new column would have shipped NULL, silently
 * granting nobody anything until an admin noticed, and would have left the old
 * column behind as a second, stale source of truth.
 *
 * `join_role_name` is a CACHED DISPLAY NAME of whichever role was picked, so it
 * is carried across untouched — except where no role is picked at all, in which
 * case it still holds the meaningless literal default `'Guest'` and is reset to
 * the new default. That `WHERE` clause is what keeps this from overwriting a
 * real Discord role name.
 *
 * ── THE CHANNELS ────────────────────────────────────────────────────────────
 * Four nullable columns, matching the existing per-purpose channel convention
 * (`enlistment_*`, `audit_log_*`, `event_announcement_*`): an id plus a cached
 * name, no seeded default, and the producer no-ops until an admin sets one.
 *
 * Additive and reversible. Production has been live since 2026-07-20; nothing
 * here rewrites a row's data except the one guarded `'Guest'` → `'Member'`
 * default reset, and `down()` restores both the names and the columns.
 */
export class MembershipRoleAndGalleryChannels1784900003000 implements MigrationInterface {
  name = 'MembershipRoleAndGalleryChannels1784900003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ' +
        'CHANGE `join_role_id` `membership_role_id` varchar(20) NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ' +
        "CHANGE `join_role_name` `membership_role_name` varchar(120) NOT NULL DEFAULT 'Member'",
    );
    // Only the untouched placeholder is reset. A regiment that picked a role has
    // the REAL role's name cached here and must keep it.
    await queryRunner.query(
      'UPDATE `discord_bot_settings` SET `membership_role_name` = ? ' +
        'WHERE `membership_role_id` IS NULL AND `membership_role_name` = ?',
      ['Member', 'Guest'],
    );

    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ADD `gallery_submission_channel_id` varchar(20) NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ADD `gallery_submission_channel_name` varchar(120) NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ADD `gallery_approved_channel_id` varchar(20) NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ADD `gallery_approved_channel_name` varchar(120) NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` DROP COLUMN `gallery_approved_channel_name`',
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` DROP COLUMN `gallery_approved_channel_id`',
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` DROP COLUMN `gallery_submission_channel_name`',
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` DROP COLUMN `gallery_submission_channel_id`',
    );

    await queryRunner.query(
      'UPDATE `discord_bot_settings` SET `membership_role_name` = ? ' +
        'WHERE `membership_role_id` IS NULL AND `membership_role_name` = ?',
      ['Guest', 'Member'],
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ' +
        "CHANGE `membership_role_name` `join_role_name` varchar(120) NOT NULL DEFAULT 'Guest'",
    );
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ' +
        'CHANGE `membership_role_id` `join_role_id` varchar(20) NULL',
    );
  }
}
