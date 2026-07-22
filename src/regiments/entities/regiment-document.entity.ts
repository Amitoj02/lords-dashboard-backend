import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { RegimentDocumentSlug } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { Regiment } from './regiment.entity';

/**
 * An admin-authored legal document published on the public site (T-0149):
 * terms of service, privacy policy, community guidelines.
 *
 * Deliberately its own table rather than three columns on `regiment_settings`:
 * those are long TEXT bodies, and `regiment_settings` is the single row every
 * settings read joins. It also lets each document carry its own "who changed
 * this, and when" attribution, which a shared row could not.
 *
 * A missing row is meaningful and normal — it means "never edited", and the SPA
 * renders its shipped fallback copy. Production is live and legally required to
 * serve a privacy policy, so an absent or empty document must never render a
 * blank page.
 *
 * `body` is **Markdown**, not HTML. It is rendered client-side through a
 * strict, escape-first renderer, so an admin account cannot inject executable
 * markup into an unauthenticated page.
 */
@Entity('regiment_documents')
export class RegimentDocument {
  @PrimaryColumn({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  slug: RegimentDocumentSlug;

  /** Markdown source. NULL/empty is treated as "unset" — the SPA falls back. */
  @Column({ type: 'mediumtext', nullable: true })
  body: string | null;

  /**
   * The staffer who last saved this document. SET NULL rather than CASCADE: a
   * departed author must not take the regiment's privacy policy with them.
   */
  @Column({ type: 'char', length: 12, nullable: true })
  updatedByMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by_member_id' })
  updatedByMember?: Member | null;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
