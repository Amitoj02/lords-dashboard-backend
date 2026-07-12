import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * iat-based session invalidation (T-0048). Adds a per-identity
 * `sessions_valid_from` cutoff to `discord_identities`: any JWT whose `iat`
 * predates it is rejected by JwtStrategy, so logout and sensitive events
 * (ban/suspend) can invalidate outstanding tokens without a revocation list.
 * Nullable — a null cutoff means "no tokens invalidated yet" (all pass).
 *
 * The column add is guarded on information_schema so `db:setup` (create ->
 * migrate -> seed) stays idempotent even if the column already exists.
 */
export class AuthSessionInvalidation1782400000000 implements MigrationInterface {
  name = 'AuthSessionInvalidation1782400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await this.columnExists(
      queryRunner,
      'discord_identities',
      'sessions_valid_from',
    );
    if (!exists) {
      await queryRunner.query(
        `ALTER TABLE \`discord_identities\` ADD \`sessions_valid_from\` datetime(6) NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await this.columnExists(
      queryRunner,
      'discord_identities',
      'sessions_valid_from',
    );
    if (exists) {
      await queryRunner.query(
        `ALTER TABLE \`discord_identities\` DROP COLUMN \`sessions_valid_from\``,
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
