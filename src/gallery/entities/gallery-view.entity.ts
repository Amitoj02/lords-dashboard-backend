import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { GalleryItem } from './gallery-item.entity';

/**
 * One distinct viewer of one gallery item — the source for the views count.
 *
 * ── WHAT IS STORED IS NOT AN IP, AND CANNOT BE TURNED BACK INTO ONE ─────────
 * `viewer_hash` is `HMAC-SHA256(serverSecret, itemId + '\n' + address)`, hex.
 * Three properties follow, and all three are the point:
 *
 *  1. NOBODY OPERATING THIS SYSTEM CAN READ THE ADDRESS. The input space is
 *     small enough to brute-force (2^32 IPv4 addresses), so a plain hash would
 *     be reversible with a laptop and an afternoon. The HMAC key is what makes
 *     it not: without the server secret there is no candidate to test, and with
 *     it you would still have to attack each item separately.
 *  2. THE SAME VISITOR IS STILL RECOGNISABLE ON THE SAME ITEM, which is exactly
 *     as much as a view counter needs. The hash is deterministic, so a second
 *     visit collides with the first and the composite primary key below refuses
 *     it. That is the "counted once" guarantee, enforced by the database rather
 *     than by a query the application has to remember to run.
 *  3. THE SAME VISITOR IS *NOT* RECOGNISABLE ACROSS ITEMS. The item id is
 *     inside the HMAC message, so one visitor's hashes on two dispatches are
 *     unrelated values. There is no way — for staff, for an attacker with the
 *     database, for anyone — to assemble "everything this person looked at".
 *     A per-item salt costs nothing and removes the entire correlation surface.
 *
 * ── NO REVERSE INDEX, DELIBERATELY ──────────────────────────────────────────
 * SCHEMA.md's convention gives the trailing column of a composite-PK junction
 * its own index so reverse lookups stay fast ("my likes", "my RSVPs"). This
 * table breaks that convention ON PURPOSE: "everything this hash viewed" is the
 * one query that must never be cheap, and per-item salting already makes it
 * meaningless. Views are only ever read as `COUNT(*) … GROUP BY item`, which
 * the primary key's leading column serves.
 *
 * ── NO MEMBER COLUMN ────────────────────────────────────────────────────────
 * A signed-in member's view is recorded exactly like anyone else's — by address
 * alone. Joining the member id on would make the row identify a person, which is
 * the thing the product decision ("nobody can see who viewed") forbids.
 */
@Entity('gallery_views')
export class GalleryView {
  @PrimaryColumn({ type: 'char', length: 12 })
  galleryItemId: string;

  @ManyToOne(() => GalleryItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gallery_item_id' })
  galleryItem?: GalleryItem;

  /** Hex HMAC-SHA256 — 64 characters. See the class comment for the construction. */
  @PrimaryColumn({ type: 'char', length: 64 })
  viewerHash: string;

  /**
   * When this viewer was first seen on this item. Never updated on a repeat
   * visit: the row is the fact "this viewer has been counted", and refreshing
   * the timestamp would turn it into a last-seen record of one person's reading
   * habits — a thing this table exists specifically not to hold.
   */
  @Column({ type: 'datetime', precision: 6 })
  viewedAt: Date;
}
