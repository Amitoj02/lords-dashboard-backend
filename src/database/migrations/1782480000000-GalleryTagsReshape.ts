import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T-0087 — reshape the gallery schema for the tags model:
 *   - drop the gallery→event association (`gallery_items.event_id` + its FK),
 *   - drop the gallery member-tag junction (`gallery_tagged_members`),
 *   - add a free-form tag store `gallery_tags` (mirrors `event_tags`).
 *
 * Clean rebuild is acceptable (no production data). Every step is guarded on
 * information_schema so `db:setup` stays idempotent end to end.
 */
export class GalleryTagsReshape1782480000000 implements MigrationInterface {
  name = 'GalleryTagsReshape1782480000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop the gallery→event link.
    if (await this.fkExists(queryRunner, 'gallery_items', 'FK_ec38fd08b3f1bde8837007116c1')) {
      await queryRunner.query(
        `ALTER TABLE \`gallery_items\` DROP FOREIGN KEY \`FK_ec38fd08b3f1bde8837007116c1\``,
      );
    }
    if (await this.columnExists(queryRunner, 'gallery_items', 'event_id')) {
      await queryRunner.query(`ALTER TABLE \`gallery_items\` DROP COLUMN \`event_id\``);
    }

    // 2. Drop the member-tag junction (FKs + index first).
    if (
      await this.fkExists(queryRunner, 'gallery_tagged_members', 'FK_d47e98c3f94f6471564389b8dbc')
    ) {
      await queryRunner.query(
        `ALTER TABLE \`gallery_tagged_members\` DROP FOREIGN KEY \`FK_d47e98c3f94f6471564389b8dbc\``,
      );
    }
    if (
      await this.fkExists(queryRunner, 'gallery_tagged_members', 'FK_3f343805c2130e43853509b0fd7')
    ) {
      await queryRunner.query(
        `ALTER TABLE \`gallery_tagged_members\` DROP FOREIGN KEY \`FK_3f343805c2130e43853509b0fd7\``,
      );
    }
    if (await this.tableExists(queryRunner, 'gallery_tagged_members')) {
      await queryRunner.query(`DROP TABLE \`gallery_tagged_members\``);
    }

    // 3. Create the tag store.
    if (!(await this.tableExists(queryRunner, 'gallery_tags'))) {
      await queryRunner.query(
        `CREATE TABLE \`gallery_tags\` (` +
          `\`gallery_item_id\` char(12) NOT NULL, ` +
          `\`tag\` varchar(40) NOT NULL, ` +
          `PRIMARY KEY (\`gallery_item_id\`, \`tag\`)` +
          `) ENGINE=InnoDB`,
      );
      await queryRunner.query(
        `ALTER TABLE \`gallery_tags\` ADD CONSTRAINT \`FK_gallery_tags_item\` ` +
          `FOREIGN KEY (\`gallery_item_id\`) REFERENCES \`gallery_items\`(\`id\`) ` +
          `ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.tableExists(queryRunner, 'gallery_tags')) {
      await queryRunner.query(`DROP TABLE \`gallery_tags\``);
    }

    if (!(await this.tableExists(queryRunner, 'gallery_tagged_members'))) {
      await queryRunner.query(
        `CREATE TABLE \`gallery_tagged_members\` (` +
          `\`gallery_item_id\` char(12) NOT NULL, ` +
          `\`member_id\` char(12) NOT NULL, ` +
          `INDEX \`IDX_d47e98c3f94f6471564389b8db\` (\`member_id\`), ` +
          `PRIMARY KEY (\`gallery_item_id\`, \`member_id\`)` +
          `) ENGINE=InnoDB`,
      );
      await queryRunner.query(
        `ALTER TABLE \`gallery_tagged_members\` ADD CONSTRAINT \`FK_3f343805c2130e43853509b0fd7\` ` +
          `FOREIGN KEY (\`gallery_item_id\`) REFERENCES \`gallery_items\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
      await queryRunner.query(
        `ALTER TABLE \`gallery_tagged_members\` ADD CONSTRAINT \`FK_d47e98c3f94f6471564389b8dbc\` ` +
          `FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
    }

    if (!(await this.columnExists(queryRunner, 'gallery_items', 'event_id'))) {
      await queryRunner.query(`ALTER TABLE \`gallery_items\` ADD \`event_id\` char(12) NULL`);
      await queryRunner.query(
        `ALTER TABLE \`gallery_items\` ADD CONSTRAINT \`FK_ec38fd08b3f1bde8837007116c1\` ` +
          `FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
      );
    }
  }

  private async columnExists(qr: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows = (await qr.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns ` +
        `WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    )) as Array<{ c: number | string }>;
    return Number(rows[0]?.c ?? 0) > 0;
  }

  private async tableExists(qr: QueryRunner, table: string): Promise<boolean> {
    const rows = (await qr.query(
      `SELECT COUNT(*) AS c FROM information_schema.tables ` +
        `WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    )) as Array<{ c: number | string }>;
    return Number(rows[0]?.c ?? 0) > 0;
  }

  private async fkExists(qr: QueryRunner, table: string, constraint: string): Promise<boolean> {
    const rows = (await qr.query(
      `SELECT COUNT(*) AS c FROM information_schema.table_constraints ` +
        `WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ? ` +
        `AND constraint_type = 'FOREIGN KEY'`,
      [table, constraint],
    )) as Array<{ c: number | string }>;
    return Number(rows[0]?.c ?? 0) > 0;
  }
}
