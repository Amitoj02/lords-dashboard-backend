import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the Discord bot's persistence: a 1—1 `discord_bot_settings` row per
 * regiment (behaviour switches, channels, join role — all defaulting to the safe
 * position) and the `discord_sync_jobs` transactional outbox the worker drains.
 * FK columns are char(12) to match the uuid `regiments.id` PK.
 */
export class DiscordBotOutbox1782350000000 implements MigrationInterface {
  name = 'DiscordBotOutbox1782350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`discord_bot_settings\` (` +
        `\`regiment_id\` char(12) NOT NULL, ` +
        `\`bot_enabled\` tinyint NOT NULL DEFAULT 0, ` +
        `\`announcement_channel_id\` varchar(20) NULL, ` +
        `\`welcome_channel_id\` varchar(20) NULL, ` +
        `\`welcome_message\` varchar(512) NULL, ` +
        `\`join_role_id\` varchar(20) NULL, ` +
        `\`join_role_name\` varchar(120) NOT NULL DEFAULT 'Guest', ` +
        `\`sync_roles_on_change\` tinyint NOT NULL DEFAULT 1, ` +
        `\`kick_on_ban\` tinyint NOT NULL DEFAULT 0, ` +
        `\`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ` +
        `\`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), ` +
        `PRIMARY KEY (\`regiment_id\`)` +
        `) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`discord_sync_jobs\` (` +
        `\`id\` varchar(36) NOT NULL, ` +
        `\`regiment_id\` char(12) NOT NULL, ` +
        `\`job_type\` varchar(40) NOT NULL, ` +
        `\`status\` enum ('pending', 'processing', 'succeeded', 'failed') NOT NULL DEFAULT 'pending', ` +
        `\`payload\` json NULL, ` +
        `\`attempts\` int NOT NULL DEFAULT 0, ` +
        `\`max_attempts\` int NOT NULL DEFAULT 5, ` +
        `\`last_error\` varchar(512) NULL, ` +
        `\`scheduled_at\` datetime(6) NOT NULL, ` +
        `\`processed_at\` datetime(6) NULL, ` +
        `\`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ` +
        `INDEX \`IDX_discord_sync_jobs_regiment\` (\`regiment_id\`), ` +
        `INDEX \`IDX_discord_sync_jobs_status_sched\` (\`status\`, \`scheduled_at\`), ` +
        `PRIMARY KEY (\`id\`)` +
        `) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`discord_bot_settings\` ADD CONSTRAINT \`FK_discord_bot_settings_regiment\` ` +
        `FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`discord_sync_jobs\` ADD CONSTRAINT \`FK_discord_sync_jobs_regiment\` ` +
        `FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`discord_sync_jobs\` DROP FOREIGN KEY \`FK_discord_sync_jobs_regiment\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`discord_bot_settings\` DROP FOREIGN KEY \`FK_discord_bot_settings_regiment\``,
    );
    await queryRunner.query(`DROP TABLE \`discord_sync_jobs\``);
    await queryRunner.query(`DROP TABLE \`discord_bot_settings\``);
  }
}
