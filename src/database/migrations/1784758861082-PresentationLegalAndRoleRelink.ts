import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Public presentation (T-0146), editable legal documents (T-0149) and the bulk
 * Discord role re-link outbox (T-0158/T-0160).
 *
 * Deliberately ADDITIVE ONLY. Production has been live since 2026-07-20, so
 * this migration:
 *  - adds only nullable columns (no DEFAULT backfill, no table rewrite of an
 *    existing row's data),
 *  - creates one new table,
 *  - widens an existing ENUM (MySQL treats appending a member as metadata-only),
 *  - adds one index.
 *
 * Nothing here rewrites an existing row, so it is safe to run against the live
 * database and `down()` is a true inverse. In particular, the event-timezone fix
 * (T-0156) and the demotion labelling fix (T-0157) are FORWARD-ONLY by decision:
 * they deliberately ship no data backfill, because shifting stored event
 * instants could collide with UQ_event_occurrence(recurrence_template_id,
 * starts_at) on regenerated occurrences.
 */
export class PresentationLegalAndRoleRelink1784758861082 implements MigrationInterface {
  name = 'PresentationLegalAndRoleRelink1784758861082';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`regiment_documents\` (\`regiment_id\` char(12) NOT NULL, \`slug\` varchar(32) NOT NULL, \`body\` mediumtext NULL, \`updated_by_member_id\` char(12) NULL, \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), PRIMARY KEY (\`regiment_id\`, \`slug\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD \`hero_banner_url\` varchar(512) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD \`login_banner_url\` varchar(512) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD \`charter_quote\` varchar(500) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD \`charter_quote_attribution\` varchar(120) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD \`login_quote\` varchar(500) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD \`login_quote_attribution\` varchar(120) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD \`hero_overlay_density\` tinyint UNSIGNED NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD \`login_overlay_density\` tinyint UNSIGNED NULL`,
    );
    await queryRunner.query(`ALTER TABLE \`discord_sync_jobs\` ADD \`batch_id\` char(36) NULL`);
    await queryRunner.query(
      `DROP INDEX \`IDX_ca927a405b1f7582b02238a4f8\` ON \`discord_sync_jobs\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`discord_sync_jobs\` CHANGE \`status\` \`status\` enum ('pending', 'processing', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX \`IDX_42a24904fd3b6410334b9e5896\` ON \`discord_sync_jobs\` (\`regiment_id\`, \`batch_id\`, \`status\`)`,
    );
    await queryRunner.query(
      `CREATE INDEX \`IDX_ca927a405b1f7582b02238a4f8\` ON \`discord_sync_jobs\` (\`status\`, \`scheduled_at\`)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_documents\` ADD CONSTRAINT \`FK_8502e72f7e91b4a4a7bd2335305\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_documents\` ADD CONSTRAINT \`FK_b146881193b08d4fcbffe2c8556\` FOREIGN KEY (\`updated_by_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Narrowing the status ENUM would fail on any row already in 'cancelled',
    // so retire those to 'failed' first — a cancelled job is terminal either
    // way, and this keeps the down migration runnable rather than theoretical.
    await queryRunner.query(
      `UPDATE \`discord_sync_jobs\` SET \`status\` = 'failed' WHERE \`status\` = 'cancelled'`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_documents\` DROP FOREIGN KEY \`FK_b146881193b08d4fcbffe2c8556\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_documents\` DROP FOREIGN KEY \`FK_8502e72f7e91b4a4a7bd2335305\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_ca927a405b1f7582b02238a4f8\` ON \`discord_sync_jobs\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_42a24904fd3b6410334b9e5896\` ON \`discord_sync_jobs\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`discord_sync_jobs\` CHANGE \`status\` \`status\` enum ('pending', 'processing', 'succeeded', 'failed') NOT NULL DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX \`IDX_ca927a405b1f7582b02238a4f8\` ON \`discord_sync_jobs\` (\`status\`, \`scheduled_at\`)`,
    );
    await queryRunner.query(`ALTER TABLE \`discord_sync_jobs\` DROP COLUMN \`batch_id\``);
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` DROP COLUMN \`login_overlay_density\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` DROP COLUMN \`hero_overlay_density\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` DROP COLUMN \`login_quote_attribution\``,
    );
    await queryRunner.query(`ALTER TABLE \`regiment_settings\` DROP COLUMN \`login_quote\``);
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` DROP COLUMN \`charter_quote_attribution\``,
    );
    await queryRunner.query(`ALTER TABLE \`regiment_settings\` DROP COLUMN \`charter_quote\``);
    await queryRunner.query(`ALTER TABLE \`regiment_settings\` DROP COLUMN \`login_banner_url\``);
    await queryRunner.query(`ALTER TABLE \`regiment_settings\` DROP COLUMN \`hero_banner_url\``);
    await queryRunner.query(`DROP TABLE \`regiment_documents\``);
  }
}
