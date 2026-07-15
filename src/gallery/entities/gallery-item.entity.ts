import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { GalleryStatus, GalleryType } from '../../common/enums';
import { Member } from '../../members/entities/member.entity';
import { Regiment } from '../../regiments/entities/regiment.entity';

/** A gallery submission (image/video/link) that passes through moderation. */
@Entity('gallery_items')
@Index(['regimentId', 'status'])
export class GalleryItem extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Index()
  @Column({ type: 'char', length: 12 })
  authorMemberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'author_member_id' })
  author?: Member;

  @Column({ type: 'char', length: 12, nullable: true })
  moderatedByMemberId: string | null;

  @ManyToOne(() => Member, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'moderated_by_member_id' })
  moderatedBy?: Member | null;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  caption: string | null;

  @Column({ type: 'enum', enum: GalleryType })
  type: GalleryType;

  @Column({ type: 'varchar', length: 512, nullable: true })
  linkUrl: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnailUrl: string | null;

  @Column({ type: 'enum', enum: GalleryStatus, default: GalleryStatus.Pending })
  status: GalleryStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  declineReason: string | null;

  @Column({ default: false })
  isDraft: boolean;

  @Column({ type: 'datetime', precision: 6 })
  submittedAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  approvedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'datetime', precision: 6, nullable: true })
  deletedAt: Date | null;
}
