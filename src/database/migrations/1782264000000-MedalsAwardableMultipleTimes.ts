import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner decision (questionnaire Q2): a medal can be awarded to the same member
 * more than once, and the frontend shows how many times each was earned.
 *
 * The initial schema put a UNIQUE index on member_medals(member_id, medal_id),
 * which forbids repeat awards. This migration replaces it with a plain
 * (non-unique) index of the SAME name — so every award becomes its own row while
 * per-member lookups stay fast, and the entity metadata keeps matching the DB
 * (no drift for future migration:generate runs).
 */
export class MedalsAwardableMultipleTimes1782264000000 implements MigrationInterface {
  name = 'MedalsAwardableMultipleTimes1782264000000';

  private readonly indexName = 'IDX_b2d56e7f424f02f8f74187ca03';
  // The composite (member_id, medal_id) index also backs the member_id foreign
  // key, so MySQL refuses to drop it outright. We temporarily add a standalone
  // member_id index to satisfy the FK, swap the composite index, then drop the
  // temp (the recreated composite covers member_id as its leftmost column again).
  private readonly tmpIndex = 'IDX_mm_member_fk_tmp';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX \`${this.tmpIndex}\` ON \`member_medals\` (\`member_id\`)`,
    );
    await queryRunner.query(`DROP INDEX \`${this.indexName}\` ON \`member_medals\``);
    await queryRunner.query(
      `CREATE INDEX \`${this.indexName}\` ON \`member_medals\` (\`member_id\`, \`medal_id\`)`,
    );
    await queryRunner.query(`DROP INDEX \`${this.tmpIndex}\` ON \`member_medals\``);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX \`${this.tmpIndex}\` ON \`member_medals\` (\`member_id\`)`,
    );
    await queryRunner.query(`DROP INDEX \`${this.indexName}\` ON \`member_medals\``);
    await queryRunner.query(
      `CREATE UNIQUE INDEX \`${this.indexName}\` ON \`member_medals\` (\`member_id\`, \`medal_id\`)`,
    );
    await queryRunner.query(`DROP INDEX \`${this.tmpIndex}\` ON \`member_medals\``);
  }
}
