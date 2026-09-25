import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The welcome on/off switch (T-0305).
 *
 * Until now there was no way to stop the bot greeting people short of turning
 * the whole bot off: clearing the welcome channel only moved the greeting into a
 * DM, and clearing the message only swapped in the house default.
 *
 * `discord_bot_settings.welcome_enabled` is NOT NULL DEFAULT 1, so every
 * existing regiment keeps greeting new arrivals exactly as it did the moment
 * before this landed. That default is deliberate, and it is the opposite of the
 * sensitive switches on this table (`bot_enabled`, `apply_ban_role_on_ban`,
 * `guild_gate_enabled` all ship at 0): those guard behaviour that did not exist
 * before their column did, while this one guards behaviour production already
 * has — so the safe value is the one that changes nothing. It is still inert
 * until `bot_enabled` is on. Same tinyint convention as the other booleans here.
 *
 * Additive and reversible: `down()` drops the column, which puts back the
 * always-greet behaviour the previous release has anyway.
 */
export class WelcomeSwitch1784900008000 implements MigrationInterface {
  name = 'WelcomeSwitch1784900008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `discord_bot_settings` ADD `welcome_enabled` tinyint NOT NULL DEFAULT 1',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `discord_bot_settings` DROP COLUMN `welcome_enabled`');
  }
}
