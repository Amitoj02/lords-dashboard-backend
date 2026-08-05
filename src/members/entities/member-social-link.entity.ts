import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { SOCIAL_HANDLE_MAX_LENGTH } from '../social-platforms';
import { Member } from './member.entity';

/**
 * One social account a member has published on their profile (T-0216).
 *
 * ── WHAT IS STORED IS A HANDLE, NEVER A URL ─────────────────────────────────
 * `handle` is the account name on the network, not a link. The URL is composed
 * server-side by `socialProfileUrl()` from a hardcoded origin, so a member can
 * never cause an arbitrary outbound link to appear on their crawlable public
 * profile. See `src/members/social-platforms.ts` for the full argument — this
 * column shape is what enforces it.
 *
 * ── WHY varchar AND NOT enum FOR `platform` ─────────────────────────────────
 * SCHEMA.md §2 reserves MySQL `ENUM` for closed sets. The set of networks a
 * regiment cares about is open — one will be added the week TikTok stops
 * mattering — and a varchar lets that ship without a migration. The narrowing
 * back to {@link MemberSocialPlatform} happens at the boundary via
 * `isSupportedSocialPlatform()`, which is also what lets a row whose platform
 * has since been retired be dropped from a projection instead of crashing it.
 * The TS type stays `string` for the same reason: an enum type here would be a
 * lie the moment the registry changes under existing rows.
 *
 * ── NO `regiment_id`, NO INVERSE RELATION ───────────────────────────────────
 * A child reached only through a regiment-scoped parent, exactly like
 * `gallery_files`: the member carries the tenancy, so duplicating it here would
 * create a second copy of a fact that can disagree. And as everywhere else in
 * this codebase there is no `@OneToMany` on {@link Member} and no `cascade:` —
 * rows are written explicitly by the service, so the write path is always
 * visible in the code that owns the transaction.
 *
 * UNIQUE (member_id, platform): one account per network per member. Case never
 * matters for that key even though the handle preserves case, because the key is
 * the platform, not the handle.
 */
@Entity('member_social_links')
@Index('UQ_member_social_link', ['memberId', 'platform'], { unique: true })
export class MemberSocialLink extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  memberId: string;

  /**
   * ON DELETE CASCADE at the database, which covers a HARD delete only. Members
   * are SOFT-deleted (`deleted_at`), so the GDPR erasure path in
   * MembersService must hard-delete these rows itself — the constraint will
   * never fire for it.
   */
  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  /** A {@link MemberSocialPlatform} value; open varchar set, see above. */
  @Column({ type: 'varchar', length: 40 })
  platform: string;

  /** Normalised account name (no leading `@`, no trailing `/`), case preserved. */
  @Column({ type: 'varchar', length: SOCIAL_HANDLE_MAX_LENGTH })
  handle: string;

  /** Display order, taken from the registry's canonical ordering. */
  @Column({ type: 'int', default: 0 })
  precedence: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}
