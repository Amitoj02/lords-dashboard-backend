import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Regiment } from './regiment.entity';

/** 1—1 configuration for a regiment (PK = FK). */
@Entity('regiment_settings')
export class RegimentSettings {
  @PrimaryColumn({ type: 'char', length: 12 })
  regimentId: string;

  @OneToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ default: true })
  publicGallery: boolean;

  @Column({ default: true })
  publicEvents: boolean;

  @Column({ default: true })
  publicStats: boolean;

  @Column({ default: true })
  openRecruitment: boolean;

  @Column({ default: true })
  showOfficersMessOnLanding: boolean;

  @Column({ default: true })
  allowMercenaries: boolean;

  @Column({ default: false })
  autoApproveTrustedMembers: boolean;

  @Column({ type: 'int', default: 12 })
  galleryMaxImageSizeMb: number;

  @Column({ type: 'int', default: 80 })
  galleryMaxVideoSizeMb: number;

  @Column({ type: 'int', default: 10 })
  galleryMaxItemsPerSubmission: number;

  @Column({ type: 'json', nullable: true })
  galleryAllowedImageTypes: string[] | null;

  @Column({ type: 'json', nullable: true })
  galleryAllowedVideoTypes: string[] | null;

  @Column({ type: 'varchar', length: 40, default: 'UTC' })
  eventDefaultTimezone: string;

  @Column({ type: 'varchar', length: 5, nullable: true })
  eventDefaultStartTime: string | null;

  @Column({ type: 'json', nullable: true })
  eventDefaultNotifyBefore: number[] | null;

  @Column({ type: 'int', default: 12 })
  auditRetentionMonths: number;

  // ── Public presentation (T-0146) ──────────────────────────────────────────
  // Every column below is nullable with NO backfill: an unset value means "use
  // the shipped copy", which the SPA renders as its fallback. That keeps the
  // migration a pure ADD COLUMN against the live database and guarantees a
  // never-configured install still renders a complete landing and login page.
  // The long-form legal documents deliberately live in `regiment_documents`
  // instead — this row is joined by every settings read, so it must stay small.

  /** Landing-page hero background; a StorageTarget.RegimentHeroBanner public URL. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  heroBannerUrl: string | null;

  /** Sign-in page background; a StorageTarget.RegimentLoginBanner public URL. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  loginBannerUrl: string | null;

  /** Landing-page charter pull-quote. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  charterQuote: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  charterQuoteAttribution: string | null;

  /** Sign-in page pull-quote. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  loginQuote: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  loginQuoteAttribution: string | null;

  /**
   * Darkening scrim over each background image, 0-100 (percent). Null means the
   * stylesheet's shipped default. Stored unsigned so the database itself rejects
   * a negative value; the 0-100 ceiling is enforced by the DTO validator.
   */
  @Column({ type: 'tinyint', unsigned: true, nullable: true })
  heroOverlayDensity: number | null;

  @Column({ type: 'tinyint', unsigned: true, nullable: true })
  loginOverlayDensity: number | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
