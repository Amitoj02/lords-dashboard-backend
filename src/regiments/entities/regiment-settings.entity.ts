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
  @PrimaryColumn({ type: 'char', length: 36 })
  regimentId: string;

  @OneToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ default: true })
  publicRoster: boolean;

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

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
