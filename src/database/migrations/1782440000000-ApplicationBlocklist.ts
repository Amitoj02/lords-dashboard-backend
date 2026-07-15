import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Applicant blocklist (T-0055): an officer can permanently bar a Discord
 * identity from submitting further applications (re-enable clears it). Modelled
 * as columns on `discord_identities` — mirroring how member moderation
 * (banned_at / suspended_until) already lives on the member row — rather than a
 * separate table, since the app is single-regiment. All steps are guarded on
 * information_schema so `db:setup` stays idempotent.
 */
export class ApplicationBlocklist1782440000000 implements MigrationInterface {
  name = 'ApplicationBlocklist1782440000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'discord_identities', 'applications_blocked_at'))) {
      await queryRunner.query(
        `ALTER TABLE \`discord_identities\` ADD \`applications_blocked_at\` datetime(6) NULL`,
      );
    }
    if (
      !(await this.columnExists(
        queryRunner,
        'discord_identities',
        'applications_blocked_by_member_id',
      ))
    ) {
      await queryRunner.query(
        `ALTER TABLE \`discord_identities\` ADD \`applications_blocked_by_member_id\` char(12) NULL`,
      );
    }
    if (
      !(await this.columnExists(queryRunner, 'discord_identities', 'applications_blocked_reason'))
    ) {
      await queryRunner.query(
        `ALTER TABLE \`discord_identities\` ADD \`applications_blocked_reason\` varchar(255) NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.columnExists(queryRunner, 'discord_identities', 'applications_blocked_reason')) {
      await queryRunner.query(
        `ALTER TABLE \`discord_identities\` DROP COLUMN \`applications_blocked_reason\``,
      );
    }
    if (
      await this.columnExists(
        queryRunner,
        'discord_identities',
        'applications_blocked_by_member_id',
      )
    ) {
      await queryRunner.query(
        `ALTER TABLE \`discord_identities\` DROP COLUMN \`applications_blocked_by_member_id\``,
      );
    }
    if (await this.columnExists(queryRunner, 'discord_identities', 'applications_blocked_at')) {
      await queryRunner.query(
        `ALTER TABLE \`discord_identities\` DROP COLUMN \`applications_blocked_at\``,
      );
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
}
