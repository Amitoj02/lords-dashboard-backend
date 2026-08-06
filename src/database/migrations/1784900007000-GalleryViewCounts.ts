import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gallery view counts (T-0302).
 *
 * ── ONE ROW PER DISTINCT VIEWER, NOT A COUNTER COLUMN ───────────────────────
 * `gallery_items.views_count` would have been one integer and one `UPDATE … +1`
 * — and it could not answer the only question that matters here: has THIS
 * visitor already been counted? A counter has no memory, so it counts refreshes.
 * Storing the viewers and deriving the count keeps the schema honest with
 * SCHEMA.md §1.4 ("derived values are never trusted from the client"), exactly
 * as `gallery_likes` already backs the likes count.
 *
 * ── THE VIEWER COLUMN HOLDS A KEYED HASH, NOT AN ADDRESS ────────────────────
 * `viewer_hash` is `HMAC-SHA256(serverSecret, gallery_item_id + '\n' + address)`
 * rendered as 64 hex characters. The secret lives only in the environment, so
 * the stored value cannot be turned back into an IP by anyone holding this
 * database — including whoever operates it. A bare SHA-256 would NOT have that
 * property: IPv4 is 2^32 candidates, which is an afternoon's brute force.
 *
 * The item id inside the message is load-bearing rather than decorative: it
 * makes one visitor's hash on dispatch A unrelated to their hash on dispatch B,
 * so no query — and no dump of this table — can reconstruct what any one person
 * looked at. The privacy rule the product asked for ("nobody can see who
 * viewed") is therefore a property of the schema, not of the API surface.
 *
 * `char(64)` under this schema's `utf8mb4_unicode_ci` is 64 characters of a
 * fixed-width hex alphabet; the composite PK below is 76 bytes, comfortably
 * inside InnoDB's 3072-byte index limit.
 *
 * ── THE PRIMARY KEY IS THE DEDUPE ───────────────────────────────────────────
 * `PRIMARY KEY (gallery_item_id, viewer_hash)` is what enforces "no address's
 * view is counted twice". The service inserts with `INSERT IGNORE` semantics and
 * lets the constraint decide — a read-then-write check would race two concurrent
 * requests from the same visitor into two rows.
 *
 * ── NO INDEX ON `viewer_hash` ───────────────────────────────────────────────
 * A deliberate departure from SCHEMA.md's "index the trailing column of a
 * junction" convention. That index exists to make reverse lookups fast; here the
 * reverse lookup is "everything this viewer has seen", which must stay both
 * meaningless (per-item salt) and slow. Counting is `GROUP BY gallery_item_id`,
 * served by the PK's leading column.
 *
 * Additive only: a new table, nothing rewritten, every existing item starts at
 * zero views. `down()` is a true inverse — DROP TABLE takes the FK and the PK
 * with it.
 */
export class GalleryViewCounts1784900007000 implements MigrationInterface {
  name = 'GalleryViewCounts1784900007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `gallery_views` (' +
        '`gallery_item_id` char(12) NOT NULL, ' +
        '`viewer_hash` char(64) NOT NULL, ' +
        '`viewed_at` datetime(6) NOT NULL, ' +
        'PRIMARY KEY (`gallery_item_id`, `viewer_hash`)' +
        ') ENGINE=InnoDB',
    );

    await queryRunner.query(
      'ALTER TABLE `gallery_views` ADD CONSTRAINT `FK_gallery_views_item` ' +
        'FOREIGN KEY (`gallery_item_id`) REFERENCES `gallery_items`(`id`) ' +
        'ON DELETE CASCADE ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `gallery_views` DROP FOREIGN KEY `FK_gallery_views_item`');
    await queryRunner.query('DROP TABLE `gallery_views`');
  }
}
