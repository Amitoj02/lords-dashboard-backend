import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T-0092 — align already-seeded regiments' `role_permissions` with the reconciled
 * gallery capability defaults (T-0091):
 *   - `view_gallery` (NEW capability): granted to all enrolled roles
 *     (Owner/Admin/Moderator/Member/Mercenary), denied to Applicant.
 *   - `submit_to_gallery`: revoked from Mercenary (members-only going forward).
 *
 * Pure data migration (the `capability` column is an open varchar, so no DDL).
 * Idempotent: the view_gallery insert is guarded by NOT EXISTS on the natural
 * key, and the Mercenary revoke is a set-based UPDATE. Runs for EVERY regiment
 * present in role_permissions, not just the seeded dev regiment.
 *
 * Ids are minted as 12 hex chars (LEFT of a UUID) so the row fits the short-id
 * `char(12)` primary key regardless of whether the id column has been converted
 * yet — role_permissions ids never appear in URLs, so only the length matters.
 */
export class GalleryCapabilityDefaults1782490000000 implements MigrationInterface {
  name = 'GalleryCapabilityDefaults1782490000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Insert a view_gallery row for every (regiment, role) pair that lacks one.
    await queryRunner.query(
      `INSERT INTO \`role_permissions\` (\`id\`, \`regiment_id\`, \`role\`, \`capability\`, \`granted\`)
       SELECT LEFT(REPLACE(UUID(), '-', ''), 12), rp.regiment_id, rp.role, 'view_gallery',
         CASE WHEN rp.role IN ('Owner', 'Admin', 'Moderator', 'Member', 'Mercenary') THEN 1 ELSE 0 END
       FROM (SELECT DISTINCT regiment_id, role FROM \`role_permissions\`) rp
       WHERE NOT EXISTS (
         SELECT 1 FROM \`role_permissions\` x
         WHERE x.regiment_id = rp.regiment_id AND x.role = rp.role AND x.capability = 'view_gallery'
       )`,
    );

    // 2. Revoke gallery submission from Mercenary everywhere.
    await queryRunner.query(
      `UPDATE \`role_permissions\` SET \`granted\` = 0
       WHERE \`role\` = 'Mercenary' AND \`capability\` = 'submit_to_gallery'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore Mercenary gallery submission …
    await queryRunner.query(
      `UPDATE \`role_permissions\` SET \`granted\` = 1
       WHERE \`role\` = 'Mercenary' AND \`capability\` = 'submit_to_gallery'`,
    );
    // … and drop the view_gallery rows this migration introduced.
    await queryRunner.query(
      `DELETE FROM \`role_permissions\` WHERE \`capability\` = 'view_gallery'`,
    );
  }
}
